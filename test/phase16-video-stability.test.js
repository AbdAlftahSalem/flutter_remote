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

test('Test 0 — Missing latest frame: requestKeyframe() fails clearly when no JPEG frame is available', async () => {
  const encoder = new VideoEncoder();
  await assert.rejects(
    async () => {
      await encoder.requestKeyframe();
    },
    /No latest JPEG frame available for keyframe recovery/
  );
});

test('Test 1 — Latest frame: encodeFrame(JPEG) stores an immutable copy in _latestFrame', () => {
  const encoder = new VideoEncoder();
  assert.equal(encoder._latestFrame, null);

  const initialBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
  encoder.encodeFrame(initialBytes);

  assert.ok(encoder._latestFrame !== null);
  assert.deepEqual(encoder._latestFrame, initialBytes);
  // Mutating original buffer should not mutate stored copy
  initialBytes[0] = 0x00;
  assert.notDeepEqual(encoder._latestFrame, initialBytes);
  encoder.close();
});

test('Test 2 — Fresh recovery: recovery output contains SPS, PPS, and IDR', async () => {
  const encoder = new VideoEncoder({ payloadType: 98, ssrc: 12345, mtu: 1200, fps: 30 });
  encoder._latestFrame = Buffer.from('fake-jpeg-frame');

  const prefix4 = Buffer.from([0x00, 0x00, 0x00, 0x01]);
  const sps = Buffer.concat([prefix4, Buffer.from([0x67, 0x42, 0x00, 0x0a]), Buffer.alloc(10, 0x11)]);
  const pps = Buffer.concat([prefix4, Buffer.from([0x68, 0xce, 0x01]), Buffer.alloc(5, 0x22)]);
  const idr = Buffer.concat([prefix4, Buffer.from([0x65, 0x88]), Buffer.alloc(40, 0x33)]);
  const h264Output = Buffer.concat([sps, pps, idr]);

  encoder._encodeFreshIdrFrame = async () => h264Output;

  let freshKeyframeEvent = null;
  encoder.on('fresh_keyframe_encoded', (evt) => {
    freshKeyframeEvent = evt;
  });

  const packets = await encoder.requestKeyframe();
  assert.ok(Array.isArray(packets) && packets.length >= 3);
  assert.ok(freshKeyframeEvent !== null);
  assert.equal(freshKeyframeEvent.recovery, true);
  assert.equal(encoder.metrics.freshKeyframeRecoveries, 1);
  assert.ok(encoder.hasKeyframe());
});

test('Test 3 — Real IDR validation: recovery output without IDR (or with only Non-IDR/I-slice) is rejected', async () => {
  const encoder = new VideoEncoder({ payloadType: 98, ssrc: 12345, mtu: 1200, fps: 30 });
  encoder._latestFrame = Buffer.from('fake-jpeg-frame');

  const prefix4 = Buffer.from([0x00, 0x00, 0x00, 0x01]);
  const sps = Buffer.concat([prefix4, Buffer.from([0x67, 0x42, 0x00, 0x0a]), Buffer.alloc(10, 0x11)]);
  const pps = Buffer.concat([prefix4, Buffer.from([0x68, 0xce, 0x01]), Buffer.alloc(5, 0x22)]);
  const nonIdr = Buffer.concat([prefix4, Buffer.from([0x41, 0x88]), Buffer.alloc(40, 0x33)]);
  const h264WithoutIdr = Buffer.concat([sps, pps, nonIdr]);

  encoder._encodeFreshIdrFrame = async () => h264WithoutIdr;

  await assert.rejects(
    async () => {
      await encoder.requestKeyframe();
    },
    /Recovery encoder did not produce IDR/
  );
  assert.equal(encoder.metrics.freshKeyframeFailures, 1);
});

