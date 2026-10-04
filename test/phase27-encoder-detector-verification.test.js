import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyEncoderRealRuntime, detectH264Encoder, resetEncoderDetectionCache } from '../src/media/EncoderDetector.js';
import {
  verifyEncoderRealRuntime as verifyEncoderRealRuntimeCjs,
  detectH264Encoder as detectH264EncoderCjs,
  resetEncoderDetectionCache as resetEncoderDetectionCacheCjs,
} from '../templates/peer/EncoderDetector.cjs';
import { HardwareH264Encoder } from '../src/media/HardwareH264Encoder.js';

let ffmpegBin = 'ffmpeg';
try {
  const ffmpegStatic = await import('ffmpeg-static');
  ffmpegBin = ffmpegStatic.default || ffmpegStatic || 'ffmpeg';
} catch {}

for (const [suiteName, verifyFn, detectFn, resetFn] of [
  ['ESM EncoderDetector', verifyEncoderRealRuntime, detectH264Encoder, resetEncoderDetectionCache],
  ['CJS EncoderDetector', verifyEncoderRealRuntimeCjs, detectH264EncoderCjs, resetEncoderDetectionCacheCjs],
]) {
  test(`${suiteName}: verifyEncoderRealRuntime succeeds for valid encoder libx264`, async () => {
    const res = await verifyFn(ffmpegBin, 'libx264', { timeoutMs: 5000 });
    assert.equal(res.ok, true, `Verification should succeed: ${res.reason}`);
    assert.ok(res.bytes > 0, 'Should produce output bytes');
  });

  test(`${suiteName}: verifyEncoderRealRuntime fails gracefully for unsupported encoder`, async () => {
    const res = await verifyFn(ffmpegBin, 'non_existent_fake_encoder', { timeoutMs: 3000 });
    assert.equal(res.ok, false);
    assert.ok(res.reason, 'Should report failure reason');
  });

  test(`${suiteName}: detectH264Encoder returns truthful result without faking VideoToolbox`, async () => {
    resetFn();
    const detected = await detectFn(ffmpegBin, { verifyHardware: true });
    assert.ok(detected.name);
    if (process.platform === 'darwin') {
      // On macOS, if isHardware is true, verified must be true!
      if (detected.isHardware) {
        assert.equal(detected.verified, true);
        assert.equal(detected.name, 'h264_videotoolbox');
      }
    } else {
      assert.equal(detected.isHardware, false, 'Non-macOS platforms must not report hardware VideoToolbox');
      assert.equal(detected.name, 'libx264');
    }
  });
}

test('HardwareH264Encoder: falls back to libx264 args if hardware fails or is disabled', () => {
  const enc = new HardwareH264Encoder({ fps: 30, bitrateKbps: 2000 });
  assert.equal(enc.isHardware, true);
  const hwArgs = enc.buildFfmpegArgs();
  assert.ok(hwArgs.includes('h264_videotoolbox'));

  // When marked as non-hardware
  enc.isHardware = false;
  enc.encoderName = 'libx264';
  const swArgs = enc.buildFfmpegArgs();
  assert.ok(swArgs.includes('libx264'));
  assert.ok(swArgs.includes('ultrafast'));
  assert.ok(!swArgs.includes('h264_videotoolbox'));
});
