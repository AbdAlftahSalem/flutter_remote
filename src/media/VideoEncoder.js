/**
 * Flutter Remote WebRTC Video Encoder
 *
 * Extends BaseVideoEncoder and selects between Hardware (VideoToolbox) and
 * Software (libx264) based on runtime detection or explicit configuration.
 */

import { BaseVideoEncoder, NAL_TYPES, RECOVERY_STATES } from './BaseVideoEncoder.js';
import { HardwareH264Encoder } from './HardwareH264Encoder.js';
import { SoftwareH264Encoder } from './SoftwareH264Encoder.js';
import { detectH264Encoder } from './EncoderDetector.js';

export {
  NAL_TYPES,
  RECOVERY_STATES,
  BaseVideoEncoder,
  HardwareH264Encoder,
  SoftwareH264Encoder,
  detectH264Encoder,
};

let resolvedFfmpegPath = null;
try {
  const ffmpegStatic = await import('ffmpeg-static');
  resolvedFfmpegPath = ffmpegStatic.default || ffmpegStatic;
} catch {
  resolvedFfmpegPath = 'ffmpeg';
}

export async function createVideoEncoder(options = {}) {
  let encoderName = options.encoderName || options.encoder;
  if (!encoderName || encoderName === 'auto') {
    const detected = await detectH264Encoder(options.ffmpegPath || resolvedFfmpegPath);
    encoderName = detected.name;
  }
  if (encoderName === 'h264_videotoolbox') {
    return new HardwareH264Encoder({ ...options, ffmpegPath: options.ffmpegPath || resolvedFfmpegPath });
  }
  return new SoftwareH264Encoder({ ...options, ffmpegPath: options.ffmpegPath || resolvedFfmpegPath });
}

export class VideoEncoder extends BaseVideoEncoder {
  constructor(options = {}) {
    const encoderName = options.encoderName || (options.isHardware ? 'h264_videotoolbox' : 'libx264');
    super({
      ...options,
      encoderName,
      isHardware: encoderName === 'h264_videotoolbox',
      ffmpegPath: options.ffmpegPath || resolvedFfmpegPath,
    });
  }

  buildFfmpegArgs() {
    const scaleFilter = (this.width && this.height && (this.width !== 720 || this.height !== 1280))
      ? `scale=${this.width}:${this.height}`
      : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';

    if (this.encoderName === 'h264_videotoolbox') {
      return [
        '-loglevel', 'error',
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-i', 'pipe:0',
        '-vf', scaleFilter,
        '-c:v', 'h264_videotoolbox',
        '-realtime', '1',
        '-pix_fmt', 'yuv420p',
        '-g', String(this.fps),
        '-forced-idr', '1',
        '-aud', '1',
        '-b:v', `${this.bitrateKbps}k`,
        '-maxrate', `${this.bitrateKbps}k`,
        '-bufsize', `${this.bitrateKbps * 2}k`,
        '-f', 'h264',
        'pipe:1',
      ];
    }

    return [
      '-loglevel', 'error',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-i', 'pipe:0',
      '-vf', scaleFilter,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-pix_fmt', 'yuv420p',
      '-g', String(this.fps),
      '-keyint_min', '1',
      '-forced-idr', '1',
      '-aud', '1',
      '-b:v', `${this.bitrateKbps}k`,
      '-maxrate', `${this.bitrateKbps}k`,
      '-bufsize', `${this.bitrateKbps * 2}k`,
      '-f', 'h264',
      'pipe:1',
    ];
  }
}