test('Test 4 — Promise coalescing: multiple rapid requestKeyframe() calls trigger only one recovery process', async () => {
  const encoder = new VideoEncoder({ payloadType: 98, ssrc: 12345, mtu: 1200, fps: 30 });
  encoder._latestFrame = Buffer.from('fake-jpeg-frame');

  const prefix4 = Buffer.from([0x00, 0x00, 0x00, 0x01]);
  const sps = Buffer.concat([prefix4, Buffer.from([0x67, 0x42, 0x00, 0x0a]), Buffer.alloc(10, 0x11)]);
  const pps = Buffer.concat([prefix4, Buffer.from([0x68, 0xce, 0x01]), Buffer.alloc(5, 0x22)]);
  const idr = Buffer.concat([prefix4, Buffer.from([0x65, 0x88]), Buffer.alloc(40, 0x33)]);
  const h264Output = Buffer.concat([sps, pps, idr]);

  let recoveryProcessCount = 0;
  encoder._encodeFreshIdrFrame = async () => {
    recoveryProcessCount++;
    await new Promise((r) => setTimeout(r, 20));
    return h264Output;
  };

  const p1 = encoder.requestKeyframe();
  const p2 = encoder.requestKeyframe();
  const p3 = encoder.requestKeyframe();
  const p4 = encoder.requestKeyframe();

  assert.equal(p1, p2);
  assert.equal(p2, p3);
  assert.equal(p3, p4);

  const [r1, r2, r3, r4] = await Promise.all([p1, p2, p3, p4]);
  assert.equal(r1, r2);
  assert.equal(recoveryProcessCount, 1, 'Exactly ONE recovery process must be spawned for coalesced requests');
  assert.equal(encoder.metrics.keyframeRequests, 4);

  // After completion, a subsequent request triggers a new recovery process
  const p5 = encoder.requestKeyframe();
  assert.notEqual(p5, p1);
  await p5;
  assert.equal(recoveryProcessCount, 2);
});

test('Test 5 — RTP continuity: SSRC unchanged, sequence numbers continue, and timestamp advances consistently', async () => {
  const encoder = new VideoEncoder({ payloadType: 98, ssrc: 8888, mtu: 1200, fps: 30 });
  encoder._latestFrame = Buffer.from('fake-jpeg-frame');

  // Frame 1: Normal P-frame
  const p1 = [{ data: Buffer.concat([Buffer.from([0x41, 0x88]), Buffer.alloc(50, 0x11)]), type: NAL_TYPES.NON_IDR }];
  const pkts1 = encoder.packetizeAccessUnit(p1, 30);
  const ts1 = pkts1[0].readUInt32BE(4);
  const seq1 = pkts1[0].readUInt16BE(2);
  const ssrc1 = pkts1[0].readUInt32BE(8);
  assert.equal(ssrc1, 8888);

  // Frame 2: Normal P-frame
  const p2 = [{ data: Buffer.concat([Buffer.from([0x41, 0x88]), Buffer.alloc(50, 0x22)]), type: NAL_TYPES.NON_IDR }];
  const pkts2 = encoder.packetizeAccessUnit(p2, 30);
  const ts2 = pkts2[0].readUInt32BE(4);
  const seq2 = pkts2[0].readUInt16BE(2);
  assert.equal(ts2, (ts1 + 3000) >>> 0);
  assert.equal(seq2, (seq1 + 1) & 0xffff);

  // Fresh Recovery Keyframe
  const prefix4 = Buffer.from([0x00, 0x00, 0x00, 0x01]);
  const sps = Buffer.concat([prefix4, Buffer.from([0x67, 0x42, 0x00, 0x0a]), Buffer.alloc(10, 0x11)]);
  const pps = Buffer.concat([prefix4, Buffer.from([0x68, 0xce, 0x01]), Buffer.alloc(5, 0x22)]);
  const idr = Buffer.concat([prefix4, Buffer.from([0x65, 0x88]), Buffer.alloc(100, 0x33)]);
  encoder._encodeFreshIdrFrame = async () => Buffer.concat([sps, pps, idr]);

  const idrPkts = await encoder.requestKeyframe();
  assert.equal(idrPkts.length, 3);

  const idrTs = idrPkts[0].readUInt32BE(4);
  assert.equal(idrTs, (ts2 + 3000) >>> 0, 'Fresh IDR timestamp must advance by exactly one frame duration');
  assert.equal(idrPkts[1].readUInt32BE(4), idrTs, 'All packets of IDR AU must share identical timestamp');
  assert.equal(idrPkts[2].readUInt32BE(4), idrTs, 'All packets of IDR AU must share identical timestamp');

  assert.equal(idrPkts[0].readUInt16BE(2), (seq2 + 1) & 0xffff, 'Sequence numbers must continue without gap');
  assert.equal(idrPkts[1].readUInt16BE(2), (seq2 + 2) & 0xffff);
  assert.equal(idrPkts[2].readUInt16BE(2), (seq2 + 3) & 0xffff);

  assert.equal(idrPkts[0].readUInt32BE(8), 8888, 'SSRC must remain unchanged');
  assert.equal(idrPkts[1].readUInt32BE(8), 8888);
  assert.equal(idrPkts[2].readUInt32BE(8), 8888);

  // Frame 4: P-frame after recovery IDR
  const p4 = [{ data: Buffer.concat([Buffer.from([0x41, 0x88]), Buffer.alloc(50, 0x44)]), type: NAL_TYPES.NON_IDR }];
  const pkts4 = encoder.packetizeAccessUnit(p4, 30);
  const ts4 = pkts4[0].readUInt32BE(4);
  const seq4 = pkts4[0].readUInt16BE(2);

  assert.equal(ts4, (idrTs + 3000) >>> 0, 'Next P-frame timestamp must advance normally');
  assert.equal(seq4, (idrPkts[2].readUInt16BE(2) + 1) & 0xffff, 'Next P-frame seq must continue from last IDR packet');
  assert.equal(pkts4[0].readUInt32BE(8), 8888, 'SSRC must remain unchanged');
});

