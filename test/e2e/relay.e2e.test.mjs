/**
 * The gate's MJPEG relay (stream-relay.cjs), end to end: synthetic serve-sim at
 * an iPhone 17 Pro's real frame size (1206x2622) -> gate -> a real HTTP client
 * reading the stream exactly like serve-sim's viewer does
 * (`<helper>/stream.mjpeg?raw=1`, frames split by JPEG markers).
 *
 * Measured on a GitHub macOS runner before this relay (2026-11-01): serve-sim
 * sent 12-16 full-size frames (~231 KB) per second, idle or not, i.e. 22-30
 * Mbit/s through the tunnel, and serve-sim's viewer dims the phone whenever a
 * frame takes longer than 2 s (the black flicker).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startStack, HELPER_PATH } from '../support/stack.mjs';
import { stopAll, request } from '../support/processes.mjs';

after(async () => { await stopAll(); });

const COOKIE = 'flutter_remote_k=e2e-token';
const STREAM = `${HELPER_PATH}/stream.mjpeg?raw=1`;

function jpegSize(jpeg) {
  for (let i = 2; i < jpeg.length - 9; i++) {
    if (jpeg[i] === 0xff && (jpeg[i + 1] === 0xc0 || jpeg[i + 1] === 0xc2)) {
      return { height: jpeg.readUInt16BE(i + 5), width: jpeg.readUInt16BE(i + 7) };
    }
  }
  return null;
}

/** Read a MJPEG stream for `ms`; every frame with its arrival time. */
function readStream(url, ms, { onFrame } = {}) {
  return new Promise((resolve, reject) => {
    const frames = [];
    let bytes = 0;
    let pending = Buffer.alloc(0);
    let contentType = null;
    let status = null;
    const started = Date.now();
    const req = http.get(url, { headers: { cookie: COOKIE } }, (res) => {
      status = res.statusCode;
      contentType = res.headers['content-type'];
      res.on('data', (chunk) => {
        bytes += chunk.length;
        pending = Buffer.concat([pending, chunk]);
        for (;;) {
          const s = pending.indexOf(Buffer.from([0xff, 0xd8]));
          if (s < 0) break;
          const e = pending.indexOf(Buffer.from([0xff, 0xd9]), s + 2);
          if (e < 0) break;
          const jpeg = Buffer.from(pending.subarray(s, e + 2));
          pending = pending.subarray(e + 2);
          const frame = { at: Date.now() - started, jpeg };
          frames.push(frame);
          if (onFrame) onFrame(frame);
        }
      });
    });
    req.on('error', reject);
    setTimeout(() => { req.destroy(); resolve({ frames, bytes, contentType, status, ms }); }, ms);
  });
}

const maxGap = (frames) => frames.slice(1).reduce((m, f, i) => Math.max(m, f.at - frames[i].at), 0);

test('serve-sim\'s full-size frames reach the viewer scaled to 960 px and at least 4x lighter', async () => {
  const stack = await startStack({ size: '1206x2622', fps: 15 });
  const [direct, relayed] = await Promise.all([
    readStream(`${stack.serveSim.url}${STREAM}`, 4000),
    readStream(`${stack.gate.url}${STREAM}`, 4000),
  ]);
  assert.equal(relayed.status, 200);
  assert.match(relayed.contentType, /^multipart\/x-mixed-replace; boundary=frame/);
  assert.ok(relayed.frames.length >= 40, `the viewer got ${relayed.frames.length} frames in 4 s (serve-sim sent ${direct.frames.length})`);
  assert.deepEqual(jpegSize(direct.frames[0].jpeg), { width: 1206, height: 2622 });
  assert.deepEqual(jpegSize(relayed.frames.at(-1).jpeg), { width: 442, height: 960 });
  const ratio = direct.bytes / relayed.bytes;
  assert.ok(ratio >= 4, `relayed ${relayed.bytes} B vs serve-sim ${direct.bytes} B (only ${ratio.toFixed(1)}x lighter)`);
  const stats = JSON.parse((await request(`${stack.gate.url}/__flutter-remote/relay-stats`, { headers: { cookie: COOKIE } })).body);
  assert.equal(stats.config.maxDimension, 960);
  await stopAll();
});

test('the frame rate is capped at --fps, and the last frame of a burst still arrives', async () => {
  const stack = await startStack({ size: '390x844', fps: 30, gateEnv: { FLUTTER_REMOTE_VIDEO_FPS: '10' } });
  const r = await readStream(`${stack.gate.url}${STREAM}`, 3000);
  const perSecond = r.frames.length / 3;
  assert.ok(perSecond <= 12, `${perSecond.toFixed(1)} frames/s with --fps 10 (serve-sim sends 30)`);
  assert.ok(perSecond >= 7, `${perSecond.toFixed(1)} frames/s with --fps 10`);
  await stopAll();
});

