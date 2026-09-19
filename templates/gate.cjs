// flutter-remote-template-version: 8
/**
 * flutter-remote auth gate.
 *
 * serve-sim ships with no authentication, so exposing port 3200 through a public
 * tunnel would hand simulator control to anyone who guessed the URL. This is a
 * zero-dependency reverse proxy that requires `?k=<token>` once, trades it for
 * an HttpOnly cookie, and forwards everything (including the MJPEG/H.264 stream and
 * the control WebSocket) to serve-sim on localhost.
 *
 * V2 ARCHITECTURE:
 *   - Serves modern V2 WebRTC client at /__flutter-remote/client.js (zero monkey patching)
 *   - Injects /__flutter-remote/client.js by default
 *   - Preserves legacy /__flutter-remote/webrtc-hid.js when FLUTTER_REMOTE_TRANSPORT=v1
 */
const http = require('node:http');
const net = require('node:net');

const TOKEN = process.env.FLUTTER_REMOTE_GATE_TOKEN || '';
const TARGET_PORT = Number(process.env.FLUTTER_REMOTE_TARGET_PORT || 3200);
const AGENT_PORT = Number(process.env.FLUTTER_REMOTE_AGENT_PORT || 0);
const WEBRTC_SIGNAL_PORT = Number(process.env.FLUTTER_REMOTE_WEBRTC_SIGNAL_PORT || 3201);
const TRANSPORT_MODE = process.env.FLUTTER_REMOTE_TRANSPORT || 'webrtc';
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
    ct.includes('application/octet-stream') ||     // AVCC / raw binary stream
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

