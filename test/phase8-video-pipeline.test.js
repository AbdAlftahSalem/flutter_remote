import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameController } from '../src/media/FrameController.js';
import { VideoEncoder, NAL_TYPES } from '../src/media/VideoEncoder.js';
import { AdaptiveBitrate } from '../src/media/AdaptiveBitrate.js';
import { VIDEO_PRESETS } from '../src/shared/constants.js';

test('Phase 8: FrameController bounded queue and stale frame dropping', () => {
  const controller = new FrameController({ maxQueueSize: 2 });

  for (let i = 1; i <= 5; i++) {
    controller.pushFrame(Buffer.from(`frame-${i}`));
  }

  assert.equal(controller.queueLength, 2);
  assert.equal(controller.totalFramesReceived, 5);
  assert.equal(controller.totalFramesDropped, 3);

  const item1 = controller.popFrame();
  const item2 = controller.popFrame();
  assert.equal(item1.frame.toString(), 'frame-4');
  assert.equal(item2.frame.toString(), 'frame-5');
  assert.equal(controller.queueLength, 0);
});

test('Phase 8: VideoEncoder H.264 Annex-B parsing, SPS/PPS caching, and IDR keyframe extraction', () => {
  const encoder = new VideoEncoder({ payloadType: 98, ssrc: 9999, mtu: 1200 });

  // Construct a realistic Annex-B H.264 IDR keyframe:
  // StartCode (00 00 00 01) + SPS (0x67, len 10)
  // StartCode (00 00 00 01) + PPS (0x68, len 6)
  // StartCode (00 00 00 01) + IDR (0x65, len 50)
  const sps = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67]), Buffer.alloc(9, 0xaa)]);
  const pps = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x01, 0x68]), Buffer.alloc(5, 0xbb)]);
  const idr = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65]), Buffer.alloc(49, 0xcc)]);
  const keyframeBuffer = Buffer.concat([sps, pps, idr]);

  assert.equal(encoder.hasKeyframe(), false);

  const packets = encoder.packetize(keyframeBuffer, 30);
  assert.ok(packets.length >= 3, 'Must produce packets for SPS, PPS, and IDR');
  assert.equal(encoder.lastFrameType, 'keyframe');
  assert.equal(encoder.hasKeyframe(), true);

  const cachedKeyframe = encoder.getKeyframe();
  assert.ok(cachedKeyframe.length > 0);
  assert.ok(encoder.cachedSps !== null);
  assert.ok(encoder.cachedPps !== null);

  // Parse a delta frame (Non-IDR slice 0x61 = type 1)
  const nonIdr = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x01, 0x61]), Buffer.alloc(30, 0xdd)]);
  encoder.packetize(nonIdr, 30);
  assert.equal(encoder.lastFrameType, 'delta');
});

test('Phase 8: VideoEncoder RFC 6184 FU-A fragmentation for oversized NAL units', () => {
  const encoder = new VideoEncoder({ payloadType: 98, ssrc: 9999, mtu: 500 });
  // Single NAL unit of 1200 bytes with Annex-B prefix
  const largeNal = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65]), // IDR header (0x65: NRI=3, Type=5)
    Buffer.alloc(1195, 0xee),
  ]);

  const packets = encoder.packetize(largeNal, 30);
  assert.ok(packets.length >= 3, 'Must fragment into at least 3 FU-A packets');

  // Check First Packet
  const p0 = packets[0];
  assert.equal(p0[0], 0x80); // V=2
  assert.equal(p0[1] & 0x7f, 98); // PT=98
  assert.equal(p0[1] & 0x80, 0x00); // Marker = 0 (not last)
  assert.equal(p0[12] & 0x1f, NAL_TYPES.FU_A); // FU Indicator type = 28
  assert.equal(p0[13] & 0x80, 0x80); // FU Header Start bit = 1
  assert.equal(p0[13] & 0x40, 0x00); // FU Header End bit = 0
  assert.equal(p0[13] & 0x1f, 5); // Original NAL type = 5 (IDR)

  // Check Last Packet
  const pLast = packets[packets.length - 1];
  assert.equal(pLast[1] & 0x80, 0x80); // Marker bit = 1 on last packet of frame
  assert.equal(pLast[12] & 0x1f, NAL_TYPES.FU_A);
  assert.equal(pLast[13] & 0x80, 0x00); // Start bit = 0
  assert.equal(pLast[13] & 0x40, 0x40); // End bit = 1
  assert.equal(pLast[13] & 0x1f, 5); // Original NAL type = 5
});

test('Phase 8: AdaptiveBitrate quality adjustments', () => {
  const abr = new AdaptiveBitrate({ initialLevel: 'MEDIUM' });
  assert.equal(abr.currentLevel, 'MEDIUM');

  abr.evaluateMetrics({ rtt: 350, packetLoss: 0.08, droppedFrames: 10 });
  abr.evaluateMetrics({ rtt: 350, packetLoss: 0.08, droppedFrames: 10 });

  assert.equal(abr.currentLevel, 'LOW');
  assert.equal(abr.preset.fps, VIDEO_PRESETS.LOW.fps);

  for (let i = 0; i < 5; i++) {
    abr.evaluateMetrics({ rtt: 30, packetLoss: 0, droppedFrames: 0 });
  }

  assert.equal(abr.currentLevel, 'MEDIUM');
});
