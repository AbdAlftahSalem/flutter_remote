/**
 * Flutter Remote H.264 Encoder Capability Detector
 *
 * Probes runtime environment (macOS ARM64 vs Linux vs Windows) using FFmpeg CLI
 * to discover whether Apple VideoToolbox hardware acceleration is available.
 *
 * CRITICAL RULE: VideoToolbox is not marked AVAILABLE merely because it is listed
 * in `ffmpeg -encoders`. A real test frame encode probe is executed and verified.
 *
 * Selection order:
 *   1. Preferred: h264_videotoolbox (hardware Apple Silicon / Intel macOS, verified at runtime)
 *   2. Fallback:  libx264 (software ultrafast zerolatency)
 */

import { execFile, spawn } from 'node:child_process';
import { logger } from '../shared/logger.js';

let cachedEncoder = null;
let probePromise = null;

/**
 * Executes a real single-frame encode probe to verify whether the specified
 * encoder genuinely produces valid H.264 output without crashing.
 *
 * @param {string} ffmpegPath
 * @param {string} encoderName
 * @param {object} options
 * @returns {Promise<{ ok: boolean, reason?: string, bytes?: number }>}
 */
export async function verifyEncoderRealRuntime(ffmpegPath = 'ffmpeg', encoderName = 'h264_videotoolbox', { timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    let timer = null;
    let proc = null;
    let resolved = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (proc && !proc.killed) {
        try { proc.kill('SIGKILL'); } catch {}
      }
    };

    const done = (result) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(result);
    };

    timer = setTimeout(() => {
      done({ ok: false, reason: `Verification timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    try {
      const args = [
        '-y',
        '-f', 'lavfi',
        '-i', 'testsrc=size=64x64:rate=30',
        '-frames:v', '1',
        '-pix_fmt', 'yuv420p',
        '-c:v', encoderName,
        '-f', 'h264',
        'pipe:1',
      ];
      proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const stdoutChunks = [];
      let stderr = '';

      proc.stdout.on('data', (d) => stdoutChunks.push(d));
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.on('error', (err) => {
        done({ ok: false, reason: err.message });
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          const lines = stderr.trim().split('\n').filter(Boolean);
          const reason = lines[lines.length - 1] || `Exit code ${code}`;
          done({ ok: false, reason });
          return;
        }

        const out = Buffer.concat(stdoutChunks);
        if (out.length === 0) {
          done({ ok: false, reason: 'Encoder exited 0 but produced 0 output bytes' });
          return;
        }

        const hasStartCode = out.includes(Buffer.from([0, 0, 0, 1])) || out.includes(Buffer.from([0, 0, 1]));
        if (!hasStartCode) {
          done({ ok: false, reason: 'Output missing valid H.264 Annex-B start codes' });
          return;
        }

        done({ ok: true, bytes: out.length });
      });
    } catch (err) {
      done({ ok: false, reason: err.message });
    }
  });
}

export async function detectH264Encoder(ffmpegPath = 'ffmpeg', { timeoutMs = 10000, verifyHardware = true } = {}) {
  if (cachedEncoder) {
    return cachedEncoder;
  }

  if (probePromise) {
    return probePromise;
  }

  probePromise = (async () => {
    try {
      const stdout = await new Promise((resolve) => {
        execFile(ffmpegPath, ['-encoders'], { timeout: timeoutMs }, (err, out) => {
          if (err || !out) resolve(null);
          else resolve(out);
        });
      });

      if (!stdout) {
        logger.warn('encoder.probe_failed', { fallback: 'libx264' });
        cachedEncoder = {
          name: 'libx264',
          isHardware: false,
          codec: 'H264',
          verified: false,
          description: 'Software libx264 fallback',
        };
        return cachedEncoder;
      }

      const lines = stdout.split('\n');
      const hasVideoToolbox = lines.some(
        (line) => line.includes('h264_videotoolbox') && /^\s*V/i.test(line)
      );

      if (hasVideoToolbox && process.platform === 'darwin') {
        if (verifyHardware) {
          const check = await verifyEncoderRealRuntime(ffmpegPath, 'h264_videotoolbox', { timeoutMs });
          if (check.ok) {
            logger.info('encoder.detected_and_verified', { encoder: 'h264_videotoolbox', type: 'hardware' });
            cachedEncoder = {
              name: 'h264_videotoolbox',
              isHardware: true,
              codec: 'H264',
              verified: true,
              description: 'Apple VideoToolbox Hardware H.264 Encoder (Runtime Verified)',
            };
            return cachedEncoder;
          } else {
            logger.warn('encoder.hardware_verification_failed', {
              encoder: 'h264_videotoolbox',
              reason: check.reason,
              fallback: 'libx264',
            });
            cachedEncoder = {
              name: 'libx264',
              isHardware: false,
              codec: 'H264',
              verified: false,
              hardwareUnavailableReason: check.reason,
              description: `Software libx264 fallback (VideoToolbox unverified: ${check.reason})`,
            };
            return cachedEncoder;
          }
        } else {
          cachedEncoder = {
            name: 'h264_videotoolbox',
            isHardware: true,
            codec: 'H264',
            verified: false,
            description: 'Apple VideoToolbox Hardware H.264 Encoder (Unverified)',
          };
          return cachedEncoder;
        }
      }

      logger.info('encoder.detected', { encoder: 'libx264', type: 'software' });
      cachedEncoder = {
        name: 'libx264',
        isHardware: false,
        codec: 'H264',
        verified: true,
        description: 'Software libx264 ultrafast/zerolatency',
      };
      return cachedEncoder;
    } catch (err) {
      cachedEncoder = {
        name: 'libx264',
        isHardware: false,
        codec: 'H264',
        verified: false,
        description: 'Software libx264 fallback',
      };
      return cachedEncoder;
    } finally {
      probePromise = null;
    }
  })();

  return probePromise;
}

export function resetEncoderDetectionCache() {
  cachedEncoder = null;
  probePromise = null;
}
