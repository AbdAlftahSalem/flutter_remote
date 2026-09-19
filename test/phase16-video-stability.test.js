import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { VideoEncoder, NAL_TYPES } from '../src/media/VideoEncoder.js';

test('Test A — stdout chunk splitting: NAL bytes split across 2+ chunks', () => {
  const encoder = new VideoEncoder({ payloadType: 98, ssrc: 12345, mtu: 1200, fps: 30 });

  // Construct NAL 1 (IDR slice of 100 bytes)
  const nal1Header = Buffer.from([0x65, 0x88]); // Type 5 (IDR), byte 1 with 0x80 bit set (first_mb_in_slice = 0)
  const nal1Body = Buffer.alloc(98, 0xaa);
  const nal1Full = Buffer.concat([nal1Header, nal1Body]);

  // Construct NAL 2 (Non-IDR slice of 50 bytes)
  const nal2Header = Buffer.from([0x41, 0x88]); // Type 1 (Non-IDR), byte 1 with 0x80 bit set
  const nal2Body = Buffer.alloc(48, 0xbb);
  const nal2Full = Buffer.concat([nal2Header, nal2Body]);

  const prefix4 = Buffer.from([0x00, 0x00, 0x00, 0x01]);

  // Chunk 1: prefix + first 40 bytes of NAL 1 (incomplete NAL)
  const chunk1 = Buffer.concat([prefix4, nal1Full.subarray(0, 40)]);

  // Chunk 2: remaining 60 bytes of NAL 1 + prefix + NAL 2 (which completes NAL 1)
  const chunk2 = Buffer.concat([nal1Full.subarray(40), prefix4, nal2Full]);

  // Feed Chunk 1: Should NOT emit any Access Unit yet
  const aus1 = encoder.feedStream(chunk1);
  assert.equal(aus1.length, 0, 'Incomplete NAL 1 must not be emitted');
  assert.ok(encoder._streamBuffer.length > 0, 'Chunk 1 bytes must remain buffered');

  // Feed Chunk 2: NAL 1 is now completed by the start code before NAL 2
  // NAL 2 then marks the start of a new AU, so AU 1 (NAL 1) is emitted!
  const aus2 = encoder.feedStream(chunk2);
  assert.equal(aus2.length, 1, 'AU 1 containing reconstructed NAL 1 must be emitted');

  const emittedAu1 = aus2[0];
  assert.equal(emittedAu1.length, 1);
  assert.equal(emittedAu1[0].type, NAL_TYPES.IDR);
  assert.equal(emittedAu1[0].data.length, 100, 'Reconstructed NAL 1 must have exactly 100 bytes');
  assert.deepEqual(emittedAu1[0].data, nal1Full, 'Reconstructed NAL 1 data must match original bytes');
});