const WEBRTC_CLIENT_SCRIPT_V2 = `
(function() {
  'use strict';
  if (window.__flutterRemoteV2Injected) return;
  window.__flutterRemoteV2Injected = true;

  const PROTOCOL_VERSION = 2;
  const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 10000];

  class FlutterRemoteClient {
    constructor() {
      const urlParams = new URLSearchParams(window.location.search);
      this.sessionId = urlParams.get('session') || 'active';
      this.token = urlParams.get('k') || '';
      this.debugMode = urlParams.get('debug') === '1';
      this.generation = 1;
      this.peer = null;
      this.signalingWs = null;
      this.dataChannels = {};
      this.reconnectAttempt = 0;
      this.reconnectTimer = null;
      this.rtt = 0;

      this.metrics = {
        rtt: 0,
        fps: 0,
        connectionState: 'IDLE',
        iceState: 'new',
        reconnects: 0,
      };

      this.elements = {};
      this._initDOM();
      this._initInputEngine();
      this._connectSignaling();
    }

    _initDOM() {
      const container = document.getElementById('flutter-remote-container') || document.body;

      let video = document.getElementById('flutter-remote-video');
      if (!video) {
        video = document.createElement('video');
        video.id = 'flutter-remote-video';
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        video.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;display:block;';
        container.appendChild(video);
      }
      this.elements.video = video;

      let overlay = document.getElementById('flutter-remote-input-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'flutter-remote-input-overlay';
        overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;touch-action:none;cursor:pointer;z-index:10;';
        container.style.position = 'relative';
        container.appendChild(overlay);
      }
      this.elements.overlay = overlay;

      let status = document.getElementById('flutter-remote-status');
      if (!status) {
        status = document.createElement('div');
        status.id = 'flutter-remote-status';
        status.style.cssText = 'position:absolute;top:10px;left:50%;transform:translateX(-50%);padding:6px 14px;background:rgba(0,0,0,0.75);color:#fff;border-radius:20px;font:12px sans-serif;z-index:20;transition:opacity 0.3s;pointer-events:none;';
        container.appendChild(status);
      }
      this.elements.status = status;

      if (this.debugMode) {
        const debugPanel = document.createElement('div');
        debugPanel.id = 'flutter-remote-debug-panel';
        debugPanel.style.cssText = 'position:absolute;bottom:10px;left:10px;padding:10px;background:rgba(0,0,0,0.85);color:#0f0;font:11px monospace;border-radius:6px;z-index:30;pointer-events:none;line-height:1.4;';
        container.appendChild(debugPanel);
        this.elements.debugPanel = debugPanel;
        setInterval(() => this._updateDebug(), 1000);
      }

      this._updateStatus('Connecting to remote simulator...');
    }

    _updateStatus(text) {
      if (this.elements.status) {
        this.elements.status.textContent = text;
        this.elements.status.style.opacity = '1';
        if (text === 'Connected') {
          setTimeout(() => {
            if (this.elements.status.textContent === 'Connected') {
              this.elements.status.style.opacity = '0';
            }
          }, 2000);
        }
      }
    }

    _initInputEngine() {
      const overlay = this.elements.overlay;
      let nextSeq = 1;
      let pendingMove = null;
      let rafId = null;

      const sendPointer = (data) => {
        const dc = this.dataChannels.input;
        if (dc && dc.readyState === 'open') {
          if (dc.bufferedAmount > 65536 && data.event === 'move') return;
          dc.send(JSON.stringify(data));
        }
      };

      const flush = () => {
        if (pendingMove) {
          sendPointer(pendingMove);
          pendingMove = null;
        }
        rafId = null;
      };

      const handlePointer = (e, type) => {
        const rect = this.elements.video.getBoundingClientRect();
        const videoWidth = this.elements.video.videoWidth || 720;
        const videoHeight = this.elements.video.videoHeight || 1280;
        const containerAspect = rect.width / rect.height;
        const videoAspect = videoWidth / videoHeight;

        let dispW = rect.width;
        let dispH = rect.height;
        let offX = 0;
        let offY = 0;

        if (containerAspect > videoAspect) {
          dispW = rect.height * videoAspect;
          offX = (rect.width - dispW) / 2;
        } else {
          dispH = rect.width / videoAspect;
          offY = (rect.height - dispH) / 2;
        }

        const rawX = e.clientX - rect.left - offX;
        const rawY = e.clientY - rect.top - offY;
        const normX = Math.max(0, Math.min(1, rawX / dispW));
        const normY = Math.max(0, Math.min(1, rawY / dispH));

        const evt = {
          v: PROTOCOL_VERSION,
          type: 'pointer',
          seq: nextSeq++,
          ts: Date.now(),
          event: type,
          pointerId: e.pointerId || 1,
          x: Number(normX.toFixed(5)),
          y: Number(normY.toFixed(5)),
          button: e.button || 0,
          buttons: e.buttons !== undefined ? e.buttons : 1,
        };

        if (type === 'down') {
          try { overlay.setPointerCapture(e.pointerId); } catch {}
          if (rafId) { cancelAnimationFrame(rafId); flush(); }
          sendPointer(evt);
        } else if (type === 'up' || type === 'cancel') {
          try { overlay.releasePointerCapture(e.pointerId); } catch {}
          if (rafId) { cancelAnimationFrame(rafId); flush(); }
          sendPointer(evt);
        } else if (type === 'move') {
          pendingMove = evt;
          if (!rafId) rafId = requestAnimationFrame(flush);
        }
      };

      overlay.addEventListener('pointerdown', (e) => handlePointer(e, 'down'));
      overlay.addEventListener('pointermove', (e) => handlePointer(e, 'move'));
      overlay.addEventListener('pointerup', (e) => handlePointer(e, 'up'));
      overlay.addEventListener('pointercancel', (e) => handlePointer(e, 'cancel'));

      window.addEventListener('keydown', (e) => {
        const dc = this.dataChannels.keyboard;
        if (dc && dc.readyState === 'open') {
          dc.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'keyboard', seq: nextSeq++, ts: Date.now(), event: 'keydown', key: e.key, code: e.code }));
        }
      });

      window.addEventListener('keyup', (e) => {
        const dc = this.dataChannels.keyboard;
        if (dc && dc.readyState === 'open') {
          dc.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'keyboard', seq: nextSeq++, ts: Date.now(), event: 'keyup', key: e.key, code: e.code }));
        }
      });
    }

    async _connectSignaling() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = proto + '//' + location.host + '/signal?session=' + encodeURIComponent(this.sessionId) + '&k=' + encodeURIComponent(this.token);

      this.signalingWs = new WebSocket(url);
      this.signalingWs.onopen = async () => {
        this._updateStatus('Negotiating WebRTC...');
        await this._initPeer();
      };

      this.signalingWs.onmessage = async (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'answer' && this.peer) {
            const sdp = (msg.payload && msg.payload.sdp) || msg.sdp;
            await this.peer.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
          } else if ((msg.type === 'ice-candidate' || msg.type === 'candidate') && this.peer) {
            const cand = msg.payload || msg.candidate;
            if (cand && cand.candidate) {
              await this.peer.addIceCandidate(new RTCIceCandidate(cand));
            }
          }
        } catch (err) {
          console.warn('[flutter-remote client signaling error]', err);
        }
      };

      this.signalingWs.onclose = () => {
        this._scheduleReconnect();
      };
    }

    async _initPeer() {
      if (this.peer) {
        try { this.peer.close(); } catch {}
      }

      let iceServers = [{ urls: 'stun:stun.cloudflare.com:3478' }];
      try {
        const res = await fetch('/ice-config');
        const data = await res.json();
        if (data && data.iceServers) iceServers = data.iceServers;
      } catch {}

      this.peer = new RTCPeerConnection({ iceServers });

      this.peer.ontrack = (e) => {
        if (e.streams && e.streams[0]) {
          this.elements.video.srcObject = e.streams[0];
        } else {
          this.elements.video.srcObject = new MediaStream([e.track]);
        }
        this._updateStatus('Connected');
        this.metrics.connectionState = 'CONNECTED';
      };

      const inputDc = this.peer.createDataChannel('input', { ordered: false, maxRetransmits: 0 });
      const keyboardDc = this.peer.createDataChannel('keyboard', { ordered: true });
      const controlDc = this.peer.createDataChannel('control', { ordered: true });
      const telemetryDc = this.peer.createDataChannel('telemetry', { ordered: false, maxRetransmits: 0 });

      this.dataChannels = { input: inputDc, keyboard: keyboardDc, control: controlDc, telemetry: telemetryDc };

      inputDc.onopen = () => {
        this._updateStatus('Connected');
        this.metrics.connectionState = 'CONNECTED';
      };

      this.peer.onicecandidate = (e) => {
        if (e.candidate && this.signalingWs && this.signalingWs.readyState === WebSocket.OPEN) {
          this.signalingWs.send(JSON.stringify({
            v: PROTOCOL_VERSION,
            type: 'ice-candidate',
            generation: this.generation,
            payload: e.candidate,
          }));
        }
      };

      const offer = await this.peer.createOffer({ offerToReceiveVideo: true });
      await this.peer.setLocalDescription(offer);

      this.signalingWs.send(JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'offer',
        generation: this.generation,
        payload: { sdp: offer.sdp, iceServers },
      }));
    }

    _scheduleReconnect() {
      if (this.reconnectTimer) return;
      this.metrics.reconnects++;
      const delay = BACKOFF_MS[Math.min(this.reconnectAttempt, BACKOFF_MS.length - 1)];
      this.reconnectAttempt++;
      this._updateStatus('Reconnecting... (Attempt ' + this.reconnectAttempt + ')');

      this.reconnectTimer = setTimeout(async () => {
        this.reconnectTimer = null;
        this.generation++;
        await this._connectSignaling();
      }, delay);
    }

    _updateDebug() {
      if (!this.elements.debugPanel) return;
      this.elements.debugPanel.innerHTML =
        '<div><strong>Flutter Remote V2 Diagnostics</strong></div>' +
        '<div>Connection: ' + this.metrics.connectionState + '</div>' +
        '<div>Reconnects: ' + this.metrics.reconnects + '</div>' +
        '<div>Generation: ' + this.generation + '</div>';
    }
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    new FlutterRemoteClient();
  } else {
    window.addEventListener('DOMContentLoaded', () => new FlutterRemoteClient());
  }
})();
`;

