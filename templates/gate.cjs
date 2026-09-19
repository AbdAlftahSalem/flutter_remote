// flutter-remote-template-version: 6
/**
 * flutter-remote auth gate.
 *
 * serve-sim ships with no authentication, so exposing port 3200 through a public
 * tunnel would hand simulator control to anyone who guessed the URL. This is a
 * zero-dependency reverse proxy that requires `?k=<token>` once, trades it for
 * an HttpOnly cookie, and forwards everything (including the MJPEG/H.264 stream and
 * the control WebSocket) to serve-sim on localhost.
 *
 * Design goals:
 *   1. Zero buffering on streaming responses (MJPEG / H.264 / AVCC / SSE).
 *      Cloudflare may buffer responses unless we send the right headers.
 *   2. Zero latency on WebSocket HID input (touch/keyboard → simulator).
 *      TCP_NODELAY + raw socket pipe keeps per-frame overhead under 1ms.
 *   3. Survive Cloudflare's 100-second idle timeout on HTTP connections.
 *      serve-sim replays a JPEG every 1s, so the tunnel stays alive as long
 *      as we don't accidentally buffer those keepalive frames.
 *   4. Low-latency WebRTC DataChannel support for direct P2P HID input.
 *      Exposes /ice-config, proxies /signal to webrtc-peer, and injects
 *      webrtc-hid.js into the simulator HTML page.
 *
 * It also multiplexes a second upstream onto the same tunnel: when
 * FLUTTER_REMOTE_AGENT_PORT is set, `/agent-device/*` is routed to the local
 * `agent-device proxy` instead of serve-sim, so one URL carries both the
 * human-facing stream and the agent-facing control API.
 */
const http = require('node:http');
const net = require('node:net');

const TOKEN = process.env.FLUTTER_REMOTE_GATE_TOKEN || '';
const TARGET_PORT = Number(process.env.FLUTTER_REMOTE_TARGET_PORT || 3200);
const AGENT_PORT = Number(process.env.FLUTTER_REMOTE_AGENT_PORT || 0);
const WEBRTC_SIGNAL_PORT = Number(process.env.FLUTTER_REMOTE_WEBRTC_SIGNAL_PORT || 3201);
const AGENT_PREFIX = '/agent-device';
const TARGET_HOST = '127.0.0.1';
const PORT = Number(process.env.FLUTTER_REMOTE_GATE_PORT || 3199);
const COOKIE = 'flutter_remote_k';

if (!TOKEN) {
  console.error('FLUTTER_REMOTE_GATE_TOKEN is required — refusing to proxy an unauthenticated simulator');
  process.exit(1);
}

