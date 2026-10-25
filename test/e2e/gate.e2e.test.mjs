/**
 * Gate end-to-end: the real gate.cjs in front of the real webrtc-peer.cjs and a
 * synthetic serve-sim, all separate processes, spoken to over real HTTP and
 * WebSocket. Covers auth, script injection, the served client, WebSocket
 * upgrades (the black-screen fix) and the MJPEG stream.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import { startStack, startGate, RUNNER_DIR, GATE } from '../support/stack.mjs';
import { stopAll, request, waitUntil, startProcess, freePort } from '../support/processes.mjs';
import { tempDir, cleanupTemps } from '../support/cli.mjs';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

let stack;
before(async () => { stack = await startStack(); });
after(async () => { await stopAll(); cleanupTemps(); });

const gateUrl = (path) => `${stack.gate.url}${path}`;
const cookieFor = async () => {
  const res = await request(gateUrl(`/?k=${stack.gate.token}`));
  return res.headers['set-cookie'][0].split(';')[0];
};

test('health endpoints answer without a token', async () => {
  for (const path of ['/healthz', '/__flutter-remote/healthz', '/readyz']) {
    const res = await request(gateUrl(path));
    assert.equal(res.status, 200, path);
    assert.equal(JSON.parse(res.body).ok, true);
  }
});

test('no token, or a wrong one, gets the 403 page', async () => {
  for (const path of ['/', '/?k=wrong', '/stream.mjpeg?raw=1', '/__flutter-remote/client.js']) {
    const res = await request(gateUrl(path));
    assert.equal(res.status, 403, path);
    assert.match(res.body, /<title>Flutter Remote<\/title>/);
  }
  const bearer = await request(gateUrl('/'), { headers: { authorization: 'Bearer nope' } });
  assert.equal(bearer.status, 403);
});

test('?k=<token> is traded for an HttpOnly cookie and removed from the URL', async () => {
  const res = await request(gateUrl(`/?k=${stack.gate.token}&debug=1`));
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/?debug=1');
  const cookie = res.headers['set-cookie'][0];
  assert.match(cookie, /^flutter_remote_k=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
});

test('with the cookie, the serve-sim page comes back with the client injected', async () => {
  const res = await request(gateUrl('/'), { headers: { cookie: await cookieFor() } });
  assert.equal(res.status, 200);
  assert.match(res.body, /<head><script src="\/__flutter-remote\/client\.js"><\/script>/);
  assert.match(res.body, /serve-sim \(synthetic\)/);
  assert.equal(Number(res.headers['content-length']), Buffer.byteLength(res.body));
});

test('the served client is exactly the file on disk and is valid JavaScript', async () => {
  const res = await request(gateUrl('/__flutter-remote/client.js'), { headers: { cookie: await cookieFor() } });
  assert.equal(res.status, 200);
  assert.equal(res.body, readFileSync(join(RUNNER_DIR, 'client', 'flutter-remote-client.js'), 'utf8'));
  const file = join(tempDir(), 'served-client.js');
  writeFileSync(file, res.body);
  const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
});

test('ICE config is served to the browser (STUN when no TURN key is set)', async () => {
  const res = await request(gateUrl('/ice-config'), { headers: { cookie: await cookieFor() } });
  assert.equal(res.status, 200);
  const cfg = JSON.parse(res.body);
  assert.ok(Array.isArray(cfg.iceServers) && cfg.iceServers.length > 0);
  assert.match(JSON.stringify(cfg.iceServers), /stun:/);
});

test('the MJPEG stream flows through the gate unbuffered', async () => {
  const cookie = await cookieFor();
  const { headers, jpegs } = await new Promise((resolve, reject) => {
    const req = http.get(gateUrl('/stream.mjpeg?raw=1'), { headers: { cookie } }, (res) => {
      let buf = Buffer.alloc(0);
      res.on('data', (c) => {
        buf = Buffer.concat([buf, c]);
        let count = 0;
        for (let i = buf.indexOf(Buffer.from([0xff, 0xd8])); i >= 0; i = buf.indexOf(Buffer.from([0xff, 0xd8]), i + 2)) count++;
        if (count >= 3) { req.destroy(); resolve({ headers: res.headers, jpegs: count }); }
      });
    });
    req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
    setTimeout(() => reject(new Error('fewer than 3 JPEG frames in 8 s')), 8000);
  });
  assert.match(headers['content-type'], /multipart\/x-mixed-replace/);
  assert.equal(headers['x-accel-buffering'], 'no');
  assert.ok(jpegs >= 3);
});

test('WebSocket upgrades are proxied: /ws reaches serve-sim (the Connection: Upgrade fix)', async () => {
  const cookie = await cookieFor();
  const ws = new WebSocket(`${stack.gate.url.replace('http', 'ws')}/ws`, { headers: { cookie } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'e2e-probe', n: 1 }));
  const inputs = await waitUntil(async () => {
    const list = JSON.parse((await request(`${stack.serveSim.url}/__synthetic/inputs`)).body);
    return list.some((m) => m.type === 'e2e-probe') && list;
  }, 5000, 'the probe never reached serve-sim');
  assert.ok(inputs.length >= 1);
  ws.close();
});

test('WebSocket upgrades are proxied: /signal reaches the WebRTC peer', async () => {
  const connections = () => (stack.peer.proc.output.match(/WebRTC client connected/g) ?? []).length;
  const before = connections();
  const ws = new WebSocket(`${stack.gate.url.replace('http', 'ws')}/signal?session=e2e`, { headers: { authorization: `Bearer ${stack.gate.token}` } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await waitUntil(() => connections() > before, 5000, 'peer never saw the signaling session');
  ws.close();
});

test('a WebSocket without the token is refused', async () => {
  const ws = new WebSocket(`${stack.gate.url.replace('http', 'ws')}/ws`);
  const outcome = await new Promise((resolve) => {
    ws.once('open', () => resolve('open'));
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.once('error', () => resolve('error'));
  });
  assert.notEqual(outcome, 'open');
});

test('pipeline metrics are readable through the gate with the token', async () => {
  const res = await request(gateUrl('/__flutter-remote/metrics'), { headers: { authorization: `Bearer ${stack.gate.token}` } });
  assert.equal(res.status, 200);
  const m = JSON.parse(res.body);
  assert.ok('rtp' in m && 'framePipeline' in m, res.body);
});

test('legacy transport (v1) injects the legacy HID script', async () => {
  const legacy = await startGate({ serveSimPort: stack.serveSim.port, peerPort: stack.peer.port, env: { FLUTTER_REMOTE_TRANSPORT: 'v1' } });
  const res = await request(`${legacy.url}/`, { headers: { authorization: `Bearer ${legacy.token}` } });
  assert.match(res.body, /<script src="\/__flutter-remote\/webrtc-hid\.js"><\/script>/);
  await legacy.proc.stop();
});

test('the gate refuses to start without a token', async () => {
  const port = await freePort();
  const proc = startProcess('gate-no-token', process.execPath, [GATE], { env: { FLUTTER_REMOTE_GATE_TOKEN: '', FLUTTER_REMOTE_GATE_PORT: String(port) } });
  await waitUntil(() => proc.exited, 5000, 'gate kept running without a token');
  assert.equal(proc.exitCode, 1);
  assert.match(proc.output, /FLUTTER_REMOTE_GATE_TOKEN is required/);
});
