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

test('Test 1 (Runtime Force Request) — requestKeyframe() triggers runtime force-IDR mechanism exactly once', () => {
  const mockControl = {
    messages: [],
    write(msg) {
      this.messages.push(msg);
      return true;
    },
  };

  const encoder = new VideoEncoder({
    payloadType: 98,
    ssrc: 12345,
    mtu: 1200,
    fps: 30,
    controlChannel: mockControl,
  });

  let forceCommandEvent = null;
  encoder.on('force_idr_command', (evt) => {
    forceCommandEvent = evt;
  });

  let keyframeForcingEmitted = false;
  encoder.on('keyframe_forcing', () => {
    keyframeForcingEmitted = true;
  });

  assert.equal(encoder._forceKeyframePending, false);
  assert.equal(encoder._keyframeRequested, false);

  const promise = encoder.requestKeyframe();

  assert.ok(promise instanceof Promise, 'requestKeyframe must return a Promise');
  assert.equal(encoder._keyframeRequested, true, '_keyframeRequested must be set');
  assert.equal(encoder._forceKeyframePending, true, '_forceKeyframePending must be set');
  assert.equal(keyframeForcingEmitted, true, 'keyframe_forcing event must be emitted');
  assert.ok(forceCommandEvent, 'force_idr_command event must be emitted');
  assert.equal(mockControl.messages.length, 1, 'Runtime control channel must receive exactly one command');
  assert.equal(mockControl.messages[0], 'force_keyframe\n');
});

test('Test 2 (Coalescing) — p1 === p2 === p3 and only one runtime force command is dispatched', async () => {
  const mockControl = {
    messages: [],
    write(msg) {
      this.messages.push(msg);
      return true;
    },
  };

  const encoder = new VideoEncoder({
    payloadType: 98,
    ssrc: 12345,
    mtu: 1200,
    fps: 30,
    controlChannel: mockControl,
  });

  let forceCommandCount = 0;
  encoder.on('force_idr_command', () => {
    forceCommandCount++;
  });

  // Multiple requests arrive in rapid succession
  const p1 = encoder.requestKeyframe();
  const p2 = encoder.requestKeyframe();
  const p3 = encoder.requestKeyframe();
  const p4 = encoder.requestKeyframe();

  // Verify coalescing: All calls return the EXACT same pending promise
  assert.equal(p1, p2, 'p1 and p2 must be the exact same promise');
  assert.equal(p2, p3, 'p2 and p3 must be the exact same promise');
  assert.equal(p3, p4, 'p3 and p4 must be the exact same promise');
  assert.equal(encoder.metrics.keyframeRequests, 4, 'Metrics must record all 4 incoming requests');
  assert.equal(encoder._keyframeRequested, true, 'Active requested flag must be true');
  assert.equal(forceCommandCount, 1, 'Only ONE runtime force command must be dispatched');
  assert.equal(mockControl.messages.length, 1, 'Only one control command written');

  // Feed one fresh IDR
  const prefix4 = Buffer.from([0x00, 0x00, 0x00, 0x01]);
  const sps = Buffer.concat([prefix4, Buffer.from([0x67, 0x42, 0x00]), Buffer.alloc(10, 0x11)]);
  const pps = Buffer.concat([prefix4, Buffer.from([0x68, 0xce, 0x01]), Buffer.alloc(5, 0x22)]);
  const idr = Buffer.concat([prefix4, Buffer.from([0x65, 0x88]), Buffer.alloc(40, 0x33)]);
  const delim = Buffer.concat([prefix4, Buffer.from([0x41, 0x88]), Buffer.alloc(10, 0x44)]);
  encoder.feedStream(Buffer.concat([sps, pps, idr, delim]));

  const [res1, res2, res3, res4] = await Promise.all([p1, p2, p3, p4]);
  assert.equal(res1, res2);
  assert.equal(res2, res3);
  assert.equal(res3, res4);
  assert.equal(encoder._keyframeRequested, false, 'Keyframe request state must be cleared after resolution');
  assert.equal(encoder._forceKeyframePending, false, 'Force keyframe pending flag must be cleared');
  assert.equal(encoder._pendingKeyframeResolvers.length, 0, 'Resolver queue must be empty');
  assert.equal(encoder._pendingKeyframePromise, null, 'Pending promise must be cleared');
});