test('Test B — multiple frames in one chunk: Frame 1 + Frame 2 + partial Frame 3', () => {
  const encoder = new VideoEncoder({ payloadType: 98, ssrc: 12345, mtu: 1200, fps: 30 });
  const prefix4 = Buffer.from([0x00, 0x00, 0x00, 0x01]);
  const prefix3 = Buffer.from([0x00, 0x00, 0x01]);

  // Frame 1: SPS (7) + PPS (8) + IDR (5)
  const sps = Buffer.concat([prefix4, Buffer.from([0x67, 0x42, 0x00]), Buffer.alloc(10, 0x11)]);
  const pps = Buffer.concat([prefix4, Buffer.from([0x68, 0xce, 0x01]), Buffer.alloc(5, 0x22)]);
  const idr1 = Buffer.concat([prefix3, Buffer.from([0x65, 0x88]), Buffer.alloc(40, 0x33)]);
  const frame1 = Buffer.concat([sps, pps, idr1]);

  // Frame 2: Non-IDR slice (1) with first_mb_in_slice = 0
  const nonIdr2 = Buffer.concat([prefix4, Buffer.from([0x41, 0x88]), Buffer.alloc(30, 0x44)]);
  const frame2 = nonIdr2;

  // Frame 3 (partial): prefix + first 15 bytes of slice (no subsequent start code)
  const partialFrame3 = Buffer.concat([prefix4, Buffer.from([0x41, 0x88]), Buffer.alloc(13, 0x55)]);

  // Single chunk containing Frame 1 + Frame 2 + partial Frame 3
  const combinedChunk = Buffer.concat([frame1, frame2, partialFrame3]);

  const emittedAUs = encoder.feedStream(combinedChunk);

  // Must emit Frame 1 and Frame 2 separately, with Frame 3 remaining buffered
  assert.equal(emittedAUs.length, 2, 'Frame 1 and Frame 2 must be emitted separately');

  // Verify Frame 1 Access Unit
  const au1 = emittedAUs[0];
  assert.equal(au1.length, 3, 'Frame 1 AU must contain SPS, PPS, and IDR');
  assert.equal(au1[0].type, NAL_TYPES.SPS);
  assert.equal(au1[1].type, NAL_TYPES.PPS);
  assert.equal(au1[2].type, NAL_TYPES.IDR);

  // Verify Frame 2 Access Unit
  const au2 = emittedAUs[1];
  assert.equal(au2.length, 1, 'Frame 2 AU must contain 1 Non-IDR slice');
  assert.equal(au2[0].type, NAL_TYPES.NON_IDR);

  // Verify partial Frame 3 remains buffered
  assert.ok(encoder._streamBuffer.length > 0, 'Partial Frame 3 must remain buffered in stream buffer');

  // Now deliver remainder of Frame 3 followed by a Frame 4 delimiter
  const frame3Remainder = Buffer.alloc(20, 0x55);
  const frame4Start = Buffer.concat([prefix4, Buffer.from([0x41, 0x88]), Buffer.alloc(10, 0x66)]);
  const nextChunk = Buffer.concat([frame3Remainder, frame4Start]);

  const emittedAUs2 = encoder.feedStream(nextChunk);
  assert.equal(emittedAUs2.length, 1, 'Frame 3 must now be emitted');
  assert.equal(emittedAUs2[0][0].type, NAL_TYPES.NON_IDR);
  assert.equal(emittedAUs2[0][0].data.length, 2 + 13 + 20, 'Frame 3 total length must match');
});

test('Test C — RTP timestamp: Frame 1 -> X, Frame 2 -> X + 3000, uniform within frame', () => {
  const encoder = new VideoEncoder({ payloadType: 98, ssrc: 9999, mtu: 1200, fps: 30 });

  // Frame 1 with 3 NALs: SPS, PPS, IDR
  const frame1Nals = [
    { data: Buffer.from([0x67, 0x42, 0x00, 0x0a]), type: NAL_TYPES.SPS },
    { data: Buffer.from([0x68, 0xce, 0x01]), type: NAL_TYPES.PPS },
    { data: Buffer.concat([Buffer.from([0x65, 0x88]), Buffer.alloc(100, 0xaa)]), type: NAL_TYPES.IDR },
  ];

  const packets1 = encoder.packetizeAccessUnit(frame1Nals, 30);
  assert.equal(packets1.length, 3, 'Must produce 3 packets for Frame 1');

  const ts1_0 = packets1[0].readUInt32BE(4);
  const ts1_1 = packets1[1].readUInt32BE(4);
  const ts1_2 = packets1[2].readUInt32BE(4);

  // All packets of Frame 1 MUST have the EXACT same timestamp
  assert.equal(ts1_0, ts1_1, 'Packet 0 and 1 of Frame 1 must share identical timestamp');
  assert.equal(ts1_1, ts1_2, 'Packet 1 and 2 of Frame 1 must share identical timestamp');

  // Frame 2 with 1 Non-IDR slice
  const frame2Nals = [
    { data: Buffer.concat([Buffer.from([0x41, 0x88]), Buffer.alloc(80, 0xbb)]), type: NAL_TYPES.NON_IDR },
  ];

  const packets2 = encoder.packetizeAccessUnit(frame2Nals, 30);
  assert.equal(packets2.length, 1, 'Must produce 1 packet for Frame 2');

  const ts2_0 = packets2[0].readUInt32BE(4);

  // Frame 2 timestamp must be exactly ts1 + 3000 (90000 / 30 = 3000)
  assert.equal(ts2_0, (ts1_0 + 3000) >>> 0, 'Frame 2 timestamp must increment by exactly 3000');

  // Sequence numbers must be strictly increasing
  const seq1_0 = packets1[0].readUInt16BE(2);
  const seq1_1 = packets1[1].readUInt16BE(2);
  const seq1_2 = packets1[2].readUInt16BE(2);
  const seq2_0 = packets2[0].readUInt16BE(2);

  assert.equal(seq1_1, seq1_0 + 1);
  assert.equal(seq1_2, seq1_1 + 1);
  assert.equal(seq2_0, seq1_2 + 1);
});