const WEBRTC_CLIENT_SCRIPT_LEGACY = `
(function() {
  if (window.__flutterRemoteWebRTCInjected) return;
  window.__flutterRemoteWebRTCInjected = true;

  try { localStorage.setItem('serve-sim:codec', 'mjpeg'); } catch (e) {}

  const OrigWebSocket = window.WebSocket;
  let rtcPeer = null;
  let dataChannel = null;
  let rtcReady = false;
  let signalingWs = null;

  function initChangeSocket() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const streamWs = new OrigWebSocket(proto + '//' + location.host + '/stream-ws');
    streamWs.binaryType = 'blob';
    let lastBlobUrl = null;

    streamWs.onmessage = (event) => {
      if (!(event.data instanceof Blob)) return;
      const newBlobUrl = URL.createObjectURL(event.data);
      const img = document.querySelector('img[src*="blob:"], img[src*="/stream"], .simulator-frame img, [data-simulator] img');
      if (img) {
        img.src = newBlobUrl;
        if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
        lastBlobUrl = newBlobUrl;
      }
    };
    streamWs.onclose = () => setTimeout(initChangeSocket, 2000);
  }
  try { initChangeSocket(); } catch (e) {}

  async function initWebRTC() {
    try {
      const res = await fetch('/ice-config');
      const iceConfig = await res.json();
      if (!iceConfig || !iceConfig.iceServers || iceConfig.iceServers.length === 0) return;

      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      signalingWs = new OrigWebSocket(proto + '//' + location.host + '/signal');

      signalingWs.onopen = async () => {
        try {
          rtcPeer = new RTCPeerConnection(iceConfig);
          dataChannel = rtcPeer.createDataChannel('hid', { ordered: true });
          dataChannel.binaryType = 'arraybuffer';
          dataChannel.onopen = () => { rtcReady = true; };
          dataChannel.onclose = () => { rtcReady = false; };
          rtcPeer.onicecandidate = (e) => {
            if (e.candidate && signalingWs && signalingWs.readyState === OrigWebSocket.OPEN) {
              signalingWs.send(JSON.stringify({ type: 'candidate', candidate: e.candidate }));
            }
          };
          const offer = await rtcPeer.createOffer();
          await rtcPeer.setLocalDescription(offer);
          signalingWs.send(JSON.stringify({ type: 'offer', sdp: offer.sdp, iceServers: iceConfig.iceServers }));
        } catch (err) {}
      };

      signalingWs.onmessage = async (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'answer' && rtcPeer) {
            await rtcPeer.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
          } else if (msg.type === 'candidate' && rtcPeer && msg.candidate) {
            await rtcPeer.addIceCandidate(new RTCIceCandidate(msg.candidate));
          }
        } catch (err) {}
      };
    } catch (err) {}
  }
  initWebRTC();

  window.WebSocket = function(url, protocols) {
    const isHidWs = typeof url === 'string' && (url.endsWith('/ws') || url.includes('/ws?'));
    const ws = protocols ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
    if (!isHidWs) return ws;
    const origSend = ws.send.bind(ws);
    ws.send = function(data) {
      if (rtcReady && dataChannel && dataChannel.readyState === 'open') {
        try { dataChannel.send(data); return; } catch (e) {}
      }
      return origSend(data);
    };
    return ws;
  };
  window.WebSocket.prototype = OrigWebSocket.prototype;
})();
`;

