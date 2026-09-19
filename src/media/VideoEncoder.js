/**
 * Flutter Remote WebRTC V2 Real Video Encoder & RFC 6184 H.264 Packetizer
 *
 * Provides genuine H.264 video encoding:
 *   1. Real H.264 video encoding from image frames (JPEG / MJPEG) using FFmpeg (libx264 zerolatency).
 *   2. Annex-B NAL unit parsing (3-byte & 4-byte start codes).
 *   3. SPS (type 7) and PPS (type 8) parameter set extraction & caching.
 *   4. IDR keyframe (type 5) caching for instantaneous client playback (< 2s).
 *   5. RFC 6184 RTP packetization (Single NAL & FU-A fragmentation) for WebRTC video tracks.
 */

import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

export const NAL_TYPES = {
  NON_IDR: 1,
  IDR: 5,
  SEI: 6,
  SPS: 7,
  PPS: 8,
  FU_A: 28,
};

let resolvedFfmpegPath = null;
try {
  // Dynamically resolve ffmpeg-static if installed
  const ffmpegStatic = await import('ffmpeg-static');
  resolvedFfmpegPath = ffmpegStatic.default || ffmpegStatic;
} catch {
  resolvedFfmpegPath = 'ffmpeg';
}

export class VideoEncoder extends EventEmitter {
  constructor(options = {}) {
    super();
    this.payloadType = options.payloadType || 98; // 98 for H.264
    this.ssrc = options.ssrc || 12345;
    this.mtu = options.mtu || 1200; // Safe MTU for UDP
    this.fps = options.fps || 30;
    this.bitrateKbps = options.bitrateKbps || 2500;
    this.ffmpegPath = options.ffmpegPath || resolvedFfmpegPath;

    this._sequenceNumber = 1;
    this._timestamp = 0;
    this._clockRate = 90000; // 90kHz standard video clock

    // Caches
    this.cachedSps = null;
    this.cachedPps = null;
    this.cachedKeyframe = null;
    this.lastFrameType = null;

    // FFmpeg process
    this.ffmpegProc = null;
    this._nalBuffer = Buffer.alloc(0);
    this._isEncoding = false;
  }