// Prevent any uncaught socket or network error from crashing the proxy daemon
process.on('uncaughtException', (err) => {
  console.error('[gate uncaughtException]', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[gate unhandledRejection]', reason);
});

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cookieToken(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return null;
}

function bearerToken(req) {
  const match = /^Bearer\s+(.+)$/i.exec((req.headers.authorization || '').trim());
  return match ? match[1] : null;
}

function pathnameOf(req) {
  return new URL(req.url, 'http://localhost').pathname;
}

function isAgentRoute(req) {
  if (!AGENT_PORT) return false;
  const path = pathnameOf(req);
  return path === AGENT_PREFIX || path.startsWith(`${AGENT_PREFIX}/`);
}

function authorize(req) {
  if (timingSafeEqual(cookieToken(req), TOKEN)) return 'cookie';
  if (timingSafeEqual(bearerToken(req), TOKEN)) return 'bearer';
  const url = new URL(req.url, 'http://localhost');
  if (timingSafeEqual(url.searchParams.get('k'), TOKEN)) return 'query';
  return false;
}

/** Detect streaming responses that must never be buffered. */
function isStreamingResponse(upstreamRes) {
  const ct = (upstreamRes.headers['content-type'] || '').toLowerCase();
  return (
    ct.includes('multipart/x-mixed-replace') ||  // MJPEG
    ct.includes('video/') ||                       // H.264 / MP4
    ct.includes('application/octet-stream') ||     // AVCC binary stream
    ct.includes('text/event-stream')               // SSE (logs)
  );
}

let cachedTurnConfig = null;
let turnFetchPromise = null;

/**
 * Fetch Cloudflare Realtime TURN credentials via Cloudflare Calls REST API.
 * Falls back to free public STUN if TURN keys are not configured.
 */
function getTurnConfig() {
  const keyId = process.env.FLUTTER_REMOTE_TURN_KEY_ID;
  const keyToken = process.env.FLUTTER_REMOTE_TURN_KEY_TOKEN;

  const defaultStun = {
    iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }]
  };

  if (!keyId || !keyToken) {
    return Promise.resolve(defaultStun);
  }

  if (cachedTurnConfig && cachedTurnConfig.expiresAt > Date.now()) {
    return Promise.resolve(cachedTurnConfig.data);
  }

  if (turnFetchPromise) {
    return turnFetchPromise;
  }

  turnFetchPromise = new Promise((resolve) => {
    const https = require('node:https');
    const req = https.request(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          turnFetchPromise = null;
          try {
            const parsed = JSON.parse(body);
            if (parsed && Array.isArray(parsed.iceServers)) {
              cachedTurnConfig = {
                data: parsed,
                expiresAt: Date.now() + 12 * 3600 * 1000
              };
              resolve(parsed);
              return;
            }
          } catch {}
          resolve(defaultStun);
        });
      }
    );
    req.on('error', () => {
      turnFetchPromise = null;
      resolve(defaultStun);
    });
    req.on('timeout', () => {
      req.destroy();
      turnFetchPromise = null;
      resolve(defaultStun);
    });
    req.write(JSON.stringify({ ttl: 86400 }));
    req.end();
  });

  return turnFetchPromise;
}

const WEBRTC_CLIENT_SCRIPT = `
(function() {
  if (window.__flutterRemoteWebRTCInjected) return;
  window.__flutterRemoteWebRTCInjected = true;

  // Pin codec to MJPEG in browser localStorage to prevent H.264 idle frame-stalls and black-screen reconnect loops on VMs
  try {
    localStorage.setItem('serve-sim:codec', 'mjpeg');
  } catch (e) {}

  const OrigWebSocket = window.WebSocket;
  let rtcPeer = null;
  let dataChannel = null;
  let rtcReady = false;
  let signalingWs = null;

  async function initWebRTC() {
    try {
      const res = await fetch('/ice-config');
      const iceConfig = await res.json();
      if (!iceConfig || !iceConfig.iceServers || iceConfig.iceServers.length === 0) {
        return;
      }

      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      signalingWs = new OrigWebSocket(proto + '//' + location.host + '/signal');

      signalingWs.onopen = async () => {
        try {
          rtcPeer = new RTCPeerConnection(iceConfig);

          dataChannel = rtcPeer.createDataChannel('hid', { ordered: true });
          dataChannel.binaryType = 'arraybuffer';

          dataChannel.onopen = () => {
            console.log('[flutter-remote] WebRTC DataChannel active (ultra-low latency HID)');
            rtcReady = true;
          };

          dataChannel.onclose = () => {
            rtcReady = false;
          };

          rtcPeer.onicecandidate = (e) => {
            if (e.candidate && signalingWs && signalingWs.readyState === OrigWebSocket.OPEN) {
              signalingWs.send(JSON.stringify({ type: 'candidate', candidate: e.candidate }));
            }
          };

          const offer = await rtcPeer.createOffer();
          await rtcPeer.setLocalDescription(offer);

          signalingWs.send(JSON.stringify({
            type: 'offer',
            sdp: offer.sdp,
            iceServers: iceConfig.iceServers
          }));
        } catch (err) {
          console.warn('[flutter-remote WebRTC init error]', err);
        }
      };

      signalingWs.onmessage = async (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'answer' && rtcPeer) {
            await rtcPeer.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
          } else if (msg.type === 'candidate' && rtcPeer && msg.candidate) {
            await rtcPeer.addIceCandidate(new RTCIceCandidate(msg.candidate));
          }
        } catch (err) {
          console.warn('[flutter-remote WebRTC signaling message error]', err);
        }
      };
    } catch (err) {
      console.warn('[flutter-remote WebRTC error]', err);
    }
  }

  initWebRTC();

  window.WebSocket = function(url, protocols) {
    const isHidWs = typeof url === 'string' && (url.endsWith('/ws') || url.includes('/ws?'));
    const ws = protocols ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);

    if (!isHidWs) {
      return ws;
    }

    const origSend = ws.send.bind(ws);

    ws.send = function(data) {
      if (rtcReady && dataChannel && dataChannel.readyState === 'open') {
        try {
          dataChannel.send(data);
          return;
        } catch (e) {}
      }
      return origSend(data);
    };

    return ws;
  };

  window.WebSocket.prototype = OrigWebSocket.prototype;
  window.WebSocket.CONNECTING = OrigWebSocket.CONNECTING;
  window.WebSocket.OPEN = OrigWebSocket.OPEN;
  window.WebSocket.CLOSING = OrigWebSocket.CLOSING;
  window.WebSocket.CLOSED = OrigWebSocket.CLOSED;
})();
`;