test('a still screen costs about one frame a second, with no gap long enough to dim serve-sim\'s viewer', async () => {
  // serve-sim re-sends the same picture several times a second while nothing moves.
  const stack = await startStack({ size: '1206x2622', fps: 15, still: true });
  const [direct, relayed] = await Promise.all([
    readStream(`${stack.serveSim.url}${STREAM}`, 4500),
    readStream(`${stack.gate.url}${STREAM}`, 4500),
  ]);
  assert.ok(direct.frames.length >= 55, `serve-sim re-sent ${direct.frames.length} identical frames`);
  assert.ok(relayed.frames.length >= 4 && relayed.frames.length <= 8,
    `a still screen sent ${relayed.frames.length} frames in 4.5 s (expected the ~1/s keepalive)`);
  assert.ok(maxGap(relayed.frames) <= 1500, `longest gap ${maxGap(relayed.frames)} ms; serve-sim's viewer dims after 2000 ms`);
  assert.ok(direct.bytes / relayed.bytes >= 40, `still screen: ${relayed.bytes} B vs ${direct.bytes} B`);
  await stopAll();
});

test('a change on a still screen reaches the viewer within 500 ms (FFmpeg\'s pipe does not hold it back)', async () => {
  const stack = await startStack({ size: '1206x2622', fps: 15, still: true });
  let changedAt = 0;
  let seenAt = 0;
  let previous = null;
  const reading = readStream(`${stack.gate.url}${STREAM}`, 6000, {
    onFrame: (f) => {
      if (changedAt && !seenAt && previous && !previous.equals(f.jpeg)) seenAt = Date.now();
      previous = f.jpeg;
    },
  });
  await new Promise((r) => setTimeout(r, 2500));
  changedAt = Date.now();
  await request(`${stack.serveSim.url}/__synthetic/change`, { method: 'POST' });
  await reading;
  assert.ok(seenAt, 'the new picture never reached the viewer');
  const latency = seenAt - changedAt;
  assert.ok(latency < 500, `the change took ${latency} ms to reach the viewer`);
  await stopAll();
});

test('FLUTTER_REMOTE_STREAM_RELAY=0 passes serve-sim\'s frames through unchanged', async () => {
  const stack = await startStack({ size: '1206x2622', fps: 15, gateEnv: { FLUTTER_REMOTE_STREAM_RELAY: '0' } });
  const r = await readStream(`${stack.gate.url}${STREAM}`, 2000);
  assert.ok(r.frames.length >= 20);
  assert.deepEqual(jpegSize(r.frames[0].jpeg), { width: 1206, height: 2622 });
  await stopAll();
});

test('without FFmpeg the relay still de-duplicates and caps, sending serve-sim\'s frames unscaled', async () => {
  const stack = await startStack({ size: '390x844', fps: 15, gateEnv: { FLUTTER_REMOTE_FFMPEG: '/nonexistent/ffmpeg', FLUTTER_REMOTE_VIDEO_FPS: '30' } });
  const r = await readStream(`${stack.gate.url}${STREAM}`, 3000);
  assert.ok(r.frames.length >= 30, `got ${r.frames.length} frames without FFmpeg`);
  assert.deepEqual(jpegSize(r.frames.at(-1).jpeg), { width: 390, height: 844 });
  await stopAll();
});

test('the relay passes serve-sim\'s answer on for a stream that does not exist', async () => {
  const stack = await startStack({ size: '390x844', fps: 15 });
  const res = await request(`${stack.gate.url}/helper/NO-SUCH-DEVICE/stream.mjpeg?raw=1`, { headers: { cookie: COOKIE } });
  assert.equal(res.status, 404);
  await stopAll();
});

test('two viewers share one serve-sim connection and both get frames', async () => {
  const stack = await startStack({ size: '390x844', fps: 15 });
  const [a, b] = await Promise.all([
    readStream(`${stack.gate.url}${STREAM}`, 2500),
    readStream(`${stack.gate.url}${STREAM}`, 2500),
  ]);
  assert.ok(a.frames.length >= 20 && b.frames.length >= 20, `viewer A ${a.frames.length}, viewer B ${b.frames.length} frames`);
  const stats = JSON.parse((await request(`${stack.serveSim.url}/__synthetic/stats`)).body);
  assert.ok(stats.viewers <= 1, `serve-sim had ${stats.viewers} stream connections for two viewers`);
  await stopAll();
});