  /**
   * Starts the continuous background FFmpeg H.264 encoding process.
   */
  start() {
    if (this.ffmpegProc) return;

    const args = [
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
      '-keyint_min', String(this.fps),
      '-b:v', `${this.bitrateKbps}k`,
      '-maxrate', `${this.bitrateKbps}k`,
      '-bufsize', `${this.bitrateKbps * 2}k`,
      '-f', 'h264',
      'pipe:1',
    ];

    try {
      this.ffmpegProc = spawn(this.ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      this._isEncoding = true;

      this.ffmpegProc.stdout.on('data', (chunk) => {
        this._handleEncodedData(chunk);
      });

      this.ffmpegProc.stderr.on('data', (errData) => {
        const msg = errData.toString();
        if (!msg.includes('deprecated') && !msg.includes('EOI missing')) {
          this.emit('encoder_warning', msg);
        }
      });

      this.ffmpegProc.on('error', (err) => {
        this.emit('encoder_error', err);
        this.close();
      });

      this.ffmpegProc.on('close', (code) => {
        this._isEncoding = false;
        this.ffmpegProc = null;
        this.emit('encoder_closed', code);
      });
    } catch (err) {
      this.emit('encoder_error', err);
      this._isEncoding = false;
    }
  }

  /**
   * Encodes an incoming JPEG frame into H.264.
   */
  encodeFrame(jpegBuffer) {
    if (!this.ffmpegProc || !this.ffmpegProc.stdin || !this.ffmpegProc.stdin.writable) {
      this.start();
    }

    if (this.ffmpegProc && this.ffmpegProc.stdin && this.ffmpegProc.stdin.writable) {
      try {
        this.ffmpegProc.stdin.write(jpegBuffer);
        return true;
      } catch (err) {
        this.emit('encoder_error', err);
        return false;
      }
    }
    return false;
  }

  /**
   * Internal handler for raw Annex-B H.264 data from FFmpeg stdout.
   */
  _handleEncodedData(chunk) {
    this._nalBuffer = Buffer.concat([this._nalBuffer, chunk]);

    // Check if we have complete NAL units
    const nalUnits = this.parseNalUnits(this._nalBuffer);
    if (nalUnits.length > 1) {
      // All except possibly the last NAL are complete
      const completeNals = nalUnits.slice(0, -1);
      this.inspectAndCacheNals(completeNals);

      const packets = this.packetizeNalUnits(completeNals, this.fps);
      if (packets.length > 0) {
        this.emit('packets', packets);
      }

      // Retain remainder in buffer
      const lastNal = nalUnits[nalUnits.length - 1];
      const prefix = Buffer.from([0x00, 0x00, 0x00, 0x01]);
      this._nalBuffer = Buffer.concat([prefix, lastNal.data]);
    }
  }

  /**
   * Parses an Annex-B byte buffer into individual NAL units.
   * Recognizes both 3-byte (0x000001) and 4-byte (0x00000001) start codes.
   */
  parseNalUnits(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return [];
    }

    const nalUnits = [];
    const len = buffer.length;
    const startIndices = [];

    for (let i = 0; i < len - 2; i++) {
      if (buffer[i] === 0x00 && buffer[i + 1] === 0x00) {
        if (buffer[i + 2] === 0x01) {
          startIndices.push({ index: i, prefixLen: 3 });
          i += 2;
        } else if (i < len - 3 && buffer[i + 2] === 0x00 && buffer[i + 3] === 0x01) {
          startIndices.push({ index: i, prefixLen: 4 });
          i += 3;
        }
      }
    }

    if (startIndices.length === 0) {
      const nalType = buffer[0] & 0x1f;
      return [{ data: buffer, type: nalType }];
    }

    for (let k = 0; k < startIndices.length; k++) {
      const current = startIndices[k];
      const start = current.index + current.prefixLen;
      const end = (k + 1 < startIndices.length) ? startIndices[k + 1].index : len;
      const nalData = buffer.subarray(start, end);

      if (nalData.length > 0) {
        const nalType = nalData[0] & 0x1f;
        nalUnits.push({ data: nalData, type: nalType });
      }
    }

    return nalUnits;
  }

  /**
   * Caches SPS, PPS, and IDR keyframe data from parsed NAL units.
   */
  inspectAndCacheNals(nalUnits) {
    let hasIdr = false;

    for (const nal of nalUnits) {
      if (nal.type === NAL_TYPES.SPS) {
        this.cachedSps = Buffer.from(nal.data);
      } else if (nal.type === NAL_TYPES.PPS) {
        this.cachedPps = Buffer.from(nal.data);
      } else if (nal.type === NAL_TYPES.IDR) {
        hasIdr = true;
      }
    }

    if (hasIdr) {
      this.lastFrameType = 'keyframe';
      const partsWithPrefixes = [];
      const prefix = Buffer.from([0x00, 0x00, 0x00, 0x01]);

      if (this.cachedSps) {
        partsWithPrefixes.push(prefix, this.cachedSps);
      }
      if (this.cachedPps) {
        partsWithPrefixes.push(prefix, this.cachedPps);
      }
      for (const nal of nalUnits) {
        if (nal.type === NAL_TYPES.IDR) {
          partsWithPrefixes.push(prefix, nal.data);
        }
      }

      this.cachedKeyframe = Buffer.concat(partsWithPrefixes);
    } else {
      this.lastFrameType = 'delta';
    }
  }

  hasKeyframe() {
    return Boolean(this.cachedKeyframe && this.cachedKeyframe.length > 0);
  }

  getKeyframe() {
    return this.cachedKeyframe;
  }

  /**
   * Returns RFC 6184 RTP packets for the cached keyframe.
   */
  getKeyframePackets() {
    if (!this.hasKeyframe()) return [];
    return this.packetize(this.cachedKeyframe, this.fps);
  }

