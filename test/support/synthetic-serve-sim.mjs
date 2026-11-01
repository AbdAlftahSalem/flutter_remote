#!/usr/bin/env node
/**
 * Synthetic serve-sim: a stand-in for the iOS Simulator streamer (serve-sim)
 * so the whole pipeline can run on Linux and Windows, where no Simulator exists.
 *
 * It is NOT a mock of flutter-remote code. It is a real HTTP/WebSocket server,
 * run as its own process, that speaks what serve-sim (0.1.48) speaks:
 *
 *   GET /                                 a preview page shaped like serve-sim's UI:
 *                                         html/body 100% high, overflow hidden, no
 *                                         #flutter-remote-container, and its own
 *                                         device view that sends taps and keys itself
 *   GET /helper/<udid>/stream.mjpeg?raw=1 a live MJPEG stream (multipart/x-mixed-replace),
 *                                         produced by a real FFmpeg `testsrc2` source
 *                                         (also served at /stream.mjpeg)
 *   WS  /helper/<udid>/ws                 the input socket: binary frames, byte 0 a tag
 *                                         (3 touch, 6 key, 11 scroll), then UTF-8 JSON
 *
 * Like the real one, it refuses any other WebSocket path (a bare /ws is closed),
 * and frames it cannot decode are not inputs. That is the bug the old stand-in hid:
 * it accepted JSON text on /ws, which real serve-sim never did.
 *
 * For assertions it also exposes GET /__synthetic/inputs (every decoded input
 * frame, oldest first: {tag, ...payload}), GET /__synthetic/rejected (frames it
 * could not decode) and GET /__synthetic/stats.
 *
 * --ui-html FILE serves serve-sim's REAL preview UI (the HTML from its npm package)
 * at / instead, configured for this device, so its own React viewer runs against
 * this stand-in (see test/e2e/real-serve-sim-ui.e2e.test.mjs).
 *
 * Usage: node synthetic-serve-sim.mjs --port 3200 [--size 390x844] [--fps 15] [--udid ID] [--ui-html FILE]
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const PORT = Number(args.port ?? 3200);
const SIZE = args.size ?? '390x844';
const FPS = Number(args.fps ?? 15);
const UDID = args.udid ?? 'SYNTHETIC-UDID';
const HELPER = `/helper/${UDID}`;
let ffmpegPath = 'ffmpeg';
try { ffmpegPath = require('ffmpeg-static') || 'ffmpeg'; } catch { /* system ffmpeg */ }

const BOUNDARY = 'serveSimFrame';
const inputs = [];
const rejected = [];
const viewers = new Set();
let framesProduced = 0;
let latestFrame = null;

// One FFmpeg process produces JPEG frames; every viewer gets each frame.
const ffmpeg = spawn(ffmpegPath, [
  '-hide_banner', '-loglevel', 'error',
  '-re', '-f', 'lavfi', '-i', `testsrc2=size=${SIZE}:rate=${FPS}`,
  '-q:v', '5', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1',
], { stdio: ['ignore', 'pipe', 'inherit'] });

let pending = Buffer.alloc(0);
ffmpeg.stdout.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  for (;;) {
    const soi = pending.indexOf(Buffer.from([0xff, 0xd8]));
    if (soi < 0) { pending = Buffer.alloc(0); return; }
    const eoi = pending.indexOf(Buffer.from([0xff, 0xd9]), soi + 2);
    if (eoi < 0) { pending = pending.subarray(soi); return; }
    const frame = pending.subarray(soi, eoi + 2);
    pending = pending.subarray(eoi + 2);
    framesProduced++;
    latestFrame = frame;
    for (const res of viewers) {
      res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
      res.write(frame);
      res.write('\r\n');
    }
  }
});
ffmpeg.on('exit', (code) => {
  console.error(`[synthetic-serve-sim] ffmpeg exited (${code})`);
  process.exit(code === 0 ? 0 : 1);
});

