import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { detectH264Encoder } from '../src/media/EncoderDetector.js';
import { BaseVideoEncoder } from '../src/media/BaseVideoEncoder.js';
import { HardwareH264Encoder } from '../src/media/HardwareH264Encoder.js';
import { SoftwareH264Encoder } from '../src/media/SoftwareH264Encoder.js';
import { createVideoEncoder, VideoEncoder } from '../src/media/VideoEncoder.js';

const require = createRequire(import.meta.url);

test('Phase 22: detectH264Encoder parses ffmpeg encoders output correctly', async () => {
  // Test detection with active environment ffmpeg
  const detected = await detectH264Encoder();
  assert.ok(detected.name, 'Detected encoder must have a name');
  assert.ok(['h264_videotoolbox', 'libx264'].includes(detected.name));
  assert.equal(typeof detected.isHardware, 'boolean');
  assert.equal(detected.codec, 'H264');
  assert.ok(typeof detected.description === 'string');
});

test('Phase 22: HardwareH264Encoder configuration and ffmpeg CLI flags', () => {
  const encoder = new HardwareH264Encoder({
    fps: 30,
    bitrateKbps: 3000,
    width: 720,
    height: 1280,
  });

  assert.equal(encoder.isHardware, true);
  assert.equal(encoder.encoderName, 'h264_videotoolbox');
  assert.equal(encoder.codec, 'H264');
  assert.equal(encoder.bitrateKbps, 3000);

  const args = encoder.buildFfmpegArgs();
  assert.ok(Array.isArray(args));

  // Check required VideoToolbox arguments
  assert.ok(args.includes('h264_videotoolbox'), 'Must specify h264_videotoolbox encoder');
  assert.ok(args.includes('-realtime'), 'Must pass -realtime flag');
  const realtimeIdx = args.indexOf('-realtime');
  assert.equal(args[realtimeIdx + 1], '1');

  // Must use yuv420p for standard WebRTC browser decode compatibility
  const pixFmtIdx = args.indexOf('-pix_fmt');
  assert.ok(pixFmtIdx !== -1);
  assert.equal(args[pixFmtIdx + 1], 'yuv420p');

  // Must force IDR and AUD for WebRTC RTP streaming
  assert.ok(args.includes('-forced-idr'));
  assert.ok(args.includes('-aud'));

  // CRITICAL: Must NOT contain libx264-specific flags that break VideoToolbox
  assert.ok(!args.includes('-preset'), 'Hardware encoder must not pass -preset');
  assert.ok(!args.includes('-tune'), 'Hardware encoder must not pass -tune');
});

test('Phase 22: SoftwareH264Encoder configuration and ffmpeg CLI flags', () => {
  const encoder = new SoftwareH264Encoder({
    fps: 30,
    bitrateKbps: 2000,
    width: 720,
    height: 1280,
  });

  assert.equal(encoder.isHardware, false);
  assert.equal(encoder.encoderName, 'libx264');
  assert.equal(encoder.codec, 'H264');

  const args = encoder.buildFfmpegArgs();
  assert.ok(Array.isArray(args));

  // Check required libx264 zerolatency arguments
  assert.ok(args.includes('libx264'), 'Must specify libx264 encoder');
  const presetIdx = args.indexOf('-preset');
  assert.ok(presetIdx !== -1);
  assert.equal(args[presetIdx + 1], 'ultrafast');

  const tuneIdx = args.indexOf('-tune');
  assert.ok(tuneIdx !== -1);
  assert.equal(args[tuneIdx + 1], 'zerolatency');

  // Verify bitrate flags
  assert.ok(args.includes('-b:v'));
  const bIdx = args.indexOf('-b:v');
  assert.equal(args[bIdx + 1], '2000k');
});

test('Phase 22: createVideoEncoder factory resolves appropriate encoder class', async () => {
  const hw = await createVideoEncoder({ encoderName: 'h264_videotoolbox' });
  assert.ok(hw instanceof HardwareH264Encoder);
  assert.equal(hw.isHardware, true);

  const sw = await createVideoEncoder({ encoderName: 'libx264' });
  assert.ok(sw instanceof SoftwareH264Encoder);
  assert.equal(sw.isHardware, false);

  const auto = await createVideoEncoder({ encoderName: 'auto' });
  assert.ok(auto instanceof BaseVideoEncoder);
});

test('Phase 22: VideoEncoder CommonJS templates mirror ESM functionality', async () => {
  const cjsVideoEncoder = require('../templates/peer/VideoEncoder.cjs');
  const cjsDetector = require('../templates/peer/EncoderDetector.cjs');
  const cjsBase = require('../templates/peer/BaseVideoEncoder.cjs');
  const cjsHw = require('../templates/peer/HardwareH264Encoder.cjs');
  const cjsSw = require('../templates/peer/SoftwareH264Encoder.cjs');

  assert.ok(cjsVideoEncoder.VideoEncoder);
  assert.ok(cjsVideoEncoder.BaseVideoEncoder);
  assert.ok(cjsVideoEncoder.HardwareH264Encoder);
  assert.ok(cjsVideoEncoder.SoftwareH264Encoder);
  assert.ok(cjsVideoEncoder.createVideoEncoder);
  assert.ok(cjsDetector.detectH264Encoder);

  const hw = new cjsHw.HardwareH264Encoder({ fps: 30, bitrateKbps: 2500 });
  assert.equal(hw.isHardware, true);
  assert.equal(hw.encoderName, 'h264_videotoolbox');
  const hwArgs = hw.buildFfmpegArgs();
  assert.ok(hwArgs.includes('h264_videotoolbox'));
  assert.ok(!hwArgs.includes('-preset'));

  const sw = new cjsSw.SoftwareH264Encoder({ fps: 30, bitrateKbps: 2500 });
  assert.equal(sw.isHardware, false);
  assert.equal(sw.encoderName, 'libx264');
  const swArgs = sw.buildFfmpegArgs();
  assert.ok(swArgs.includes('libx264'));
  assert.ok(swArgs.includes('-preset'));

  const createdSw = await cjsVideoEncoder.createVideoEncoder({ encoderName: 'libx264' });
  assert.ok(createdSw instanceof cjsSw.SoftwareH264Encoder);
});
