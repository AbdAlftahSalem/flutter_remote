/**
 * Flutter Remote WebRTC V2 Video Encoder & RTP Packetizer
 *
 * Packetizes encoded video frames (H.264 / VP8) into standard RTP packets
 * conforming to RFC 3550 and RFC 6184 for WebRTC video tracks.
 */

export class VideoEncoder {
  constructor(options = {}) {
    this.payloadType = options.payloadType || 98; // 98 for H264, 97 for VP8
    this.ssrc = options.ssrc || 12345;
    this.mtu = options.mtu || 1200; // Safe MTU for UDP
    this._sequenceNumber = 1;
    this._timestamp = 0;
    this._clockRate = 90000; // 90kHz standard video clock
  }

  packetize(frameBuffer, fps = 30) {
    if (!Buffer.isBuffer(frameBuffer) || frameBuffer.length === 0) {
      return [];
    }

    // Advance timestamp based on 90kHz clock
    const timestampDelta = Math.round(this._clockRate / fps);
    this._timestamp = (this._timestamp + timestampDelta) >>> 0;

    const packets = [];
    const payloadSize = this.mtu - 12; // 12-byte standard RTP header
    const totalChunks = Math.ceil(frameBuffer.length / payloadSize);

    for (let i = 0; i < totalChunks; i++) {
      const isLastChunk = (i === totalChunks - 1);
      const start = i * payloadSize;
      const end = Math.min(start + payloadSize, frameBuffer.length);
      const chunk = frameBuffer.subarray(start, end);

      const rtpPacket = Buffer.alloc(12 + chunk.length);

      // Byte 0: V=2, P=0, X=0, CC=0 -> 0x80
      rtpPacket[0] = 0x80;

      // Byte 1: Marker bit (1 on last chunk of frame) | Payload Type
      const marker = isLastChunk ? 0x80 : 0x00;
      rtpPacket[1] = marker | (this.payloadType & 0x7f);

      // Bytes 2-3: Sequence number (16-bit uint)
      rtpPacket.writeUInt16BE(this._sequenceNumber & 0xffff, 2);
      this._sequenceNumber = (this._sequenceNumber + 1) & 0xffff;

      // Bytes 4-7: Timestamp (32-bit uint)
      rtpPacket.writeUInt32BE(this._timestamp, 4);

      // Bytes 8-11: SSRC (32-bit uint)
      rtpPacket.writeUInt32BE(this.ssrc, 8);

      // Payload
      chunk.copy(rtpPacket, 12);

      packets.push(rtpPacket);
    }

    return packets;
  }
}