const DENIED = `<!doctype html><meta charset=utf-8><title>Flutter Remote</title>
<style>body{font:14px/1.6 -apple-system,system-ui,sans-serif;margin:15vh auto;max-width:34rem;padding:0 1.5rem;color:#111}
h1{font-size:1.1rem;margin-bottom:.5rem}code{background:#f3f4f6;padding:.15rem .35rem;border-radius:3px;font-size:.9em}
@media(prefers-color-scheme:dark){body{background:#0a0a0c;color:#eee}code{background:#1f2023}}</style>
<h1>Flutter Remote Session Locked</h1>
<p>This stream is secured by a gate token. Use the full URL provided by <code>flutter-remote up</code>.</p>`;

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/__flutter-remote/healthz')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, target: TARGET_PORT, agent: AGENT_PORT || null }));
    return;
  }

  const auth = authorize(req);
  if (!auth) {
    res.writeHead(403, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(DENIED);
    return;
  }

  // WebRTC ICE Configuration endpoint
  if (pathnameOf(req) === '/ice-config') {
    getTurnConfig().then((config) => {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify(config));
    });
    return;
  }

  // WebRTC client-side HID script
  if (pathnameOf(req) === '/__flutter-remote/webrtc-hid.js') {
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=3600'
    });
    res.end(WEBRTC_CLIENT_SCRIPT);
    return;
  }

  const agent = isAgentRoute(req);

  // Trade query token for HttpOnly cookie on human stream
  if (auth === 'query' && !agent) {
    const url = new URL(req.url, 'http://localhost');
    url.searchParams.delete('k');
    const cleanPath = `${url.pathname}${url.search}`;
    res.writeHead(302, {
      Location: cleanPath || '/',
      'Set-Cookie': `${COOKIE}=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`,
      'Cache-Control': 'no-store',
    });
    res.end();
    return;
  }

  const upstreamPort = agent ? AGENT_PORT : TARGET_PORT;

  // Build clean upstream headers — strip hop-by-hop headers that must not be forwarded
  const upstreamHeaders = { ...req.headers };
  upstreamHeaders['x-forwarded-proto'] = 'https';
  upstreamHeaders['x-forwarded-host'] = req.headers.host;
  // Hop-by-hop: never forward these between proxy hops
  delete upstreamHeaders['connection'];
  delete upstreamHeaders['transfer-encoding'];
  delete upstreamHeaders['te'];
  delete upstreamHeaders['trailer'];
  delete upstreamHeaders['proxy-authorization'];
  delete upstreamHeaders['proxy-connection'];

  // Apply TCP_NODELAY to the client socket immediately so the 101/200 response
  // header reaches the browser without waiting for Nagle's 40ms batching window.
  if (res.socket) {
    res.socket.setNoDelay(true);
    res.socket.setKeepAlive(true, 10000);
  }

  const proxy = http.request(
    {
      host: TARGET_HOST,
      port: upstreamPort,
      method: req.method,
      path: req.url,
      headers: upstreamHeaders,
    },
    (upstreamRes) => {
      const streaming = isStreamingResponse(upstreamRes);

      // Build response headers
      const resHeaders = { ...upstreamRes.headers };

      if (streaming) {
        // For video/MJPEG/SSE: tell Cloudflare, Nginx, and any other reverse proxy
        // NOT to buffer this response. Without this, Cloudflare buffers ~512KB before
        // flushing, which causes the black-screen reconnect cycle every 4 seconds.
        resHeaders['x-accel-buffering'] = 'no';
        resHeaders['cache-control'] = 'no-store, no-transform';
        // Cloudflare-specific: disable response buffering
        resHeaders['cf-cache-status'] = 'BYPASS';
      } else if ((upstreamRes.headers['content-type'] || '').toLowerCase().includes('text/html')) {
        let body = '';
        upstreamRes.on('data', (chunk) => { body += chunk; });
        upstreamRes.on('end', () => {
          const scriptTag = '<script src="/__flutter-remote/webrtc-hid.js"></script>';
          let injected = body;
          if (body.includes('<head>')) {
            injected = body.replace('<head>', `<head>${scriptTag}`);
          } else if (body.includes('</head>')) {
            injected = body.replace('</head>', `${scriptTag}</head>`);
          } else {
            injected = `${scriptTag}${body}`;
          }
          resHeaders['content-length'] = Buffer.byteLength(injected);
          delete resHeaders['transfer-encoding'];
          res.writeHead(upstreamRes.statusCode || 200, resHeaders);
          res.end(injected);
        });
        return;
      }

      res.writeHead(upstreamRes.statusCode || 502, resHeaders);

      // Pipe directly — no intermediate buffering.
      upstreamRes.pipe(res, { end: true });

      // For streaming responses, forward backpressure: if the client is slow,
      // pause upstream to prevent the serve-sim buffer from growing unboundedly.
      if (streaming) {
        res.on('drain', () => upstreamRes.resume());
        upstreamRes.on('data', () => {
          if (!res.write) return;
        });
      }
    }
  );

  // TCP_NODELAY on the upstream connection — prevents Nagle's algorithm from
  // delaying small writes (JPEG boundary markers, H.264 NAL units).
  proxy.on('socket', (sock) => {
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 10000);
  });

  proxy.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
    }
    try { res.end(`Upstream error: ${err.message}`); } catch {}
  });

  req.on('error', () => { try { proxy.destroy(); } catch {} });
  res.on('error', () => { try { proxy.destroy(); } catch {} });

  req.pipe(proxy);
});