// Shaped like serve-sim's preview UI where it matters for input: the page fills
// the window, has no #flutter-remote-container, and its device view talks to
// HELPER/ws itself (mouse down/move/up -> tag 3, keys -> tag 6), like the real one.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>serve-sim (synthetic)</title>
<style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden;background:#111}
#app{height:100%;display:flex;align-items:center;justify-content:center}
#device{position:relative;width:390px;height:844px;max-height:100%;background:#000 url(${HELPER}/stream.mjpeg?raw=1) center/contain no-repeat}
#device-touch{position:absolute;inset:0;touch-action:none}</style></head>
<body><div id="app"><div id="device"><div id="device-touch"></div></div></div>
<script>
(function(){
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var ws = new WebSocket(proto + '//' + location.host + '${HELPER}/ws');
  ws.binaryType = 'arraybuffer';
  window.__syntheticUiSocket = ws;
  function send(tag, obj){
    if (ws.readyState !== 1) return;
    var j = new TextEncoder().encode(JSON.stringify(obj)); var f = new Uint8Array(1 + j.length);
    f[0] = tag; f.set(j, 1); ws.send(f);
  }
  var el = document.getElementById('device-touch'); var down = false;
  function at(e){ var r = el.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; }
  el.addEventListener('mousedown', function(e){ down = true; var p = at(e); send(3, { type: 'begin', x: p.x, y: p.y }); });
  el.addEventListener('mousemove', function(e){ if (!down) return; var p = at(e); send(3, { type: 'move', x: p.x, y: p.y }); });
  window.addEventListener('mouseup', function(e){ if (!down) return; down = false; var p = at(e); send(3, { type: 'end', x: p.x, y: p.y }); });
  var usage = function(code){ var m = /^Key([A-Z])$/.exec(code || ''); return m ? 4 + m[1].charCodeAt(0) - 65 : null; };
  window.addEventListener('keydown', function(e){ var u = usage(e.code); if (u != null) send(6, { type: 'down', usage: u }); });
  window.addEventListener('keyup', function(e){ var u = usage(e.code); if (u != null) send(6, { type: 'up', usage: u }); });
})();
</script></body></html>`;

const REAL_UI = args['ui-html'] ? readFileSync(args['ui-html'], 'utf8') : null;

/** serve-sim's real page, with the config its own server would inject for this device. */
function realUiPage(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const https = req.headers['x-forwarded-proto'] === 'https';
  const cfg = {
    pid: process.pid, port: PORT, device: UDID, url: `${https ? 'https' : 'http'}://${host}`,
    streamUrl: `${https ? 'https' : 'http'}://${host}${HELPER}/stream.mjpeg`,
    wsUrl: `${https ? 'wss' : 'ws'}://${host}${HELPER}/ws`,
    basePath: '', previewEndpoint: '/', codec: 'mjpeg', proxyHelpers: true,
  };
  return REAL_UI.replace('<!--__SIM_PREVIEW_CONFIG__-->', `<script>window.__SIM_PREVIEW__=${JSON.stringify(cfg)}</script>`);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(REAL_UI ? realUiPage(req) : PAGE);
  } else if (url.pathname === '/stream.mjpeg' || url.pathname === `${HELPER}/stream.mjpeg`) {
    res.writeHead(200, {
      'content-type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    viewers.add(res);
    req.on('close', () => viewers.delete(res));
  } else if (url.pathname === '/snapshot.jpg' && latestFrame) {
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    res.end(latestFrame);
  } else if (url.pathname === '/__synthetic/inputs') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(inputs));
  } else if (url.pathname === '/__synthetic/rejected') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(rejected));
  } else if (url.pathname === '/__synthetic/stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ framesProduced, viewers: viewers.size, inputs: inputs.length, rejected: rejected.length, udid: UDID }));
  } else {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});

// serve-sim answers WebSocket upgrades only on <helper>/ws; anything else is closed.
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname !== `${HELPER}/ws`) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
wss.on('connection', (ws) => {
  ws.on('message', (data, isBinary) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const tag = buf[0];
    if (!isBinary || !(tag >= 1 && tag <= 31)) { rejected.push({ binary: isBinary, text: buf.toString('utf8').slice(0, 200) }); return; }
    let payload = {};
    try { payload = buf.length > 1 ? JSON.parse(buf.subarray(1).toString('utf8')) : {}; } catch { rejected.push({ tag, bad: 'json' }); return; }
    inputs.push({ tag, ...payload });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[synthetic-serve-sim] listening on 127.0.0.1:${PORT} (${SIZE} @ ${FPS}fps)`);
});

const stop = () => { ffmpeg.kill('SIGKILL'); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
