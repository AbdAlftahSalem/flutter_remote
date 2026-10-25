/**
 * Streaming end-to-end: a real headless Google Chrome opens the gate URL the
 * way a user does, negotiates real WebRTC with the real webrtc-peer.cjs, and
 * must show real, moving H.264 video. Taps and keys must reach serve-sim.
 *
 * The only stand-in is serve-sim itself (synthetic-serve-sim.mjs: FFmpeg
 * testsrc2 as MJPEG), because there is no iOS Simulator on Linux/Windows.
 * Needs Google Chrome (or FLUTTER_REMOTE_E2E_CHROME) and FFmpeg.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack } from '../support/stack.mjs';
import { stopAll, request, waitUntil } from '../support/processes.mjs';
import { launchChrome, countPresentedFrames, sampleVideoPixels } from '../support/browser.mjs';

let stack;
let browser;
before(async () => {
  stack = await startStack();
  browser = await launchChrome();
});
after(async () => {
  await browser?.close();
  await stopAll();
});

async function openViewer() {
  const page = await browser.newPage({ viewport: { width: 500, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${stack.gate.url}/?k=${stack.gate.token}`);
  await page.waitForFunction(() => {
    const v = document.getElementById('flutter-remote-video');
    return v && v.videoWidth > 0 && v.currentTime > 0;
  }, null, { timeout: 30000 });
  return { page, errors };
}

const inputs = async () => JSON.parse((await request(`${stack.serveSim.url}/__synthetic/inputs`)).body);

test('the browser shows live, non-black H.264 video within seconds', async () => {
  const started = Date.now();
  const { page, errors } = await openViewer();
  const firstFrameMs = Date.now() - started;
  const frames = await countPresentedFrames(page, 3000);
  const pixels = await sampleVideoPixels(page);
  const codec = await page.evaluate(async () => {
    const pc = window.__flutterRemoteClient?.peer;
    if (!pc) return null;
    const stats = await pc.getStats();
    let mime = null;
    stats.forEach((s) => { if (s.type === 'codec' && /video/.test(s.mimeType)) mime = s.mimeType; });
    return mime;
  });
  await page.close();

  assert.deepEqual(errors, [], 'no page errors');
  assert.ok(firstFrameMs < 20000, `first frame took ${firstFrameMs} ms`);
  assert.ok(frames >= 15, `only ${frames} frames presented in 3 s`);
  assert.equal(pixels.width, 390);
  assert.equal(pixels.height, 844);
  assert.ok(pixels.variance > 500, `picture looks blank (variance ${pixels.variance.toFixed(0)})`);
  assert.ok(pixels.mean > 10, `picture is black (mean ${pixels.mean.toFixed(1)})`);
  assert.equal(codec, 'video/H264');
});

test('the peer negotiated H.264 from the browser offer (mid and payload type)', async () => {
  const line = stack.peer.proc.output.match(/video negotiated: mid=(\S+) H264 pt=(\d+) \((.*)\)/);
  assert.ok(line, 'peer must log the negotiated video line');
  assert.match(line[3], /packetization-mode=1/);
});

test('the picture keeps moving (not frozen)', async () => {
  const { page } = await openViewer();
  const a = await page.evaluate(() => document.getElementById('flutter-remote-video').currentTime);
  const s1 = await sampleVideoPixels(page);
  await page.waitForTimeout(1500);
  const b = await page.evaluate(() => document.getElementById('flutter-remote-video').currentTime);
  const s2 = await sampleVideoPixels(page);
  await page.close();
  assert.ok(b - a > 1, `video time advanced only ${(b - a).toFixed(2)} s in 1.5 s`);
  assert.notEqual(s1.mean.toFixed(3), s2.mean.toFixed(3), 'two samples 1.5 s apart are identical');
});

test('a tap on the video reaches serve-sim as pointer down and up', async () => {
  const { page } = await openViewer();
  const before = (await inputs()).length;
  const box = await page.locator('#flutter-remote-input-overlay').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const got = await waitUntil(async () => {
    const list = (await inputs()).slice(before);
    const kinds = list.map((m) => m.event ?? m.phase ?? m.action ?? m.type);
    return kinds.some((k) => /down/.test(k)) && kinds.some((k) => /up/.test(k)) && list;
  }, 10000, 'pointer down/up never reached serve-sim');
  await page.close();
  assert.ok(got.every((m) => typeof m === 'object'));
});

test('a key press reaches serve-sim', async () => {
  const { page } = await openViewer();
  const before = (await inputs()).length;
  await page.keyboard.press('a');
  const got = await waitUntil(async () => {
    const list = (await inputs()).slice(before);
    return list.some((m) => JSON.stringify(m).includes('"a"') || /key/i.test(m.type ?? '')) && list;
  }, 10000, 'the key never reached serve-sim');
  await page.close();
  assert.ok(got.length > 0);
});

test('reloading the page reconnects and the video comes back', async () => {
  const { page } = await openViewer();
  await page.reload();
  await page.waitForFunction(() => {
    const v = document.getElementById('flutter-remote-video');
    return v && v.videoWidth > 0 && v.currentTime > 0;
  }, null, { timeout: 30000 });
  const frames = await countPresentedFrames(page, 2000);
  await page.close();
  assert.ok(frames >= 10, `only ${frames} frames after reload`);
});

test('two viewers at once both get video', async () => {
  const [a, b] = await Promise.all([openViewer(), openViewer()]);
  const [fa, fb] = await Promise.all([countPresentedFrames(a.page, 2000), countPresentedFrames(b.page, 2000)]);
  await Promise.all([a.page.close(), b.page.close()]);
  assert.ok(fa >= 10 && fb >= 10, `frames: ${fa} and ${fb}`);
});
