/**
 * A real headless Google Chrome (H.264 WebRTC decode needs Chrome, not the
 * open-source Chromium build). Override with FLUTTER_REMOTE_E2E_CHROME=/path.
 */
import { chromium } from 'playwright-core';

export async function launchChrome() {
  const executablePath = process.env.FLUTTER_REMOTE_E2E_CHROME || undefined;
  return chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    args: [
      '--autoplay-policy=no-user-gesture-required',
      // Same-machine test: expose real host candidates instead of mDNS names.
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  });
}

/** Count frames the <video> element actually presents, for `ms` milliseconds. */
export async function countPresentedFrames(page, ms = 3000) {
  return page.evaluate((duration) => new Promise((resolve) => {
    const v = document.getElementById('flutter-remote-video');
    if (!v || typeof v.requestVideoFrameCallback !== 'function') { resolve(-1); return; }
    let frames = 0;
    const tick = () => { frames++; v.requestVideoFrameCallback(tick); };
    v.requestVideoFrameCallback(tick);
    setTimeout(() => resolve(frames), duration);
  }), ms);
}

/** Draw the current video frame to a canvas and summarize its pixels. */
export async function sampleVideoPixels(page) {
  return page.evaluate(() => {
    const v = document.getElementById('flutter-remote-video');
    if (!v || !v.videoWidth) return null;
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(v, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let sum = 0; let sumSq = 0; let n = 0;
    for (let i = 0; i < data.length; i += 4 * 97) {
      const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      sum += l; sumSq += l * l; n++;
    }
    const mean = sum / n;
    return { width: c.width, height: c.height, mean, variance: sumSq / n - mean * mean };
  });
}
