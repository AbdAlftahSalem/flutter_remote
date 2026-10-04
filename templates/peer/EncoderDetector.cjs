// flutter-remote-template-version: 1
/**
 * Flutter Remote H.264 Encoder Capability Detector (CommonJS)
 *
 * Probes runtime environment (macOS ARM64 vs Linux vs Windows) using FFmpeg CLI
 * to discover whether Apple VideoToolbox hardware acceleration is available.
 *
 * Selection order:
 *   1. Preferred: h264_videotoolbox (hardware Apple Silicon / Intel macOS)
 *   2. Fallback:  libx264 (software ultrafast zerolatency)
 */

const { execFile } = require('node:child_process');

let cachedEncoder = null;
let probePromise = null;

function detectH264Encoder(ffmpegPath = 'ffmpeg', { timeoutMs = 3000 } = {}) {
  if (cachedEncoder) {
    return Promise.resolve(cachedEncoder);
  }

  if (probePromise) {
    return probePromise;
  }

  probePromise = new Promise((resolve) => {
    try {
      execFile(ffmpegPath, ['-encoders'], { timeout: timeoutMs }, (err, stdout) => {
        probePromise = null;
        if (err || !stdout) {
          console.warn('[encoder] probe failed, falling back to libx264:', err ? err.message : 'no stdout');
          cachedEncoder = {
            name: 'libx264',
            isHardware: false,
            codec: 'H264',
            description: 'Software libx264 fallback',
          };
          resolve(cachedEncoder);
          return;
        }

        const lines = stdout.split('\n');
        const hasVideoToolbox = lines.some(
          (line) => line.includes('h264_videotoolbox') && /^\s*V/i.test(line)
        );

        if (hasVideoToolbox && process.platform === 'darwin') {
          console.log('[encoder] detected hardware acceleration: h264_videotoolbox');
          cachedEncoder = {
            name: 'h264_videotoolbox',
            isHardware: true,
            codec: 'H264',
            description: 'Apple VideoToolbox Hardware H.264 Encoder',
          };
        } else {
          console.log('[encoder] using software encoder: libx264');
          cachedEncoder = {
            name: 'libx264',
            isHardware: false,
            codec: 'H264',
            description: 'Software libx264 ultrafast/zerolatency',
          };
        }

        resolve(cachedEncoder);
      });
    } catch (err) {
      probePromise = null;
      cachedEncoder = {
        name: 'libx264',
        isHardware: false,
        codec: 'H264',
        description: 'Software libx264 fallback',
      };
      resolve(cachedEncoder);
    }
  });

  return probePromise;
}

function resetEncoderDetectionCache() {
  cachedEncoder = null;
  probePromise = null;
}

module.exports = {
  detectH264Encoder,
  resetEncoderDetectionCache,
};
