// flutter-remote-template-version: 6
/**
 * Flutter Remote WebRTC Video Encoder (CommonJS)
 *
 * For standalone remote runner execution.
 * Extends BaseVideoEncoder and selects between Hardware (VideoToolbox) and
 * Software (libx264) based on runtime detection or explicit configuration.
 */

const { BaseVideoEncoder, NAL_TYPES, RECOVERY_STATES } = require('./BaseVideoEncoder.cjs');
const { HardwareH264Encoder } = require('./HardwareH264Encoder.cjs');
const { SoftwareH264Encoder } = require('./SoftwareH264Encoder.cjs');
const { detectH264Encoder } = require('./EncoderDetector.cjs');

let ffmpegPath = 'ffmpeg';
try {
  ffmpegPath = require('ffmpeg-static') || 'ffmpeg';
} catch {}

async function createVideoEncoder(options = {}) {
  let encoderName = options.encoderName || options.encoder;
  if (!encoderName || encoderName === 'auto') {
    const detected = await detectH264Encoder(options.ffmpegPath || ffmpegPath);
    encoderName = detected.name;
  }
  if (encoderName === 'h264_videotoolbox') {
    return new HardwareH264Encoder(Object.assign({}, options, { ffmpegPath: options.ffmpegPath || ffmpegPath }));
  }
  return new SoftwareH264Encoder(Object.assign({}, options, { ffmpegPath: options.ffmpegPath || ffmpegPath }));
}

class VideoEncoder extends BaseVideoEncoder {
  constructor(options = {}) {
    const encoderName = options.encoderName || (options.isHardware ? 'h264_videotoolbox' : 'libx264');
    super(Object.assign({}, options, {
      encoderName,
      isHardware: encoderName === 'h264_videotoolbox',
      ffmpegPath: options.ffmpegPath || ffmpegPath,
    }));
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

module.exports = {
  NAL_TYPES,
  RECOVERY_STATES,
  VideoEncoder,
  BaseVideoEncoder,
  HardwareH264Encoder,
  SoftwareH264Encoder,
  detectH264Encoder,
  createVideoEncoder,
};
