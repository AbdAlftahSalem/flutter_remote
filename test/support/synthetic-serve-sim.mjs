#!/usr/bin/env node
/**
 * Synthetic serve-sim: a stand-in for the iOS Simulator streamer (serve-sim)
 * so the whole pipeline can run on Linux and Windows, where no Simulator exists.
 *
 * It is NOT a mock of flutter-remote code. It is a real HTTP/WebSocket server,
 * run as its own process, that speaks the same three things serve-sim speaks:
 *
 *   GET /                    an HTML page (the gate injects the client into it)
 *   GET /stream.mjpeg?raw=1  a live MJPEG stream (multipart/x-mixed-replace),
 *                            produced by a real FFmpeg `testsrc2` source
 *   WS  /ws                  the input socket (pointer / keyboard / clipboard)
 *
 * For assertions it also exposes GET /__synthetic/inputs (every message received
 * on /ws, oldest first) and GET /__synthetic/stats.
 *
 * Usage: node synthetic-serve-sim.mjs --port 3200 [--size 390x844] [--fps 15]
 */
import http from 'node:http';
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
let ffmpegPath = 'ffmpeg';
try { ffmpegPath = require('ffmpeg-static') || 'ffmpeg'; } catch { /* system ffmpeg */ }

const BOUNDARY = 'serveSimFrame';
const inputs = [];
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

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>serve-sim (synthetic)</title></head>
<body style="margin:0;background:#111"><div id="flutter-remote-container" style="width:390px;height:844px;margin:0 auto"></div></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  } else if (url.pathname === '/stream.mjpeg') {
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
  } else if (url.pathname === '/__synthetic/stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ framesProduced, viewers: viewers.size, inputs: inputs.length }));
  } else {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    let parsed;
    try { parsed = JSON.parse(data.toString()); } catch { parsed = { raw: data.toString() }; }
    inputs.push(parsed);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[synthetic-serve-sim] listening on 127.0.0.1:${PORT} (${SIZE} @ ${FPS}fps)`);
});

const stop = () => { ffmpeg.kill('SIGKILL'); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
