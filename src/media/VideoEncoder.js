/**
 * Flutter Remote WebRTC V2 Video Encoder & RFC 6184 H.264 RTP Packetizer
 *
 * Provides real H.264 NAL unit parsing, SPS/PPS extraction, IDR keyframe caching,
 * and RFC 6184 (Single NAL & FU-A Fragmentation) RTP packetization for WebRTC video tracks.
 */

export const NAL_TYPES = {
  NON_IDR: 1,
  IDR: 5,
  SEI: 6,
  SPS: 7,
  PPS: 8,
  FU_A: 28,
};

export class VideoEncoder {
  constructor(options = {}) {
    this.payloadType = options.payloadType || 98; // 98 for H.264
    this.ssrc = options.ssrc || 12345;
    this.mtu = options.mtu || 1200; // Safe MTU for UDP
    this._sequenceNumber = 1;
    this._timestamp = 0;
    this._clockRate = 90000; // 90kHz standard video clock

    // Keyframe and parameter set caches
    this.cachedSps = null;
    this.cachedPps = null;
    this.cachedKeyframe = null;
    this.lastFrameType = null;
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
    let startIndices = [];

    // Find all start code indices
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
      // Buffer does not have start codes, return as a single raw NAL unit
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
    let fullKeyframeParts = [];

    for (const nal of nalUnits) {
      if (nal.type === NAL_TYPES.SPS) {
        this.cachedSps = Buffer.from(nal.data);
        fullKeyframeParts.push(nal.data);
      } else if (nal.type === NAL_TYPES.PPS) {
        this.cachedPps = Buffer.from(nal.data);
        fullKeyframeParts.push(nal.data);
      } else if (nal.type === NAL_TYPES.IDR) {
        hasIdr = true;
        fullKeyframeParts.push(nal.data);
      }
    }

    if (hasIdr) {
      this.lastFrameType = 'keyframe';
      // Build Annex-B keyframe with SPS, PPS, and IDR
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

  /**
   * Returns the cached keyframe (SPS + PPS + IDR) for immediate injection
   * to new subscribers or upon reconnect.
   */
  getKeyframe() {
    return this.cachedKeyframe;
  }

  hasKeyframe() {
    return Boolean(this.cachedKeyframe && this.cachedKeyframe.length > 0);
  }

  /**
   * Packetizes an H.264 frame into RFC 6184 compliant RTP packets.
   * Supports Single NAL Unit packets and FU-A fragmentation for packets > MTU.
   */
  packetize(frameBuffer, fps = 30) {
    if (!Buffer.isBuffer(frameBuffer) || frameBuffer.length === 0) {
      return [];
    }

    // Advance 90kHz timestamp
    const timestampDelta = Math.round(this._clockRate / fps);
    this._timestamp = (this._timestamp + timestampDelta) >>> 0;

    const nalUnits = this.parseNalUnits(frameBuffer);
    if (nalUnits.length > 0) {
      this.inspectAndCacheNals(nalUnits);
    }

    const packets = [];
    const maxPayloadSize = this.mtu - 12; // 12-byte standard RTP header

    // If frameBuffer didn't contain Annex-B start codes, treat as single NAL or payload
    const unitsToPacketize = (nalUnits.length > 0) ? nalUnits : [{ data: frameBuffer, type: frameBuffer[0] & 0x1f }];

    for (let u = 0; u < unitsToPacketize.length; u++) {
      const nal = unitsToPacketize[u];
      const nalData = nal.data;
      const isLastNal = (u === unitsToPacketize.length - 1);

      if (nalData.length <= maxPayloadSize) {
        // --- Single NAL Unit Packet (RFC 6184 Section 5.6) ---
        const rtp = Buffer.alloc(12 + nalData.length);
        rtp[0] = 0x80; // V=2, P=0, X=0, CC=0
        rtp[1] = (isLastNal ? 0x80 : 0x00) | (this.payloadType & 0x7f); // Marker bit on last NAL of frame
        rtp.writeUInt16BE(this._sequenceNumber & 0xffff, 2);
        this._sequenceNumber = (this._sequenceNumber + 1) & 0xffff;
        rtp.writeUInt32BE(this._timestamp, 4);
        rtp.writeUInt32BE(this.ssrc, 8);
        nalData.copy(rtp, 12);
        packets.push(rtp);
      } else {
        // --- FU-A Fragmentation Units (RFC 6184 Section 5.8) ---
        const nalHeader = nalData[0];
        const fnri = nalHeader & 0xe0; // F (1 bit) + NRI (2 bits)
        const originalType = nalHeader & 0x1f;

        const fuIndicator = fnri | NAL_TYPES.FU_A; // Payload Type = 28 (FU-A)
        const payloadData = nalData.subarray(1); // NAL payload without original NAL header
        const maxFuPayload = maxPayloadSize - 2; // 2 bytes for FU indicator + FU header
        const totalChunks = Math.ceil(payloadData.length / maxFuPayload);

        for (let i = 0; i < totalChunks; i++) {
          const isStart = (i === 0);
          const isEnd = (i === totalChunks - 1);
          const isLastPacketOfFrame = isLastNal && isEnd;

          let fuHeader = originalType & 0x1f;
          if (isStart) fuHeader |= 0x80; // S bit = 1
          if (isEnd) fuHeader |= 0x40;   // E bit = 1

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

          // FU indicator + FU header
          rtp[12] = fuIndicator;
          rtp[13] = fuHeader;

          // Payload chunk
          chunk.copy(rtp, 14);
          packets.push(rtp);
        }
      }
    }

    return packets;
  }
}
