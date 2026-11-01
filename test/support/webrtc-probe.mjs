#!/usr/bin/env node
/**
 * Opens the WebRTC player (?player=webrtc) in headless Chrome against the real
 * stack (synthetic serve-sim -> webrtc-peer -> gate) for a few seconds and prints
 * one JSON line with what Chrome decoded (inbound-rtp stats). Used by
 * test/e2e/lossy-webrtc.e2e.test.mjs inside a network namespace that drops UDP.
 *
 * Usage: node webrtc-probe.mjs [--size 1206x2622] [--seconds 10]   (PEER_ENV='{"K":"V"}')
 */
import { startStack } from './stack.mjs';
import { stopAll } from './processes.mjs';
import { launchChrome } from './browser.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const size = args.size || '1206x2622';
const seconds = Number(args.seconds || 10);
const stack = await startStack({ size, fps: 15, peerEnv: JSON.parse(process.env.PEER_ENV || '{}') });
const browser = await launchChrome();
const page = await browser.newPage({ viewport: { width: 500, height: 900 } });
await page.goto(`${stack.gate.url}/?player=webrtc&k=${stack.gate.token}`, { waitUntil: 'commit' });
await page.waitForTimeout(seconds * 1000);
const result = await page.evaluate(async () => {
  const v = document.getElementById('flutter-remote-video');
  const status = document.getElementById('flutter-remote-status');
  const c = window.__flutterRemoteClient;
  const pc = c && (c.peer || (c.session && c.session.peer));
  let inbound = null;
  if (pc && pc.getStats) {
    (await pc.getStats()).forEach((x) => {
      if (x.type === 'inbound-rtp' && x.kind === 'video') {
        inbound = { packets: x.packetsReceived, lost: x.packetsLost, nacks: x.nackCount, plis: x.pliCount, decoded: x.framesDecoded, keyframes: x.keyFramesDecoded, width: x.frameWidth, height: x.frameHeight };
      }
    });
  }
  return { videoWidth: v ? v.videoWidth : 0, videoHeight: v ? v.videoHeight : 0, status: status ? status.textContent : null, inbound };
});
console.log(`PROBE ${JSON.stringify({ seconds, size, ...result })}`);
await browser.close();
await stopAll();
process.exit(0);