test('Test 3 (Fresh IDR) — resolves only when fresh IDR Access Unit arrives, never using cached keyframe', async () => {
  const encoder = new VideoEncoder({ payloadType: 98, ssrc: 12345, mtu: 1200, fps: 30 });
  const prefix4 = Buffer.from([0x00, 0x00, 0x00, 0x01]);

  // Initial keyframe (IDR 1)
  const sps1 = Buffer.concat([prefix4, Buffer.from([0x67, 0x42, 0x00]), Buffer.alloc(10, 0x11)]);
  const pps1 = Buffer.concat([prefix4, Buffer.from([0x68, 0xce, 0x01]), Buffer.alloc(5, 0x22)]);
  const idr1 = Buffer.concat([prefix4, Buffer.from([0x65, 0x88]), Buffer.alloc(40, 0x33)]);
  const frame1Chunk = Buffer.concat([sps1, pps1, idr1]);

  // P-frame 1
  const nonIdr1 = Buffer.concat([prefix4, Buffer.from([0x41, 0x88]), Buffer.alloc(30, 0x44)]);

  // Feed Frame 1 and Frame 2 to set up initial state
  encoder.feedStream(Buffer.concat([frame1Chunk, nonIdr1]));
  assert.ok(encoder.hasKeyframe(), 'Must have cached initial keyframe');
  const cachedInitialKeyframe = encoder.cachedKeyframe;

  // Client requests keyframe recovery
  let keyframeRequestedEmitted = false;
  encoder.on('keyframe_requested', (evt) => {
    keyframeRequestedEmitted = true;
    assert.equal(evt.count, 1);
  });

  const recoveryPromise = encoder.requestKeyframe();

  // Verify requestKeyframe does NOT return the old cached keyframe synchronously
  assert.notDeepEqual(recoveryPromise, cachedInitialKeyframe, 'Must NOT return cachedKeyframe');
  assert.ok(recoveryPromise instanceof Promise, 'Must return a promise for the fresh IDR');
  assert.equal(keyframeRequestedEmitted, true, 'Must emit keyframe_requested event');
  assert.equal(encoder._keyframeRequested, true, 'Must mark _keyframeRequested');

  // Intermediate P-frame arrives - must NOT resolve the recovery promise
  let prematurelyResolved = false;
  recoveryPromise.then(() => { prematurelyResolved = true; });

  const nonIdr2 = Buffer.concat([prefix4, Buffer.from([0x41, 0x88]), Buffer.alloc(30, 0x55)]);
  encoder.feedStream(nonIdr2);
  await new Promise((r) => setImmediate(r));
  assert.equal(prematurelyResolved, false, 'Recovery promise must NOT resolve on a P-frame');

  // Now feed a fresh IDR (IDR 2) with different data bytes
  const sps2 = Buffer.concat([prefix4, Buffer.from([0x67, 0x42, 0x00]), Buffer.alloc(10, 0x77)]);
  const pps2 = Buffer.concat([prefix4, Buffer.from([0x68, 0xce, 0x01]), Buffer.alloc(5, 0x88)]);
  const idr2 = Buffer.concat([prefix4, Buffer.from([0x65, 0x88]), Buffer.alloc(50, 0x99)]);
  // Followed by another slice to delimit AU
  const delimiterSlice = Buffer.concat([prefix4, Buffer.from([0x41, 0x88]), Buffer.alloc(10, 0xaa)]);
  const freshIdrChunk = Buffer.concat([sps2, pps2, idr2, delimiterSlice]);

  encoder.feedStream(freshIdrChunk);

  const recoveryPackets = await recoveryPromise;
  assert.ok(Array.isArray(recoveryPackets) && recoveryPackets.length >= 3, 'Must resolve with fresh IDR packets');

  // Verify that the payload of the fresh IDR contains the new bytes (0x99), not old bytes (0x33)
  const freshIdrPacket = recoveryPackets.find((p) => (p[12] & 0x1f) === NAL_TYPES.IDR);
  assert.ok(freshIdrPacket, 'Must contain IDR packet');
  assert.ok(freshIdrPacket.includes(0x99), 'Fresh IDR must contain new frame data, not old cached data');
  assert.equal(freshIdrPacket.includes(0x33), false, 'Fresh IDR must not contain old frame data');
  assert.equal(encoder._keyframeRequested, false, 'Pending keyframe request must be cleared');
  assert.equal(encoder._forceKeyframePending, false, 'Pending force flag must be cleared');
});

