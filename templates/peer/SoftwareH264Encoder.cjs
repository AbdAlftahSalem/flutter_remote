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
    const scaleFilter = (this.width && this.height && (this.width !== 720 || this.height !== 1280))
      ? `scale=${this.width}:${this.height}`
      : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
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
      // Every IDR must be independently decodable after loss or a late join.
      // Without repeated parameter sets, a browser can remain black until an
      // encoder restart happens to emit a new SPS/PPS pair.
      '-x264-params', 'repeat-headers=1:scenecut=0',
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