const DENIED = `<!doctype html><meta charset=utf-8><title>Flutter Remote</title>
<style>body{font:14px/1.6 -apple-system,system-ui,sans-serif;margin:15vh auto;max-width:34rem;padding:0 1.5rem;color:#111}
h1{font-size:1.1rem;margin-bottom:.5rem}code{background:#f3f4f6;padding:.15rem .35rem;border-radius:3px;font-size:.9em}
@media(prefers-color-scheme:dark){body{background:#0a0a0c;color:#eee}code{background:#1f2023}}</style>
<h1>Flutter Remote Session Locked</h1>
<p>This stream is secured by a gate token. Use the full URL provided by <code>flutter-remote up</code>.</p>`;

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/__flutter-remote/healthz') || req.url.startsWith('/healthz')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, target: TARGET_PORT, mode: TRANSPORT_MODE, agent: AGENT_PORT || null }));
    return;
  }

  if (req.url.startsWith('/readyz')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ready: true, mode: TRANSPORT_MODE }));
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

  // V2 browser client script
  if (pathnameOf(req) === '/__flutter-remote/client.js') {
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=3600'
    });
    res.end(WEBRTC_CLIENT_SCRIPT_V2);
    return;
  }

  // Legacy client-side HID & Stream script (for V1 rollback)
  if (pathnameOf(req) === '/__flutter-remote/webrtc-hid.js') {
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=3600'
    });
    res.end(WEBRTC_CLIENT_SCRIPT_LEGACY);
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
  delete upstreamHeaders['connection'];
  delete upstreamHeaders['transfer-encoding'];
  delete upstreamHeaders['te'];
  delete upstreamHeaders['trailer'];
  delete upstreamHeaders['proxy-authorization'];
  delete upstreamHeaders['proxy-connection'];
  delete upstreamHeaders['accept-encoding'];
  upstreamHeaders['accept-encoding'] = 'identity';

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
      const resHeaders = { ...upstreamRes.headers };

      if (streaming) {
        resHeaders['x-accel-buffering'] = 'no';
        resHeaders['cache-control'] = 'no-cache, no-store, no-transform';
        resHeaders['pragma'] = 'no-cache';
        resHeaders['cf-cache-status'] = 'BYPASS';
      } else if ((upstreamRes.headers['content-type'] || '').toLowerCase().includes('text/html')) {
        let body = '';
        upstreamRes.on('data', (chunk) => { body += chunk; });
        upstreamRes.on('end', () => {
          const isV1 = TRANSPORT_MODE === 'v1' || TRANSPORT_MODE === 'legacy';
          const scriptTag = isV1
            ? '<script src="/__flutter-remote/webrtc-hid.js"></script>'
            : '<script src="/__flutter-remote/client.js"></script>';

          let injected = body;
          if (body.includes('<head>')) {
            injected = body.replace('<head>', `<head>${scriptTag}`);
          } else if (body.includes('</head>')) {
            injected = body.replace('</head>', `${scriptTag}</head>`);
          } else {
            injected = `${scriptTag}${body}`;
          }
          resHeaders['content-length'] = Buffer.byteLength(injected);
          resHeaders['cache-control'] = 'no-cache, no-store, must-revalidate';
          delete resHeaders['transfer-encoding'];
          delete resHeaders['content-encoding'];
          res.writeHead(upstreamRes.statusCode || 200, resHeaders);
          res.end(injected);
        });
        return;
      }

      res.writeHead(upstreamRes.statusCode || 502, resHeaders);
      upstreamRes.pipe(res, { end: true });
    }
  );

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
  res.on('close', () => { try { proxy.destroy(); } catch {} });

  req.pipe(proxy);
});

// WebSocket upgrade — raw TCP tunnel for zero-overhead HID input, WebRTC signaling & change streaming.
server.on('upgrade', (req, socket, head) => {
  if (!authorize(req)) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }

  socket.setNoDelay(true);
  socket.setKeepAlive(true, 10000);

  const isAgent = isAgentRoute(req);
  const isSignal = pathnameOf(req) === '/signal' || pathnameOf(req) === '/stream-ws';
  const upstreamPort = isAgent ? AGENT_PORT : (isSignal ? WEBRTC_SIGNAL_PORT : TARGET_PORT);

  const upstream = net.connect(upstreamPort, TARGET_HOST, () => {
    upstream.setNoDelay(true);
    upstream.setKeepAlive(true, 10000);

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
  console.log(`[flutter-remote gate] listening on ${TARGET_HOST}:${PORT} -> :${TARGET_PORT} (mode: ${TRANSPORT_MODE})`);
});

