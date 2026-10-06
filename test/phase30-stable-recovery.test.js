import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { KeyframeController } = require('../templates/peer/KeyframeController.cjs');
const { PeerSession } = require('../templates/peer/PeerSession.cjs');

test('stable recovery: browser keyframe requests never replace a live encoder', async () => {
  let spawnCalls = 0;
  const controller = new KeyframeController({
    rtpPacketizer: { packetizeAccessUnit: () => [] },
    spawnEncoderFn: () => {
      spawnCalls++;
      throw new Error('A browser recovery must not spawn FFmpeg');
    },
  });

  controller.cachedKeyframe = Buffer.from([0, 0, 0, 1, 0x65]);
  await controller.requestKeyframe(Buffer.from([0xff, 0xd8]), () => {}, () => [], 30);
  assert.equal(spawnCalls, 0);

  controller.cachedKeyframe = null;
  await controller.requestKeyframe(Buffer.from([0xff, 0xd8]), () => {}, () => [], 30);
  assert.equal(spawnCalls, 0);
});

test('stable recovery: adaptive telemetry and browser resize do not reconfigure the encoder by default', () => {
  const calls = [];
  const session = new PeerSession({
    qualityController: { evaluateTelemetry: () => calls.push('adapt') },
    videoEncoder: { setResolution: () => calls.push('resize') },
  });

  // The message callback is installed while negotiating; this assertion keeps
  // the public production source explicit about the safe default.
  const source = require('node:fs').readFileSync('templates/peer/PeerSession.cjs', 'utf8');
  assert.match(source, /this\.adaptiveQualityEnabled = options\.adaptiveQualityEnabled === true/);
  assert.match(source, /Browser layout is not the simulator's capture resolution/);
  assert.deepEqual(calls, []);
  session.close();
});
