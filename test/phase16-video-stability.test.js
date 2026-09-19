import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { VideoEncoder, NAL_TYPES, RECOVERY_STATES } from '../src/media/VideoEncoder.js';

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

function createMockEncoderProc(h264Data) {
  const proc = new EventEmitter();
  proc.isKilled = false;
  proc.stdin = {
    writable: true,
    write: (chunk) => {
      if (h264Data) {
        setImmediate(() => {
          proc.stdout.emit('data', h264Data);
        });
      }
      return true;
    },
    end: () => {
      proc.stdin.ended = true;
    },
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => {
    proc.isKilled = true;
  };
  return proc;
}

const prefix4 = Buffer.from([0x00, 0x00, 0x00, 0x01]);
const defaultSps = Buffer.concat([prefix4, Buffer.from([0x67, 0x42, 0x00, 0x0a]), Buffer.alloc(10, 0x11)]);
const defaultPps = Buffer.concat([prefix4, Buffer.from([0x68, 0xce, 0x01]), Buffer.alloc(5, 0x22)]);
const defaultIdr = Buffer.concat([prefix4, Buffer.from([0x65, 0x88]), Buffer.alloc(40, 0x33)]);
const defaultIdrH264 = Buffer.concat([defaultSps, defaultPps, defaultIdr]);

test('Test 0 — Missing latest frame: requestKeyframe() fails clearly when no JPEG frame is available', async () => {
  const encoder = new VideoEncoder();
  await assert.rejects(
    async () => {
      await encoder.requestKeyframe();
    },
    /No latest JPEG frame available for keyframe recovery/
  );
});

test('Test 1 — Request coalescing: 3 requests -> 1 actual IDR request', async () => {
  const encoder = new VideoEncoder();
  encoder._latestFrame = Buffer.from('fake-jpeg-frame');

  let spawnCount = 0;
  encoder._spawnEncoderProcess = () => {
    spawnCount++;
    return createMockEncoderProc(defaultIdrH264);
  };

  const p1 = encoder.requestKeyframe();
  const p2 = encoder.requestKeyframe();
  const p3 = encoder.requestKeyframe();

  assert.equal(p1, p2, 'p1 and p2 must be the exact same pending promise');
  assert.equal(p2, p3, 'p2 and p3 must be the exact same pending promise');

  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.equal(r1, r2);
  assert.equal(r2, r3);
  assert.equal(spawnCount, 1, 'Only ONE replacement encoder process must be spawned for coalesced requests');
  assert.equal(encoder.metrics.keyframeRequests, 3);
  assert.equal(encoder.metrics.forcedIdrRequests, 3);
  assert.equal(encoder.metrics.forcedIdrSuccesses, 1);
});

test('Test 2 — IDR validation: valid SPS+PPS+IDR passes; SPS+PPS+NON_IDR fails', async () => {
  const encoder = new VideoEncoder();
  encoder._latestFrame = Buffer.from('fake-jpeg-frame');

  // 1. Valid SPS + PPS + IDR
  encoder._spawnEncoderProcess = () => createMockEncoderProc(defaultIdrH264);
  const packets = await encoder.requestKeyframe();
  assert.ok(Array.isArray(packets) && packets.length >= 3);

  // 2. Invalid: SPS + PPS + NON_IDR
  const nonIdr = Buffer.concat([prefix4, Buffer.from([0x41, 0x88]), Buffer.alloc(40, 0x44)]);
  const invalidH264 = Buffer.concat([defaultSps, defaultPps, nonIdr]);
  encoder._spawnEncoderProcess = () => createMockEncoderProc(invalidH264);

  await assert.rejects(
    async () => {
      await encoder.requestKeyframe();
    },
    /Recovery encoder did not produce IDR/
  );
  assert.equal(encoder.metrics.forcedIdrFailures, 1);
});

test('Test 3 — RTP continuity: continuous sequence numbers before, during, and after recovery', async () => {
  const encoder = new VideoEncoder({ payloadType: 98, ssrc: 12345, mtu: 1200, fps: 30 });
  encoder._latestFrame = Buffer.from('fake-jpeg-frame');

  // Before recovery: P-frame 1 (seq 1), P-frame 2 (seq 2)
  const p1 = [{ data: Buffer.concat([Buffer.from([0x41, 0x88]), Buffer.alloc(50, 0x11)]), type: NAL_TYPES.NON_IDR }];
  const pkts1 = encoder.packetizeAccessUnit(p1, 30);
  assert.equal(pkts1[0].readUInt16BE(2), 1);

  const p2 = [{ data: Buffer.concat([Buffer.from([0x41, 0x88]), Buffer.alloc(50, 0x22)]), type: NAL_TYPES.NON_IDR }];
  const pkts2 = encoder.packetizeAccessUnit(p2, 30);
  assert.equal(pkts2[0].readUInt16BE(2), 2);

  // Recovery IDR: produces 3 packets (seq 3, 4, 5)
  encoder._spawnEncoderProcess = () => createMockEncoderProc(defaultIdrH264);
  const recoveryPkts = await encoder.requestKeyframe();
  assert.equal(recoveryPkts.length, 3);
  assert.equal(recoveryPkts[0].readUInt16BE(2), 3);
  assert.equal(recoveryPkts[1].readUInt16BE(2), 4);
  assert.equal(recoveryPkts[2].readUInt16BE(2), 5);

  // After recovery: next P-frame gets seq 6
  const p3 = [{ data: Buffer.concat([Buffer.from([0x41, 0x88]), Buffer.alloc(50, 0x33)]), type: NAL_TYPES.NON_IDR }];
  const pkts3 = encoder.packetizeAccessUnit(p3, 30);
  assert.equal(pkts3[0].readUInt16BE(2), 6);
});

test('Test 4 — SSRC continuity: all packets use the exact same SSRC across recovery', async () => {
  const encoder = new VideoEncoder({ ssrc: 778899 });
  encoder._latestFrame = Buffer.from('fake-jpeg-frame');

  const p1 = [{ data: Buffer.concat([Buffer.from([0x41, 0x88]), Buffer.alloc(50, 0x11)]), type: NAL_TYPES.NON_IDR }];
  const pkts1 = encoder.packetizeAccessUnit(p1, 30);
  assert.equal(pkts1[0].readUInt32BE(8), 778899);

  encoder._spawnEncoderProcess = () => createMockEncoderProc(defaultIdrH264);
  const recoveryPkts = await encoder.requestKeyframe();
  for (const p of recoveryPkts) {
    assert.equal(p.readUInt32BE(8), 778899);
  }

  const p2 = [{ data: Buffer.concat([Buffer.from([0x41, 0x88]), Buffer.alloc(50, 0x22)]), type: NAL_TYPES.NON_IDR }];
  const pkts2 = encoder.packetizeAccessUnit(p2, 30);
  assert.equal(pkts2[0].readUInt32BE(8), 778899);
});

test('Test 5 — Timestamp behavior: all packets of IDR AU share one timestamp, next AU gets next timestamp', async () => {
  const encoder = new VideoEncoder({ fps: 30 });
  encoder._latestFrame = Buffer.from('fake-jpeg-frame');

  // Frame before recovery
  const p1 = [{ data: Buffer.concat([Buffer.from([0x41, 0x88]), Buffer.alloc(50, 0x11)]), type: NAL_TYPES.NON_IDR }];
  const pkts1 = encoder.packetizeAccessUnit(p1, 30);
  const ts1 = pkts1[0].readUInt32BE(4);

  // Recovery IDR
  encoder._spawnEncoderProcess = () => createMockEncoderProc(defaultIdrH264);
  const idrPkts = await encoder.requestKeyframe();
  const idrTs = idrPkts[0].readUInt32BE(4);
  assert.equal(idrTs, (ts1 + 3000) >>> 0, 'IDR AU timestamp must increment by one frame interval (3000)');
  assert.equal(idrPkts[1].readUInt32BE(4), idrTs, 'All packets of IDR AU must share identical timestamp');
  assert.equal(idrPkts[2].readUInt32BE(4), idrTs, 'All packets of IDR AU must share identical timestamp');

  // Frame after recovery
  const p2 = [{ data: Buffer.concat([Buffer.from([0x41, 0x88]), Buffer.alloc(50, 0x22)]), type: NAL_TYPES.NON_IDR }];
  const pkts2 = encoder.packetizeAccessUnit(p2, 30);
  assert.equal(pkts2[0].readUInt32BE(4), (idrTs + 3000) >>> 0, 'Post-recovery frame timestamp must increment by one frame interval');
});

test('Test 6 — Marker bit: only final packet of IDR AU has M=1, all previous have M=0 (including FU-A fragmentation)', async () => {
  const encoder = new VideoEncoder({ mtu: 500, fps: 30 });
  encoder._latestFrame = Buffer.from('fake-jpeg-frame');

  // Large IDR of 1200 bytes to force FU-A fragmentation
  const largeIdr = Buffer.concat([prefix4, Buffer.from([0x65, 0x88]), Buffer.alloc(1200, 0x55)]);
  const largeIdrH264 = Buffer.concat([defaultSps, defaultPps, largeIdr]);

  encoder._spawnEncoderProcess = () => createMockEncoderProc(largeIdrH264);
  const packets = await encoder.requestKeyframe();
  assert.ok(packets.length >= 4, 'Must produce multiple packets including FU-A fragments');

  for (let i = 0; i < packets.length - 1; i++) {
    const marker = (packets[i][1] & 0x80) !== 0;
    assert.equal(marker, false, `Packet ${i} of IDR AU must have Marker bit M=0`);
    assert.equal(packets[i].marker, 0);
  }

  const lastPacket = packets[packets.length - 1];
  const lastMarker = (lastPacket[1] & 0x80) !== 0;
  assert.equal(lastMarker, true, 'Final packet of IDR AU must have Marker bit M=1');
  assert.equal(lastPacket.marker, 1);
});

test('Test 7 — Retry after failure: failure rejects promise, leaves encoder in valid state, allows subsequent recovery', async () => {
  const encoder = new VideoEncoder();
  encoder._latestFrame = Buffer.from('fake-jpeg-frame');

  // First attempt fails during process spawn / write
  encoder._spawnEncoderProcess = () => {
    const mock = new EventEmitter();
    mock.stdin = { write: () => true, end: () => {} };
    mock.stdout = new EventEmitter();
    mock.stderr = new EventEmitter();
    mock.kill = () => {};
    setImmediate(() => mock.emit('error', new Error('Encoder spawn failed')));
    return mock;
  };

  await assert.rejects(
    async () => {
      await encoder.requestKeyframe();
    },
    /Encoder spawn failed/
  );

  assert.equal(encoder._recoveryState, RECOVERY_STATES.NORMAL);
  assert.equal(encoder._pendingKeyframePromise, null);
  assert.equal(encoder.metrics.forcedIdrFailures, 1);

  // Second attempt succeeds
  encoder._spawnEncoderProcess = () => createMockEncoderProc(defaultIdrH264);
  const packets = await encoder.requestKeyframe();
  assert.ok(Array.isArray(packets) && packets.length >= 3);
  assert.equal(encoder.metrics.forcedIdrSuccesses, 1);
  assert.equal(encoder._recoveryState, RECOVERY_STATES.NORMAL);
});

test('Test 8 — Same encoder reference chain: forced IDR and subsequent P-frames originate from the same encoder instance', async () => {
  const encoder = new VideoEncoder();
  encoder._latestFrame = Buffer.from('fake-jpeg-0');

  // Initial encoder procA
  const procA = createMockEncoderProc();
  procA.name = 'procA';
  encoder.ffmpegProc = procA;
  encoder._isEncoding = true;

  assert.equal(encoder.ffmpegProc, procA, 'Initially encoder is procA');

  // Trigger keyframe recovery which will spawn procB
  let procB;
  encoder._spawnEncoderProcess = () => {
    procB = createMockEncoderProc(defaultIdrH264);
    procB.name = 'procB';
    return procB;
  };

  const idrPackets = await encoder.requestKeyframe();
  assert.ok(idrPackets.length >= 3);

  // 1. Verify old encoder procA was retired
  assert.equal(procA.isKilled, true, 'Old encoder procA must be killed/retired');
  assert.notEqual(encoder.ffmpegProc, procA, 'Active encoder must no longer be procA');

  // 2. Verify active encoder is now procB
  assert.equal(encoder.ffmpegProc, procB, 'Active encoder must now be procB');

  // 3. Encode next frame - must be written to procB.stdin!
  const nextFrameBytes = Buffer.from('fake-jpeg-1');
  let writtenToProcB = false;
  procB.stdin.write = (chunk) => {
    if (chunk && chunk.includes('fake-jpeg-1')) {
      writtenToProcB = true;
    }
    return true;
  };

  encoder.encodeFrame(nextFrameBytes);
  assert.equal(writtenToProcB, true, 'Subsequent frame must be fed to the SAME replacement encoder (procB)');

  // 4. When procB outputs a P-frame, it is processed as part of procB reference chain
  const pFrameData = Buffer.concat([prefix4, Buffer.from([0x41, 0x88]), Buffer.alloc(40, 0xee)]);
  const nextDelimiter = Buffer.concat([prefix4, Buffer.from([0x41, 0x88])]);

  let emittedPackets = null;
  encoder.once('packets', (pkts) => {
    emittedPackets = pkts;
  });

  procB.stdout.emit('data', Buffer.concat([pFrameData, nextDelimiter]));

  assert.ok(emittedPackets, 'procB must output subsequent P-frame packets');
  const lastIdrSeq = idrPackets[idrPackets.length - 1].readUInt16BE(2);
  assert.equal(emittedPackets[0].readUInt16BE(2), lastIdrSeq + 1, 'RTP sequence continues seamlessly from IDR into procB P-frame');
});

