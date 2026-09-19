import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameController } from '../src/media/FrameController.js';
import { VideoEncoder } from '../src/media/VideoEncoder.js';
import { AdaptiveBitrate } from '../src/media/AdaptiveBitrate.js';
import { VIDEO_PRESETS } from '../src/shared/constants.js';

test('Phase 8: FrameController bounded queue and stale frame dropping', () => {
  const controller = new FrameController({ maxQueueSize: 2 });

  // Push 5 frames rapidly
  for (let i = 1; i <= 5; i++) {
    controller.pushFrame(Buffer.from(`frame-${i}`));
  }

  // Queue must be capped at 2
  assert.equal(controller.queueLength, 2);
  assert.equal(controller.totalFramesReceived, 5);
  assert.equal(controller.totalFramesDropped, 3);

  // Latest frames must be frame-4 and frame-5
  const item1 = controller.popFrame();
  const item2 = controller.popFrame();
  assert.equal(item1.frame.toString(), 'frame-4');
  assert.equal(item2.frame.toString(), 'frame-5');
  assert.equal(controller.queueLength, 0);
});

test('Phase 8: VideoEncoder RTP packetization format', () => {
  const encoder = new VideoEncoder({ payloadType: 98, ssrc: 9999, mtu: 500 });
  const dummyFrame = Buffer.alloc(1200, 0xaa); // 1200 bytes will require 3 packets (each max 488 payload + 12 header)

  const packets = encoder.packetize(dummyFrame, 30);
  assert.equal(packets.length, 3);

  // Check Packet 1
  const p1 = packets[0];
  assert.equal(p1[0], 0x80); // V=2
  assert.equal(p1[1] & 0x7f, 98); // PT=98
  assert.equal(p1[1] & 0x80, 0x00); // Marker bit = 0 (not last)
  assert.equal(p1.readUInt16BE(2), 1); // Seq = 1
  assert.equal(p1.readUInt32BE(8), 9999); // SSRC

  // Check Last Packet
  const pLast = packets[2];
  assert.equal(pLast[1] & 0x80, 0x80); // Marker bit = 1 (last packet of frame)
  assert.equal(pLast.readUInt16BE(2), 3); // Seq = 3
});

test('Phase 8: AdaptiveBitrate quality adjustments', () => {
  const abr = new AdaptiveBitrate({ initialLevel: 'MEDIUM' });
  assert.equal(abr.currentLevel, 'MEDIUM');

  // Degraded network: high RTT & packet loss
  abr.evaluateMetrics({ rtt: 350, packetLoss: 0.08, droppedFrames: 10 });
  abr.evaluateMetrics({ rtt: 350, packetLoss: 0.08, droppedFrames: 10 });

  // Downgraded to LOW
  assert.equal(abr.currentLevel, 'LOW');
  assert.equal(abr.preset.fps, VIDEO_PRESETS.LOW.fps);

  // Excellent network: low RTT & 0 loss for 5 samples
  for (let i = 0; i < 5; i++) {
    abr.evaluateMetrics({ rtt: 30, packetLoss: 0, droppedFrames: 0 });
  }

  // Upgraded back to MEDIUM
  assert.equal(abr.currentLevel, 'MEDIUM');
});
