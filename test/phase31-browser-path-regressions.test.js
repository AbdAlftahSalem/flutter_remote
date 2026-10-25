import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { negotiateH264 } = require('../templates/peer/PeerSession.cjs');

test('Phase 31: the browser client served by gate.cjs is valid JavaScript', () => {
  const src = readFileSync(join(process.cwd(), 'templates', 'gate.cjs'), 'utf8');
  const start = src.indexOf('const WEBRTC_CLIENT_SCRIPT_V2 = `');
  const end = src.indexOf('const WEBRTC_CLIENT_SCRIPT_LEGACY');
  assert.ok(start > 0 && end > start);
  // Evaluate the template literal exactly as Node does, then parse what the browser receives.
  const literal = src.slice(start + 'const WEBRTC_CLIENT_SCRIPT_V2 = '.length, end).trim().replace(/;$/, '');
  const served = vm.runInNewContext(literal);
  assert.doesNotThrow(() => new vm.Script(served, { filename: 'client.js' }));
});

test('Phase 31: negotiateH264 reuses the browser mid and its H.264 payload type', () => {
  const offer = [
    'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0 1',
    'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98 102 104 108 114',
    'a=mid:0', 'a=recvonly',
    'a=rtpmap:96 VP8/90000', 'a=rtpmap:97 rtx/90000', 'a=fmtp:97 apt=96',
    'a=rtpmap:98 VP9/90000', 'a=fmtp:98 profile-id=0',
    'a=rtpmap:102 H264/90000', 'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f',
    'a=rtpmap:104 H264/90000', 'a=fmtp:104 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42001f',
    'a=rtpmap:108 H264/90000', 'a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=mid:1',
  ].join('\r\n');
  const neg = negotiateH264(offer);
  assert.equal(neg.mid, '0');
  assert.equal(neg.payloadType, 108);
  assert.notEqual(neg.payloadType, 98, 'PT 98 is VP9 in Chrome offers');
});

test('Phase 31: gate.cjs WebSocket tunnel keeps the upgrade (no 404 on /signal)', async () => {
  const upstream = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  upstream.on('upgrade', (req, socket) => {
    socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const signalPort = upstream.address().port;
  const gatePort = signalPort + 1;
  const gate = spawn(process.execPath, [join(process.cwd(), 'templates', 'gate.cjs')], {
    env: { ...process.env, FLUTTER_REMOTE_GATE_TOKEN: 't', FLUTTER_REMOTE_GATE_PORT: String(gatePort),
      FLUTTER_REMOTE_WEBRTC_SIGNAL_PORT: String(signalPort), FLUTTER_REMOTE_TARGET_PORT: String(signalPort) },
    stdio: 'ignore',
  });
  try {
    await new Promise((r) => setTimeout(r, 700));
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: gatePort, path: '/signal?k=t', headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
      req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
      req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 101);
  } finally {
    gate.kill();
    upstream.close();
  }
});