test('Test 4 (RTP Continuity) — sequence numbers, SSRC, and timestamps advance continuously across recovery IDR', () => {
  const encoder = new VideoEncoder({ payloadType: 98, ssrc: 8888, mtu: 1200, fps: 30 });

  // Frame 1: P-frame
  const p1 = [{ data: Buffer.concat([Buffer.from([0x41, 0x88]), Buffer.alloc(50, 0x11)]), type: NAL_TYPES.NON_IDR }];
  const pkts1 = encoder.packetizeAccessUnit(p1, 30);
  const ts1 = pkts1[0].readUInt32BE(4);
  const seq1 = pkts1[0].readUInt16BE(2);
  const ssrc1 = pkts1[0].readUInt32BE(8);
  assert.equal(ssrc1, 8888);

  // Frame 2: P-frame
  const p2 = [{ data: Buffer.concat([Buffer.from([0x41, 0x88]), Buffer.alloc(50, 0x22)]), type: NAL_TYPES.NON_IDR }];
  const pkts2 = encoder.packetizeAccessUnit(p2, 30);
  const ts2 = pkts2[0].readUInt32BE(4);
  const seq2 = pkts2[0].readUInt16BE(2);
  assert.equal(ts2, (ts1 + 3000) >>> 0);
  assert.equal(seq2, (seq1 + 1) & 0xffff);

  // Keyframe request arrives
  encoder.requestKeyframe();

  // Frame 3: Fresh IDR Access Unit (SPS, PPS, IDR)
  const idrAu = [
    { data: Buffer.from([0x67, 0x42, 0x00, 0x0a]), type: NAL_TYPES.SPS },
    { data: Buffer.from([0x68, 0xce, 0x01]), type: NAL_TYPES.PPS },
    { data: Buffer.concat([Buffer.from([0x65, 0x88]), Buffer.alloc(100, 0x33)]), type: NAL_TYPES.IDR },
  ];
  const idrPkts = encoder.packetizeAccessUnit(idrAu, 30);
  assert.equal(idrPkts.length, 3);

  const idrTs = idrPkts[0].readUInt32BE(4);
  assert.equal(idrTs, (ts2 + 3000) >>> 0, 'Fresh IDR timestamp must advance normally');
  assert.equal(idrPkts[1].readUInt32BE(4), idrTs, 'All packets of IDR AU must share the same timestamp');
  assert.equal(idrPkts[2].readUInt32BE(4), idrTs, 'All packets of IDR AU must share the same timestamp');

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

test('Test 5 (Marker Bit) — fresh IDR Access Unit sets M=1 only on the final RTP packet', () => {
  // Use mtu = 500 so IDR slice is fragmented into multiple FU-A packets
  const encoder = new VideoEncoder({ payloadType: 98, ssrc: 7777, mtu: 500, fps: 30 });

  const freshIdrAu = [
    { data: Buffer.from([0x67, 0x42, 0x00, 0x0a]), type: NAL_TYPES.SPS },
    { data: Buffer.from([0x68, 0xce, 0x01]), type: NAL_TYPES.PPS },
    { data: Buffer.concat([Buffer.from([0x65, 0x88]), Buffer.alloc(1200, 0x55)]), type: NAL_TYPES.IDR },
  ];

  const packets = encoder.packetizeAccessUnit(freshIdrAu, 30);
  assert.ok(packets.length >= 4, 'Must produce multiple packets including FU-A');

  // Verify all packets except the final packet have M=0
  for (let i = 0; i < packets.length - 1; i++) {
    const marker = (packets[i][1] & 0x80) !== 0;
    assert.equal(marker, false, `Packet ${i} of fresh IDR AU must have Marker bit M=0`);
  }

  // Verify the final packet of the fresh IDR AU has M=1
  const finalPacket = packets[packets.length - 1];
  const finalMarker = (finalPacket[1] & 0x80) !== 0;
  assert.equal(finalMarker, true, 'Final packet of fresh IDR AU must have Marker bit M=1');
});

test('Test 6 (Timeout Safety) — missing IDR triggers timeout, clearing pending state and resolving safely', async () => {
  const encoder = new VideoEncoder({
    payloadType: 98,
    ssrc: 12345,
    mtu: 1200,
    fps: 30,
    keyframeTimeoutMs: 50, // Short timeout for test
  });

  assert.equal(encoder._keyframeRequested, false);
  assert.equal(encoder._forceKeyframePending, false);

  const promise = encoder.requestKeyframe();

  assert.equal(encoder._keyframeRequested, true);
  assert.equal(encoder._forceKeyframePending, true);
  assert.ok(encoder._keyframeTimer !== null, 'Timeout timer must be active');

  // Wait for timeout to expire
  const packets = await promise;

  assert.deepEqual(packets, [], 'Timeout must safely resolve to empty packet array');
  assert.equal(encoder._keyframeRequested, false, 'State must be reset');
  assert.equal(encoder._forceKeyframePending, false, 'State must be reset');
  assert.equal(encoder._pendingKeyframeResolvers.length, 0, 'Resolvers list must be cleared');
  assert.equal(encoder._pendingKeyframePromise, null, 'Pending promise must be cleared');
});

