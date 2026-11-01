/**
 * serve-sim's REAL preview UI, end to end (opt-in: it downloads serve-sim from npm).
 *
 *   FLUTTER_REMOTE_REAL_SERVE_SIM=1 npm run test:real-ui        (serve-sim 0.1.48)
 *   FLUTTER_REMOTE_REAL_SERVE_SIM=0.1.49 npm run test:real-ui
 *
 * The page the user sees is serve-sim's own React UI. This test takes that exact
 * page from serve-sim's npm package, serves it from the stand-in (which decodes the
 * input frames), puts the real gate (with the injected client) and the real
 * webrtc-peer in front, and drives it in headless Chrome:
 *
 *  - a click on serve-sim's phone must reach serve-sim as a touch begin/end at the
 *    clicked spot, and a key as a HID key. In 0.2.2 a transparent overlay from the
 *    injected client took the click and nothing arrived (Event Log 0).
 *  - with ?player=webrtc, the same through the WebRTC player and the peer.
 *
 * What it cannot cover: the Simulator itself (that needs macOS).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startStack } from '../support/stack.mjs';
import { stopAll, request, waitUntil } from '../support/processes.mjs';
import { launchChrome } from '../support/browser.mjs';
import { tempDir, cleanupTemps } from '../support/cli.mjs';

const want = process.env.FLUTTER_REMOTE_REAL_SERVE_SIM;
const version = !want || want === '1' ? '0.1.48' : want;
const skip = want ? false : 'set FLUTTER_REMOTE_REAL_SERVE_SIM=1 (downloads serve-sim from npm)';

/** serve-sim ships its preview page as a base64 string inside its bundle. */
function extractPreviewHtml(distDir) {
  for (const f of readdirSync(distDir).filter((n) => n.endsWith('.js'))) {
    const src = readFileSync(join(distDir, f), 'utf8');
    for (const m of src.matchAll(/"([A-Za-z0-9+/=]{20000,})"/g)) {
      const html = Buffer.from(m[1], 'base64').toString('utf8');
      if (/^<!doctype html/i.test(html) && html.includes('<!--__SIM_PREVIEW_CONFIG__-->')) return html;
    }
  }
  throw new Error(`no preview page found in serve-sim@${version}`);
}

let stack;
let browser;
before(async () => {
  if (skip) return;
  const dir = tempDir();
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const pack = spawnSync(npm, ['pack', `serve-sim@${version}`, '--silent'], { cwd: dir, encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(pack.status, 0, pack.stderr);
  const tgz = pack.stdout.trim().split('\n').pop();
  const untar = spawnSync('tar', ['-xzf', tgz], { cwd: dir, encoding: 'utf8' });
  assert.equal(untar.status, 0, untar.stderr);
  const uiHtml = join(dir, 'serve-sim-preview.html');
  writeFileSync(uiHtml, extractPreviewHtml(join(dir, 'package', 'dist')));
  stack = await startStack({ uiHtml });
  browser = await launchChrome();
});
after(async () => {
  await browser?.close();
  await stopAll();
  cleanupTemps();
});

const inputs = async () => JSON.parse((await request(`${stack.serveSim.url}/__synthetic/inputs`)).body);

/** The biggest image/canvas on the page: serve-sim's phone screen. */
async function phoneScreen(page) {
  return page.waitForFunction(() => {
    const r = [...document.querySelectorAll('img,canvas')]
      .map((e) => e.getBoundingClientRect())
      .filter((b) => b.width > 100 && b.height > 200)
      .sort((a, b) => b.width * b.height - a.width * a.height)[0];
    return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
  }, null, { timeout: 20000 }).then((h) => h.jsonValue());
}

test(`serve-sim ${version}'s own UI: a click on the phone and a key reach serve-sim`, { skip, timeout: 60000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${stack.gate.url}/?k=${stack.gate.token}`);
  const s = await phoneScreen(page);
  await page.waitForTimeout(1500); // serve-sim's viewer opens its input socket
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h * 0.4;
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id || '', [cx, cy]);
  assert.notEqual(hit, 'flutter-remote-input-overlay', 'the injected client covers serve-sim\'s phone');

  const before = (await inputs()).length;
  await page.mouse.click(cx, cy);
  await page.keyboard.press('a');
  const got = await waitUntil(async () => {
    const list = (await inputs()).slice(before);
    return list.some((m) => m.tag === 3 && m.type === 'end') && list.some((m) => m.tag === 6 && m.usage === 4) && list;
  }, 10000, 'serve-sim\'s own tap/key never reached serve-sim');
  await page.close();
  const begin = got.find((m) => m.tag === 3 && m.type === 'begin');
  assert.ok(begin && Math.abs(begin.x - 0.5) < 0.03 && Math.abs(begin.y - 0.4) < 0.03, JSON.stringify(begin));
  assert.deepEqual(errors, []);
});

test(`serve-sim ${version}'s UI with ?player=webrtc: a tap and a key reach serve-sim once`, { skip, timeout: 60000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(`${stack.gate.url}/?player=webrtc&k=${stack.gate.token}`);
  await page.waitForFunction(() => {
    const v = document.getElementById('flutter-remote-video');
    return v && v.videoWidth > 0 && v.currentTime > 0;
  }, null, { timeout: 30000 });
  const box = await page.locator('#flutter-remote-input-overlay').boundingBox();
  const before = (await inputs()).length;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('a');
  await waitUntil(async () => (await inputs()).slice(before).some((m) => m.tag === 6 && m.type === 'up'), 10000, 'nothing reached serve-sim');
  await page.waitForTimeout(500);
  const list = (await inputs()).slice(before);
  await page.close();
  assert.deepEqual(list.filter((m) => m.tag === 3).map((m) => m.type), ['begin', 'end']);
  assert.equal(list.filter((m) => m.tag === 6 && m.type === 'down').length, 1, JSON.stringify(list));
});