  /**
   * Packetizes NAL units into RFC 6184 compliant RTP packets.
   */
  packetizeNalUnits(nalUnits, fps = 30) {
    const timestampDelta = Math.round(this._clockRate / fps);
    this._timestamp = (this._timestamp + timestampDelta) >>> 0;

    const packets = [];
    const maxPayloadSize = this.mtu - 12; // 12-byte standard RTP header

    for (let u = 0; u < nalUnits.length; u++) {
      const nal = nalUnits[u];
      const nalData = nal.data;
      const isLastNal = (u === nalUnits.length - 1);

      if (nalData.length <= maxPayloadSize) {
        // Single NAL Unit Packet (RFC 6184 Section 5.6)
        const rtp = Buffer.alloc(12 + nalData.length);
        rtp[0] = 0x80;
        rtp[1] = (isLastNal ? 0x80 : 0x00) | (this.payloadType & 0x7f);
        rtp.writeUInt16BE(this._sequenceNumber & 0xffff, 2);
        this._sequenceNumber = (this._sequenceNumber + 1) & 0xffff;
        rtp.writeUInt32BE(this._timestamp, 4);
        rtp.writeUInt32BE(this.ssrc, 8);
        nalData.copy(rtp, 12);
        packets.push(rtp);
      } else {
        // FU-A Fragmentation Units (RFC 6184 Section 5.8)
        const nalHeader = nalData[0];
        const fnri = nalHeader & 0xe0;
        const originalType = nalHeader & 0x1f;

        const fuIndicator = fnri | NAL_TYPES.FU_A;
        const payloadData = nalData.subarray(1);
        const maxFuPayload = maxPayloadSize - 2;
        const totalChunks = Math.ceil(payloadData.length / maxFuPayload);

        for (let i = 0; i < totalChunks; i++) {
          const isStart = (i === 0);
          const isEnd = (i === totalChunks - 1);
          const isLastPacketOfFrame = isLastNal && isEnd;

          let fuHeader = originalType & 0x1f;
          if (isStart) fuHeader |= 0x80;
          if (isEnd) fuHeader |= 0x40;

          const chunkStart = i * maxFuPayload;
          const chunkEnd = Math.min(chunkStart + maxFuPayload, payloadData.length);
          const chunk = payloadData.subarray(chunkStart, chunkEnd);

          const rtp = Buffer.alloc(12 + 2 + chunk.length);
          rtp[0] = 0x80;
          rtp[1] = (isLastPacketOfFrame ? 0x80 : 0x00) | (this.payloadType & 0x7f);
          rtp.writeUInt16BE(this._sequenceNumber & 0xffff, 2);
          this._sequenceNumber = (this._sequenceNumber + 1) & 0xffff;
          rtp.writeUInt32BE(this._timestamp, 4);
          rtp.writeUInt32BE(this.ssrc, 8);

          rtp[12] = fuIndicator;
          rtp[13] = fuHeader;
          chunk.copy(rtp, 14);
          packets.push(rtp);
        }
      }
    }

    return packets;
  }

  /**
   * Convenience method to parse buffer and packetize into RTP packets.
   */
  packetize(frameBuffer, fps = 30) {
    if (!Buffer.isBuffer(frameBuffer) || frameBuffer.length === 0) {
      return [];
    }
    const nalUnits = this.parseNalUnits(frameBuffer);
    if (nalUnits.length > 0) {
      this.inspectAndCacheNals(nalUnits);
    }
    const units = (nalUnits.length > 0) ? nalUnits : [{ data: frameBuffer, type: frameBuffer[0] & 0x1f }];
    return this.packetizeNalUnits(units, fps);
  }

  close() {
    this._isEncoding = false;
    if (this.ffmpegProc) {
      try {
        if (this.ffmpegProc.stdin) this.ffmpegProc.stdin.end();
        this.ffmpegProc.kill('SIGTERM');
      } catch {}
      this.ffmpegProc = null;
    }
    this._nalBuffer = Buffer.alloc(0);
  }
}