// WebSocket upgrade — raw TCP tunnel for zero-overhead HID input & WebRTC signaling.
server.on('upgrade', (req, socket, head) => {
  if (!authorize(req)) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }

  // TCP_NODELAY on the browser-facing socket: HID commands (touch, keyboard)
  // are tiny frames (< 100 bytes). Without NODELAY, Nagle batches them for
  // up to 40ms — that's 40ms of avoidable input lag per keypress or tap.
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 10000);

  const isAgent = isAgentRoute(req);
  const isSignal = pathnameOf(req) === '/signal';
  const upstreamPort = isAgent ? AGENT_PORT : (isSignal ? WEBRTC_SIGNAL_PORT : TARGET_PORT);

  const upstream = net.connect(upstreamPort, TARGET_HOST, () => {
    // TCP_NODELAY on the upstream connection too.
    upstream.setNoDelay(true);
    upstream.setKeepAlive(true, 10000);

    // Reconstruct the upgrade request, stripping hop-by-hop headers
    const { connection: _c, 'proxy-connection': _pc, te: _te, ...forwardHeaders } = req.headers;
    const headersStr = Object.entries({
      ...forwardHeaders,
      'x-forwarded-proto': 'https',
      'x-forwarded-host': req.headers.host,
    })
      .map(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`).join('\r\n') : `${k}: ${v}`))
      .join('\r\n');

    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headersStr}\r\n\r\n`);
    if (head && head.length) upstream.write(head);

    // Raw TCP splice — zero-copy bidirectional pipe
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  const drop = () => () => {
    try { socket.destroy(); } catch {}
    try { upstream.destroy(); } catch {}
  };

  upstream.on('error', drop());
  socket.on('error', drop());
  socket.on('close', drop());
  upstream.on('close', drop());
});

server.listen(PORT, TARGET_HOST, () => {
  console.log(`[flutter-remote gate] listening on ${TARGET_HOST}:${PORT} -> :${TARGET_PORT}`);
});
