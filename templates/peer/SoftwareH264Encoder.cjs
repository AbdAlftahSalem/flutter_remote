// flutter-remote-template-version: 1
/**
 * Flutter Remote Software H.264 Encoder (CommonJS) - libx264
 */

const { BaseVideoEncoder } = require('./BaseVideoEncoder.cjs');

class SoftwareH264Encoder extends BaseVideoEncoder {
  constructor(options = {}) {
    super(Object.assign({}, options, {
      codec: 'H264',
      encoderName: 'libx264',
      isHardware: false,
    }));
  }

  buildFfmpegArgs() {
    return [
      '-loglevel', 'error',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-i', 'pipe:0',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
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
  SoftwareH264Encoder,
};
