/**
 * Flutter Remote H.264 Encoder Capability Detector
 *
 * Probes runtime environment (macOS ARM64 vs Linux vs Windows) using FFmpeg CLI
 * to discover whether Apple VideoToolbox hardware acceleration is available.
 *
 * Selection order:
 *   1. Preferred: h264_videotoolbox (hardware Apple Silicon / Intel macOS)
 *   2. Fallback:  libx264 (software ultrafast zerolatency)
 */

import { execFile } from 'node:child_process';
import { logger } from '../shared/logger.js';

let cachedEncoder = null;
let probePromise = null;

export async function detectH264Encoder(ffmpegPath = 'ffmpeg', { timeoutMs = 3000 } = {}) {
  if (cachedEncoder) {
    return cachedEncoder;
  }

  if (probePromise) {
    return probePromise;
  }

  probePromise = new Promise((resolve) => {
    try {
      execFile(ffmpegPath, ['-encoders'], { timeout: timeoutMs }, (err, stdout) => {
        probePromise = null;
        if (err || !stdout) {
          logger.warn('encoder.probe_failed', { error: err?.message, fallback: 'libx264' });
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
          logger.info('encoder.detected', { encoder: 'h264_videotoolbox', type: 'hardware' });
          cachedEncoder = {
            name: 'h264_videotoolbox',
            isHardware: true,
            codec: 'H264',
            description: 'Apple VideoToolbox Hardware H.264 Encoder',
          };
        } else {
          logger.info('encoder.detected', { encoder: 'libx264', type: 'software' });
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

export function resetEncoderDetectionCache() {
  cachedEncoder = null;
  probePromise = null;
}
