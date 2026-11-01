/**
 * Streaming end-to-end: a real headless Google Chrome opens the gate URL the
 * way a user does. On serve-sim's own UI (the default page) the client must stay
 * out of the way so serve-sim's own taps and keys work. With ?player=webrtc it
 * negotiates real WebRTC with the real webrtc-peer.cjs, must show real, moving
 * H.264 video, and its taps and keys must reach serve-sim in serve-sim's own
 * binary format on /helper/<udid>/ws.
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
  await page.goto(`${stack.gate.url}/?player=webrtc&k=${stack.gate.token}`);
  try {
    await page.waitForFunction(() => {
      const v = document.getElementById('flutter-remote-video');
      return v && v.videoWidth > 0 && v.currentTime > 0;
    }, null, { timeout: 30000 });
  } catch (err) {
    // Say why: the player's status line and what the peer logged.
    const status = await page.evaluate(() => document.getElementById('flutter-remote-status')?.textContent).catch(() => '?');
    const peerLog = String(stack.peer.proc.output || '').split('\n').slice(-40).join('\n');
    throw new Error(`no video within 30 s (player: "${status}")\n--- webrtc-peer, last lines ---\n${peerLog}`, { cause: err });
  }
  return { page, errors };
}

const inputs = async () => JSON.parse((await request(`${stack.serveSim.url}/__synthetic/inputs`)).body);
const rejected = async () => JSON.parse((await request(`${stack.serveSim.url}/__synthetic/rejected`)).body);

test('on serve-sim\'s own UI the client adds no overlay, and a tap on serve-sim\'s phone reaches serve-sim', async () => {
  // The reported bug: the client covered serve-sim's page with a transparent
  // full-page overlay, so clicks on the phone never reached serve-sim (Event Log 0).
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${stack.gate.url}/?k=${stack.gate.token}`);
  await page.waitForFunction(() => window.__syntheticUiSocket && window.__syntheticUiSocket.readyState === 1, null, { timeout: 10000 });
  const state = await page.evaluate(() => {
    const t = document.getElementById('device-touch').getBoundingClientRect();
    const hit = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2);
    return {
      overlay: Boolean(document.getElementById('flutter-remote-input-overlay')),
      video: Boolean(document.getElementById('flutter-remote-video')),
      mode: window.__flutterRemoteClient && window.__flutterRemoteClient.mode,
      hit: hit && hit.id,
      center: { x: t.left + t.width / 2, y: t.top + t.height / 2 },
    };
  });
  assert.equal(state.overlay, false, 'no input overlay on serve-sim\'s page');
  assert.equal(state.video, false, 'no hidden second video on serve-sim\'s page');
  assert.equal(state.mode, 'serve-sim-ui');
  assert.equal(state.hit, 'device-touch', `a click on the phone lands on ${state.hit}, not serve-sim's view`);

  const before = (await inputs()).length;
  await page.mouse.click(state.center.x, state.center.y);
  const got = await waitUntil(async () => {
    const list = (await inputs()).slice(before).filter((m) => m.tag === 3);
    return list.some((m) => m.type === 'begin') && list.some((m) => m.type === 'end') && list;
  }, 10000, 'serve-sim\'s own tap never reached serve-sim through the gate');
  await page.close();
  assert.deepEqual(errors, [], 'no page errors');
  assert.ok(Math.abs(got[0].x - 0.5) < 0.02 && Math.abs(got[0].y - 0.5) < 0.02);
});

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

test('a tap in the WebRTC player reaches serve-sim as a touch begin and end at the right spot', async () => {
  const { page } = await openViewer();
  const before = (await inputs()).length;
  const rejectedBefore = (await rejected()).length;
  const box = await page.locator('#flutter-remote-input-overlay').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const got = await waitUntil(async () => {
    const list = (await inputs()).slice(before).filter((m) => m.tag === 3);
    return list.some((m) => m.type === 'begin') && list.some((m) => m.type === 'end') && list;
  }, 10000, 'touch begin/end never reached serve-sim');
  await page.close();
  const begin = got.find((m) => m.type === 'begin');
  assert.ok(Math.abs(begin.x - 0.5) < 0.02 && Math.abs(begin.y - 0.5) < 0.02, `tap landed at ${begin.x},${begin.y}`);
  assert.equal((await rejected()).length, rejectedBefore, 'serve-sim got frames it could not read');
});

test('a key press in the WebRTC player reaches serve-sim once, as a HID key down and up', async () => {
  const { page } = await openViewer();
  const before = (await inputs()).length;
  await page.keyboard.press('a');
  const got = await waitUntil(async () => {
    const list = (await inputs()).slice(before).filter((m) => m.tag === 6);
    return list.some((m) => m.type === 'up' && m.usage === 4) && list;
  }, 10000, 'the key never reached serve-sim');
  await page.waitForTimeout(300);
  const all = (await inputs()).slice(before).filter((m) => m.tag === 6);
  await page.close();
  assert.ok(got.length > 0);
  // serve-sim's own UI underneath also listens for keys; the player must take them first.
  assert.equal(all.filter((m) => m.type === 'down' && m.usage === 4).length, 1, `"a" went down ${JSON.stringify(all)}`);
});

test('a scroll in the WebRTC player reaches serve-sim as a scroll frame', async () => {
  const { page } = await openViewer();
  const before = (await inputs()).length;
  const box = await page.locator('#flutter-remote-input-overlay').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 120);
  const got = await waitUntil(async () => {
    const list = (await inputs()).slice(before).filter((m) => m.tag === 11);
    return list.length > 0 && list;
  }, 10000, 'the scroll never reached serve-sim');
  await page.close();
  assert.ok(got[0].dy > 0, `dy ${got[0].dy}`);
  assert.ok(got[0].x >= 0 && got[0].x <= 1 && got[0].y >= 0 && got[0].y <= 1);
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
