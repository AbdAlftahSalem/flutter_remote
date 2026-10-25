/**
 * Runner end-to-end: the whole product, exactly as a user runs it.
 *
 * Runs `flutter-remote up` for real against a real Flutter app (fixture/main.dart),
 * which dispatches the real workflow on a real GitHub macOS runner, builds the
 * app, boots the real iOS Simulator and opens the tunnel. Then a real headless
 * Chrome opens the printed link and checks: video arrives, it is the app (green
 * screen, not black), and a tap in the browser flips the app to yellow in the
 * Simulator. Finally `flutter-remote down`.
 *
 * Needs: GH_TOKEN with repo + workflow scope, FR_E2E_APP_DIR (a Flutter app
 * folder, see .github/workflows/e2e-runner.yml), Google Chrome. Costs macOS
 * runner minutes (free when the fixture repository is public).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { launchChrome, countPresentedFrames, sampleVideoPixels } from '../support/browser.mjs';
import { ROOT } from '../support/cli.mjs';

const APP = process.env.FR_E2E_APP_DIR;
const BIN = join(ROOT, 'bin', 'flutter-remote.js');
const skip = !APP || !process.env.GH_TOKEN ? 'set FR_E2E_APP_DIR and GH_TOKEN (runs in .github/workflows/e2e-runner.yml)' : false;

let browser;
after(async () => {
  await browser?.close();
  if (APP) spawnSync(process.execPath, [BIN, 'down', '--all'], { cwd: APP, stdio: 'inherit' });
});

/** Run `up` and resolve with the live link once it is printed. */
function up() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'up', '--public', '--no-open', '--minutes', '15',
      '--repo', process.env.FR_E2E_REPO_NAME ?? 'flutter-remote-e2e-fixture', '--message', 'e2e run'], {
      cwd: APP, env: { ...process.env, NO_COLOR: '1' },
    });
    let out = '';
    const onData = (d) => {
      process.stdout.write(d);
      out += d;
      const url = out.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\/\?k=[\w-]+/);
      if (url) resolve({ url: url[0], child });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`flutter-remote up exited ${code} before printing a link\n${out.slice(-3000)}`)));
  });
}

test('flutter-remote up streams the real app from the iOS Simulator, and taps reach it', { skip, timeout: 45 * 60 * 1000 }, async () => {
  const { url } = await up();
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 600, height: 1000 } });
  await page.goto(url);
  await page.waitForFunction(() => {
    const v = document.getElementById('flutter-remote-video');
    return v && v.videoWidth > 0 && v.currentTime > 0;
  }, null, { timeout: 120000 });

  const frames = await countPresentedFrames(page, 5000);
  assert.ok(frames > 0, 'no video frames from the simulator');

  // Wait for the fixture app to be on screen: mostly green (0xFF1B5E20).
  await page.waitForFunction(() => {
    const v = document.getElementById('flutter-remote-video');
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    const ctx = c.getContext('2d'); ctx.drawImage(v, 0, 0);
    const [r, g, b] = ctx.getImageData(c.width / 2, c.height * 0.75, 1, 1).data;
    return g > r + 40 && g > b + 40;
  }, null, { timeout: 300000, polling: 1000 });
  const before = await sampleVideoPixels(page);

  const box = await page.locator('#flutter-remote-input-overlay').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.75);

  // Yellow (0xFFFFEB3B) is far brighter than the dark green.
  await page.waitForFunction((meanBefore) => {
    const v = document.getElementById('flutter-remote-video');
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    const ctx = c.getContext('2d'); ctx.drawImage(v, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let sum = 0; let n = 0;
    for (let i = 0; i < data.length; i += 4 * 101) { sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; n++; }
    return sum / n > meanBefore + 60;
  }, before.mean, { timeout: 30000, polling: 250 });
});