test('Test 6 — Marker bit: all packets except last -> M=0, last packet -> M=1 (including FU-A fragmentation)', async () => {
  const encoder = new VideoEncoder({ payloadType: 98, ssrc: 7777, mtu: 500, fps: 30 });
  encoder._latestFrame = Buffer.from('fake-jpeg-frame');

  const prefix4 = Buffer.from([0x00, 0x00, 0x00, 0x01]);
  const sps = Buffer.concat([prefix4, Buffer.from([0x67, 0x42, 0x00, 0x0a]), Buffer.alloc(10, 0x11)]);
  const pps = Buffer.concat([prefix4, Buffer.from([0x68, 0xce, 0x01]), Buffer.alloc(5, 0x22)]);
  const idr = Buffer.concat([prefix4, Buffer.from([0x65, 0x88]), Buffer.alloc(1200, 0x55)]);
  encoder._encodeFreshIdrFrame = async () => Buffer.concat([sps, pps, idr]);

  const packets = await encoder.requestKeyframe();
  assert.ok(packets.length >= 4, 'Must produce multiple packets including FU-A');

  for (let i = 0; i < packets.length - 1; i++) {
    const marker = (packets[i][1] & 0x80) !== 0;
    assert.equal(marker, false, `Packet ${i} of fresh IDR AU must have Marker bit M=0`);
    assert.equal(packets[i].marker, 0);
  }

  const finalPacket = packets[packets.length - 1];
  const finalMarker = (finalPacket[1] & 0x80) !== 0;
  assert.equal(finalMarker, true, 'Final packet of fresh IDR AU must have Marker bit M=1');
  assert.equal(finalPacket.marker, 1);
});

test('Test 7 — FFmpeg failure: rejects promise, does not kill main encoder, and allows next recovery request', async () => {
  const encoder = new VideoEncoder({ payloadType: 98, ssrc: 12345, mtu: 1200, fps: 30 });
  encoder._latestFrame = Buffer.from('fake-jpeg-frame');

  // Mock main encoder process to verify it stays alive
  let mainKilled = false;
  encoder.ffmpegProc = {
    stdin: { writable: true, write: () => true },
    kill: () => { mainKilled = true; },
  };
  encoder._isEncoding = true;

  // Make _encodeFreshIdrFrame fail
  encoder._encodeFreshIdrFrame = async () => {
    throw new Error('Recovery FFmpeg exited with code 1: Invalid input data');
  };

  await assert.rejects(
    async () => {
      await encoder.requestKeyframe();
    },
    /Recovery FFmpeg exited with code 1/
  );

  assert.equal(mainKilled, false, 'Main FFmpeg encoder must NOT be killed on recovery failure');
  assert.equal(encoder._isEncoding, true, 'Main encoder must remain encoding');
  assert.equal(encoder._pendingKeyframePromise, null, 'Pending promise must be cleared');
  assert.equal(encoder._recoveryInFlight, false, 'Recovery in-flight flag must be reset');
  assert.equal(encoder.metrics.freshKeyframeFailures, 1);

  // Verify next recovery request can be attempted
  const prefix4 = Buffer.from([0x00, 0x00, 0x00, 0x01]);
  const sps = Buffer.concat([prefix4, Buffer.from([0x67, 0x42, 0x00, 0x0a]), Buffer.alloc(10, 0x11)]);
  const pps = Buffer.concat([prefix4, Buffer.from([0x68, 0xce, 0x01]), Buffer.alloc(5, 0x22)]);
  const idr = Buffer.concat([prefix4, Buffer.from([0x65, 0x88]), Buffer.alloc(40, 0x33)]);
  encoder._encodeFreshIdrFrame = async () => Buffer.concat([sps, pps, idr]);

  const recoveredPackets = await encoder.requestKeyframe();
  assert.ok(Array.isArray(recoveredPackets) && recoveredPackets.length >= 3);
  assert.equal(encoder.metrics.freshKeyframeRecoveries, 1);
});

