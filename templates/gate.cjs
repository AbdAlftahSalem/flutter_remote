// flutter-remote-template-version: 2
/**
 * flutter-remote auth gate.
 *
 * serve-sim ships with no authentication, so exposing port 3200 through a public
 * tunnel would hand simulator control to anyone who guessed the URL. This is a
 * zero-dependency reverse proxy that requires `?k=<token>` once, trades it for
 * an HttpOnly cookie, and forwards everything (including the MJPEG stream and
 * the control WebSocket) to serve-sim on localhost.
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
  const upstreamPath = req.url;

  const upstreamHeaders = {
    ...req.headers,
    'x-forwarded-proto': 'https',
    'x-forwarded-host': req.headers.host,
  };

  const proxy = http.request(
    {
      host: TARGET_HOST,
      port: upstreamPort,
      method: req.method,
      path: upstreamPath,
      headers: upstreamHeaders,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );

  proxy.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
    }
    res.end(`Upstream error: ${err.message}`);
  });

  req.on('error', () => {
    proxy.destroy();
  });

  res.on('error', () => {
    proxy.destroy();
  });

  req.pipe(proxy);
});

server.on('upgrade', (req, socket, head) => {
  if (!authorize(req)) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }

  const isAgent = isAgentRoute(req);
  const upstreamPort = isAgent ? AGENT_PORT : TARGET_PORT;

  const upstream = net.connect(upstreamPort, TARGET_HOST, () => {
    const forwarded = {
      ...req.headers,
      'x-forwarded-proto': 'https',
      'x-forwarded-host': req.headers.host,
    };
    const headers = Object.entries(forwarded)
      .map(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`).join('\r\n') : `${k}: ${v}`))
      .join('\r\n');

    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  const drop = () => {
    try { socket.destroy(); } catch {}
    try { upstream.destroy(); } catch {}
  };

  upstream.on('error', drop);
  socket.on('error', drop);
  socket.on('close', drop);
});

server.listen(PORT, TARGET_HOST, () => {
  console.log(`[flutter-remote gate] listening on ${TARGET_HOST}:${PORT} -> :${TARGET_PORT}`);
});