test('Test D — RTP marker bit: M=0 for all except the final packet of the Access Unit (M=1)', () => {
  // Use mtu = 500 to force FU-A fragmentation on a large IDR
  const encoder = new VideoEncoder({ payloadType: 98, ssrc: 9999, mtu: 500, fps: 30 });

  // Frame: SPS (small) + PPS (small) + IDR (1200 bytes -> 3 FU-A packets)
  const frameNals = [
    { data: Buffer.from([0x67, 0x42, 0x00, 0x0a]), type: NAL_TYPES.SPS },
    { data: Buffer.from([0x68, 0xce, 0x01]), type: NAL_TYPES.PPS },
    { data: Buffer.concat([Buffer.from([0x65, 0x88]), Buffer.alloc(1198, 0xcc)]), type: NAL_TYPES.IDR },
  ];

  const packets = encoder.packetizeAccessUnit(frameNals, 30);
  // Total packets: 1 (SPS) + 1 (PPS) + 3 (FU-A IDR) = 5 packets
  assert.equal(packets.length, 5, 'Must produce exactly 5 packets');

  for (let i = 0; i < packets.length - 1; i++) {
    const isMarkerSet = (packets[i][1] & 0x80) !== 0;
    assert.equal(isMarkerSet, false, `Packet ${i} must have Marker bit M=0`);
  }

  // The very final packet of the Access Unit must have Marker bit M=1
  const lastPacket = packets[packets.length - 1];
  const isLastMarkerSet = (lastPacket[1] & 0x80) !== 0;
  assert.equal(isLastMarkerSet, true, 'Final packet of the Access Unit must have Marker bit M=1');
});

test('Test E — backpressure: bounded queue, stale frame dropping, and latest-frame priority', () => {
  const encoder = new VideoEncoder({ maxPendingFrames: 1 });

  // Create a mock FFmpeg process with a backpressured stdin
  let drainHandler = null;
  const writtenBuffers = [];

  const mockStdin = new EventEmitter();
  mockStdin.writable = true;
  mockStdin.write = (buffer) => {
    writtenBuffers.push(buffer);
    // Simulate backpressure: return false to indicate buffer full
    return false;
  };
  mockStdin.on('drain', (fn) => {
    drainHandler = fn;
  });

  encoder.ffmpegProc = {
    stdin: mockStdin,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: () => {},
  };
  encoder._isEncoding = true;

  // Frame 100: written immediately, returns false -> triggers backpressure
  const f100 = Buffer.from('frame-100');
  const res100 = encoder.encodeFrame(f100);
  assert.equal(res100, true, 'Frame 100 accepted by stdin');
  assert.equal(encoder._waitingForDrain, true, 'Encoder must be waiting for drain');
  assert.equal(encoder.metrics.inputPending, 0);

  // Frame 101 arrives while waiting for drain: queued in pending queue
  const f101 = Buffer.from('frame-101');
  const res101 = encoder.encodeFrame(f101);
  assert.equal(res101, false, 'Frame 101 buffered in pending queue');
  assert.equal(encoder._pendingQueue.length, 1);
  assert.equal(encoder.metrics.inputPending, 1);
  assert.equal(encoder.metrics.inputDropped, 0);

  // Frame 102 arrives while waiting for drain: capacity is 1, so Frame 101 must be dropped!
  const f102 = Buffer.from('frame-102');
  encoder.encodeFrame(f102);
  assert.equal(encoder._pendingQueue.length, 1, 'Queue must remain bounded at maxPendingFrames (1)');
  assert.equal(encoder.metrics.inputDropped, 1, 'Frame 101 must be dropped');
  assert.equal(encoder._pendingQueue[0].buffer.toString(), 'frame-102', 'Latest frame 102 must be kept');

  // Frame 103 arrives: Frame 102 must be dropped!
  const f103 = Buffer.from('frame-103');
  encoder.encodeFrame(f103);
  assert.equal(encoder._pendingQueue.length, 1);
  assert.equal(encoder.metrics.inputDropped, 2, 'Frame 102 must also be dropped');
  assert.equal(encoder._pendingQueue[0].buffer.toString(), 'frame-103', 'Latest frame 103 must be kept');

  // Now simulate drain event on stdin
  mockStdin.emit('drain');
  assert.equal(encoder._waitingForDrain, true, 'Should write frame 103 and wait for next drain if write returns false');
  assert.equal(encoder._pendingQueue.length, 0, 'Pending queue must be flushed');
  assert.equal(encoder.metrics.inputPending, 0);

  // Verify that frame 100 and frame 103 were written to stdin (101 and 102 were dropped)
  assert.equal(writtenBuffers.length, 2);
  assert.equal(writtenBuffers[0].toString(), 'frame-100');
  assert.equal(writtenBuffers[1].toString(), 'frame-103');
});

