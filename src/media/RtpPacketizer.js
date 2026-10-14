/**
 * Flutter Remote WebRTC V3 RFC 6184 H.264 RTP Packetizer
 *
 * Responsibilities:
 *   - Sequence number generation with 16-bit wrap-around
 *   - 90kHz timestamp progression per Access Unit (uniform timestamp for all packets in AU)
 *   - Stable SSRC across frame encoding and recovery
 *   - RFC 6184 FU-A fragmentation for NAL units exceeding MTU
 *   - RTP marker bit M=1 strictly on the final packet of the Access Unit
 */

export const NAL_TYPES = {
  NON_IDR: 1,
  PARTITION_A: 2,
  PARTITION_B: 3,
  PARTITION_C: 4,
  IDR: 5,
  SEI: 6,
  SPS: 7,
  PPS: 8,
  AUD: 9,
  END_SEQUENCE: 10,
  END_STREAM: 11,
  FILLER: 12,
  FU_A: 28,
};

export class RtpPacketizer {
  constructor(options = {}) {
    this.payloadType = options.payloadType ?? 98; // 98 for H.264
    this.ssrc = options.ssrc ?? 12345;
    this.mtu = options.mtu ?? 1200; // Safe MTU for UDP
    this._clockRate = options.clockRate ?? 90000; // 90kHz standard video clock

    this._sequenceNumber = options.initialSeq ?? 1;
    this._timestamp = options.initialTimestamp ?? 0;
  }

  /**
   * Advances and returns the next RTP timestamp based on clock rate and FPS.
   */
  nextRtpTimestamp(fps = 30) {
    const timestampDelta = Math.round(this._clockRate / fps);
    this._timestamp = (this._timestamp + timestampDelta) >>> 0;
    return this._timestamp;
  }

  /**
   * Current sequence number.
   */
  get sequenceNumber() {
    return this._sequenceNumber;
  }

  /**
   * Current timestamp.
   */
  get timestamp() {
    return this._timestamp;
  }

  /**
   * Packetizes an entire Access Unit (group of NAL units for one frame) into RTP packets.
   *
   * Invariants:
   *   1. All packets within the same Access Unit share the EXACT same RTP timestamp.
   *   2. Sequence numbers are strictly incremented ((seq + 1) & 0xffff).
   *   3. Marker bit M=1 is set ONLY on the very last RTP packet of the Access Unit.
   *   4. NAL units larger than MTU - 12 are fragmented using RFC 6184 FU-A.
   */
  packetizeAccessUnit(accessUnitNals, fps = 30) {
    if (!Array.isArray(accessUnitNals) || accessUnitNals.length === 0) {
      return [];
    }

    const frameTimestamp = this.nextRtpTimestamp(fps);
    const packets = [];
    const maxPayloadSize = this.mtu - 12; // 12-byte RTP header

    for (let u = 0; u < accessUnitNals.length; u++) {
      const nal = accessUnitNals[u];
      const nalData = nal.data;
      const isLastNalOfAU = (u === accessUnitNals.length - 1);

      if (nalData.length <= maxPayloadSize) {
        // Single NAL unit packet
        const isLastPacketOfAU = isLastNalOfAU;
        const rtp = Buffer.alloc(12 + nalData.length);

        // V=2, P=0, X=0, CC=0
        rtp[0] = 0x80;
        // M bit (0x80 if last packet of AU, 0x00 otherwise) | PayloadType (7 bits)
        rtp[1] = (isLastPacketOfAU ? 0x80 : 0x00) | (this.payloadType & 0x7f);
        // Sequence Number (16-bit BE)
        rtp.writeUInt16BE(this._sequenceNumber & 0xffff, 2);
        this._sequenceNumber = (this._sequenceNumber + 1) & 0xffff;
        // Timestamp (32-bit BE)
        rtp.writeUInt32BE(frameTimestamp, 4);
        // SSRC (32-bit BE)
        rtp.writeUInt32BE(this.ssrc, 8);
        // NAL Payload
        nalData.copy(rtp, 12);

        rtp.timestamp = frameTimestamp;
        rtp.marker = isLastPacketOfAU ? 1 : 0;
        packets.push(rtp);
      } else {
        // RFC 6184 FU-A Fragmentation
        const nalHeader = nalData[0];
        const fnri = nalHeader & 0xe0; // Forbidden bit (1) + NRI (2)
        const originalType = nalHeader & 0x1f;

        const fuIndicator = fnri | NAL_TYPES.FU_A; // Type 28
        const payloadData = nalData.subarray(1); // Strip NAL header byte
        const maxFuPayload = maxPayloadSize - 2; // 2 bytes for FU indicator + FU header
        const totalChunks = Math.ceil(payloadData.length / maxFuPayload);

        for (let i = 0; i < totalChunks; i++) {
          const isStart = (i === 0);
          const isEnd = (i === totalChunks - 1);
          const isLastPacketOfAU = isLastNalOfAU && isEnd;

          // FU Header: S (1 bit), E (1 bit), R (1 bit = 0), Type (5 bits)
          let fuHeader = originalType & 0x1f;
          if (isStart) fuHeader |= 0x80;
          if (isEnd) fuHeader |= 0x40;

          const chunkStart = i * maxFuPayload;
          const chunkEnd = Math.min(chunkStart + maxFuPayload, payloadData.length);
          const chunk = payloadData.subarray(chunkStart, chunkEnd);

          const rtp = Buffer.alloc(12 + 2 + chunk.length);

          // V=2
          rtp[0] = 0x80;
          // Marker bit: M=1 strictly on the last packet of the entire AU
          rtp[1] = (isLastPacketOfAU ? 0x80 : 0x00) | (this.payloadType & 0x7f);
          // Sequence Number
          rtp.writeUInt16BE(this._sequenceNumber & 0xffff, 2);
          this._sequenceNumber = (this._sequenceNumber + 1) & 0xffff;
          // Timestamp
          rtp.writeUInt32BE(frameTimestamp, 4);
          // SSRC
          rtp.writeUInt32BE(this.ssrc, 8);

          // FU-A Headers
          rtp[12] = fuIndicator;
          rtp[13] = fuHeader;
          chunk.copy(rtp, 14);

          rtp.timestamp = frameTimestamp;
          rtp.marker = isLastPacketOfAU ? 1 : 0;
          packets.push(rtp);
        }
      }
    }

    return packets;
  }

  reset() {
    this._sequenceNumber = 1;
    this._timestamp = 0;
  }
}
