import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/config/defaultConfig.js';
import { resolveConfig } from '../src/config/index.js';
import { ServeSimConsumer } from '../templates/peer/ServeSimConsumer.cjs';

async function waitFor(fn, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor condition timed out');
}

test('Phase 20: Codec default and configuration resolution', () => {
  assert.equal(DEFAULT_CONFIG.codec, 'mjpeg', 'DEFAULT_CONFIG.codec must default to mjpeg');

  const resolved = resolveConfig({}, {});
  assert.equal(resolved.codec, 'mjpeg', 'resolveConfig must resolve default codec to mjpeg');

  const explicitMjpeg = resolveConfig({ codec: 'mjpeg' }, {});
  assert.equal(explicitMjpeg.codec, 'mjpeg');

  const ymlPath = join(process.cwd(), 'templates', 'flutter-remote.yml');
  const ymlContent = readFileSync(ymlPath, 'utf8');
  assert.ok(ymlContent.includes('default: mjpeg'), 'Workflow input codec must default to mjpeg');
  assert.ok(ymlContent.includes('Normalizing codec \'auto\' to \'mjpeg\''), 'Workflow must normalize auto to mjpeg');

  const peerPath = join(process.cwd(), 'templates', 'webrtc-peer.cjs');
  const peerContent = readFileSync(peerPath, 'utf8');
  assert.ok(peerContent.includes('jpegFrameCount: serveSimConsumer.jpegFrameCount'), 'Healthz must expose jpegFrameCount');
});

test('Phase 20: ServeSimConsumer 5s zero-frame warning diagnostic and frame clearing', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=--frame' });
    res.flushHeaders();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const consumer = new ServeSimConsumer({
    targetHost: '127.0.0.1',
    previewPort: port,
    streamPath: '/stream.mjpeg?raw=1',
    activeVideoTracks: new Set(['dummy-track']),
  });

  try {
    assert.equal(consumer.jpegFrameCount, 0);
    assert.equal(consumer.frameWarningTimer, null);

    // 1. Connect to stream
    consumer.ensureLocalStream();

    // Wait for HTTP 200 response to establish frameWarningTimer
    await waitFor(() => consumer.frameWarningTimer !== null);
    assert.ok(consumer.frameWarningTimer !== null, 'frameWarningTimer should be set on HTTP 200');

    // 2. Clear on close
    consumer.close();
    assert.equal(consumer.frameWarningTimer, null, 'frameWarningTimer must be cleared on close');
  } finally {
    consumer.close();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close();
  }
});

test('Phase 20: ServeSimConsumer clears warning timer on valid JPEG frame', async () => {
  let streamRes = null;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=--frame' });
    res.flushHeaders();
    streamRes = res;
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  let encodedFrames = 0;
  const mockEncoder = {
    encodeFrame: () => { encodedFrames++; },
  };

  const consumer = new ServeSimConsumer({
    targetHost: '127.0.0.1',
    previewPort: port,
    streamPath: '/stream.mjpeg?raw=1',
    activeVideoTracks: new Set(['track1']),
    videoEncoder: mockEncoder,
  });

  try {
    consumer.ensureLocalStream();
    await waitFor(() => consumer.frameWarningTimer !== null);
    assert.ok(consumer.frameWarningTimer !== null, 'Timer should be active awaiting frames');

    // Send a valid JPEG SOI (0xFFD8) + EOI (0xFFD9)
    const validJpeg = Buffer.from([0xff, 0xd8, 0x00, 0x10, 0xff, 0xd9]);
    streamRes.write(validJpeg);

    await waitFor(() => consumer.jpegFrameCount === 1);
    assert.equal(consumer.jpegFrameCount, 1, 'jpegFrameCount should increment');
    assert.equal(encodedFrames, 1, 'Mock encoder should receive frame');
    assert.equal(consumer.frameWarningTimer, null, 'Warning timer must be cleared when valid JPEG arrives');

    consumer.close();
  } finally {
    consumer.close();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close();
  }
});

test('Phase 20 Regression: ServeSimConsumer can reconnect and resume streaming after disconnect and close()', async () => {
  let requestCount = 0;
  let activeRes = null;

  const server = http.createServer((req, res) => {
    requestCount++;
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=--frame' });
    res.flushHeaders();
    activeRes = res;
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  let encodedFrames = 0;
  const mockEncoder = {
    encodeFrame: () => { encodedFrames++; },
  };

  const activeTracks = new Set();
  const consumer = new ServeSimConsumer({
    targetHost: '127.0.0.1',
    previewPort: port,
    streamPath: '/stream.mjpeg?raw=1',
    activeVideoTracks: activeTracks,
    videoEncoder: mockEncoder,
  });

  try {
    // 1. First viewer connects
    activeTracks.add('viewer-1');
    consumer.ensureLocalStream();
    await waitFor(() => requestCount === 1);
    assert.equal(requestCount, 1, 'First HTTP stream request should be established');

    // Send a frame to viewer-1
    const frame1 = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
    activeRes.write(frame1);
    await waitFor(() => consumer.jpegFrameCount === 1);
    assert.equal(consumer.jpegFrameCount, 1);
    assert.equal(encodedFrames, 1);

    // 2. Viewer-1 disconnects (last viewer gone) -> webrtc-peer calls close()
    activeTracks.delete('viewer-1');
    assert.equal(activeTracks.size, 0);
    consumer.close();
    assert.equal(consumer.localStreamReq, null, 'localStreamReq should be null after close');

    // 3. New viewer connects (e.g. page refresh, reconnect, or second viewer)
    activeTracks.add('viewer-2');
    consumer.ensureLocalStream();

    // 4. Assert a NEW HTTP request to serve-sim is made and frames resume streaming
    await waitFor(() => requestCount === 2);
    assert.equal(requestCount, 2, 'New HTTP request must be made after reconnect');

    const frame2 = Buffer.from([0xff, 0xd8, 0x03, 0x04, 0xff, 0xd9]);
    activeRes.write(frame2);
    await waitFor(() => consumer.jpegFrameCount === 2);
    assert.equal(consumer.jpegFrameCount, 2, 'jpegFrameCount must resume incrementing');
    assert.equal(encodedFrames, 2, 'VideoEncoder must receive new frames');

    consumer.close();
  } finally {
    consumer.close();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close();
  }
});