test('Test F — keyframe recovery: requestKeyframe generates fresh IDR sequence', () => {
  const encoder = new VideoEncoder({ payloadType: 98, ssrc: 12345, mtu: 1200, fps: 30 });
  const prefix4 = Buffer.from([0x00, 0x00, 0x00, 0x01]);

  // Cache an initial keyframe
  const sps = Buffer.concat([prefix4, Buffer.from([0x67, 0x42, 0x00]), Buffer.alloc(10, 0x11)]);
  const pps = Buffer.concat([prefix4, Buffer.from([0x68, 0xce, 0x01]), Buffer.alloc(5, 0x22)]);
  const idr = Buffer.concat([prefix4, Buffer.from([0x65, 0x88]), Buffer.alloc(40, 0x33)]);
  const keyframeBuffer = Buffer.concat([sps, pps, idr]);

  const initialPackets = encoder.packetize(keyframeBuffer, 30);
  assert.ok(initialPackets.length >= 3);
  const initialTs = initialPackets[0].readUInt32BE(4);
  const initialLastSeq = initialPackets[initialPackets.length - 1].readUInt16BE(2);

  // Delta frame
  const nonIdr = Buffer.concat([prefix4, Buffer.from([0x41, 0x88]), Buffer.alloc(30, 0x44)]);
  encoder.packetize(nonIdr, 30);

  // Client requests keyframe
  let keyframeRequestedEmitted = false;
  encoder.on('keyframe_requested', () => {
    keyframeRequestedEmitted = true;
  });

  const recoveryPackets = encoder.requestKeyframe();
  assert.equal(keyframeRequestedEmitted, true, 'Must emit keyframe_requested event');
  assert.equal(encoder.metrics.keyframeRequests, 1);
  assert.ok(recoveryPackets.length >= 3, 'Must return recovery packets for SPS, PPS, and IDR');

  // Verify recovery packets have a FRESH RTP timestamp
  const recoveryTs = recoveryPackets[0].readUInt32BE(4);
  assert.notEqual(recoveryTs, initialTs, 'Recovery packets must have a new, fresh RTP timestamp');

  // Verify sequence numbers continue monotonically
  const recoveryFirstSeq = recoveryPackets[0].readUInt16BE(2);
  assert.ok(recoveryFirstSeq > initialLastSeq, 'Sequence numbers must continue monotonically');

  // Verify marker bit is set ONLY on the final recovery packet
  for (let i = 0; i < recoveryPackets.length - 1; i++) {
    assert.equal(recoveryPackets[i][1] & 0x80, 0, `Recovery packet ${i} must have M=0`);
  }
  const finalRecoveryPacket = recoveryPackets[recoveryPackets.length - 1];
  assert.equal(finalRecoveryPacket[1] & 0x80, 0x80, 'Final recovery packet must have M=1');
});
