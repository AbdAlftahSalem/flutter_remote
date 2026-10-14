import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameController } from '../src/media/FrameController.js';
import { RtpPacketizer, NAL_TYPES } from '../src/media/RtpPacketizer.js';
import { KeyframeController } from '../src/media/KeyframeController.js';
import { VideoEncoder } from '../src/media/VideoEncoder.js';
import { AdaptiveBitrate } from '../src/media/AdaptiveBitrate.js';
import { InputCoalescer } from '../src/input/InputCoalescer.js';
import { ConnectionState } from '../client/connection/ConnectionState.js';
import { ReconnectController } from '../client/connection/ReconnectController.js';
import { WebRTCStatsCollector } from '../client/webrtc/WebRTCStatsCollector.js';
import { SessionMetrics } from '../src/observability/SessionMetrics.js';
import { ServerMetrics } from '../src/observability/ServerMetrics.js';

test('Phase 18: FrameController bounded queue and stale frame dropping', () => {
  const controller = new FrameController({ maxQueueSize: 3 });

  for (let i = 1; i <= 6; i++) {
    controller.pushFrame(Buffer.from(`frame-${i}`));
  }

  assert.equal(controller.queueLength, 3);
  assert.equal(controller.totalFramesReceived, 6);
  assert.equal(controller.totalFramesDropped, 3);

  const f1 = controller.popFrame();
  const f2 = controller.popFrame();
  const f3 = controller.popFrame();

  assert.equal(f1.frame.toString(), 'frame-4');
  assert.equal(f2.frame.toString(), 'frame-5');
  assert.equal(f3.frame.toString(), 'frame-6');
  assert.equal(controller.queueLength, 0);
});

test('Phase 18: Delta-based Packet Loss Calculation in WebRTCStatsCollector', async () => {
  let mockStats = [];
  const mockPeer = {
    getStats: async () => mockStats,
  };

  const collector = new WebRTCStatsCollector(mockPeer, { intervalMs: 1000 });

  // Sample 1: Baseline (received=1000, lost=10)
  mockStats = [
    {
      type: 'inbound-rtp',
      kind: 'video',
      framesPerSecond: 30,
      bytesReceived: 500000,
      packetsReceived: 1000,
      packetsLost: 10,
    },
    {
      type: 'candidate-pair',
      state: 'succeeded',
      currentRoundTripTime: 0.042,
    },
  ];

  await collector.sample();
  // First sample sets baseline, loss rate should be 0
  assert.equal(collector.metrics.packets.lossRate, 0);
  assert.equal(collector.metrics.packets.lossPercentage, '0.00%');
  assert.equal(collector.metrics.connection.rtt, 42);

  // Sample 2: Delta (received=1100, lost=12)
  // lostDelta = 2, receivedDelta = 100, total = 102 -> lossRate = 2 / 102 = ~0.0196 (1.96%)
  mockStats = [
    {
      type: 'inbound-rtp',
      kind: 'video',
      framesPerSecond: 30,
      bytesReceived: 550000,
      packetsReceived: 1100,
      packetsLost: 12,
    },
    {
      type: 'candidate-pair',
      state: 'succeeded',
      currentRoundTripTime: 0.038,
    },
  ];

  await collector.sample();
  const expectedRate = 2 / 102;
  assert.ok(Math.abs(collector.metrics.packets.lossRate - expectedRate) < 0.0001);
  assert.equal(collector.metrics.packets.lossPercentage, '1.96%');
  assert.equal(collector.metrics.packets.lost, 12);
  assert.equal(collector.metrics.packets.received, 1100);

  // Sample 3: Zero delta (no new packets) -> 0% without NaN
  mockStats = [
    {
      type: 'inbound-rtp',
      kind: 'video',
      framesPerSecond: 0,
      bytesReceived: 550000,
      packetsReceived: 1100,
      packetsLost: 12,
    },
  ];

  await collector.sample();
  assert.equal(collector.metrics.packets.lossRate, 0);
  assert.equal(collector.metrics.packets.lossPercentage, '0.00%');
});

test('Phase 18: AdaptiveBitrate downgrade, upgrade, and hysteresis', () => {
  const abr = new AdaptiveBitrate({ initialLevel: 'MEDIUM' });
  assert.equal(abr.currentLevel, 'MEDIUM');

  // Single bad sample: MUST NOT downgrade yet (hysteresis: requires 2 consecutive)
  abr.evaluateMetrics({ rtt: 350, packetLoss: 0.08, droppedFrames: 10 });
  assert.equal(abr.currentLevel, 'MEDIUM');

  // Second bad sample: triggers downgrade to LOW
  abr.evaluateMetrics({ rtt: 350, packetLoss: 0.08, droppedFrames: 10 });
  assert.equal(abr.currentLevel, 'LOW');

  // Intermittent good sample: resets consecutive good counter, no upgrade
  abr.evaluateMetrics({ rtt: 30, packetLoss: 0, droppedFrames: 0 });
  assert.equal(abr.currentLevel, 'LOW');

  // Four more good samples (total 5 consecutive): triggers upgrade to MEDIUM
  for (let i = 0; i < 4; i++) {
    abr.evaluateMetrics({ rtt: 30, packetLoss: 0, droppedFrames: 0 });
  }
  assert.equal(abr.currentLevel, 'MEDIUM');
});

test('Phase 18: Wheel input delta accumulation and coalescing', () => {
  let pendingDeltaX = 0;
  let pendingDeltaY = 0;
  let dispatchedEvents = [];

  const handleWheel = (e) => {
    pendingDeltaX += e.deltaX;
    pendingDeltaY += e.deltaY;
  };

  const flushWheel = () => {
    if (pendingDeltaX !== 0 || pendingDeltaY !== 0) {
      dispatchedEvents.push({
        event: 'wheel',
        deltaX: pendingDeltaX,
        deltaY: pendingDeltaY,
      });
      pendingDeltaX = 0;
      pendingDeltaY = 0;
    }
  };

  // Simulate burst of 5 rapid wheel events
  handleWheel({ deltaX: 0, deltaY: 10 });
  handleWheel({ deltaX: 0, deltaY: 15 });
  handleWheel({ deltaX: 5, deltaY: 20 });
  handleWheel({ deltaX: -2, deltaY: 12 });
  handleWheel({ deltaX: 0, deltaY: 8 });

  assert.equal(dispatchedEvents.length, 0, 'No event dispatched before flush');
  assert.equal(pendingDeltaX, 3);
  assert.equal(pendingDeltaY, 65);

  // RAF flush
  flushWheel();

  assert.equal(dispatchedEvents.length, 1, 'Exactly one combined event dispatched');
  assert.equal(dispatchedEvents[0].deltaX, 3);
  assert.equal(dispatchedEvents[0].deltaY, 65);
  assert.equal(pendingDeltaX, 0);
  assert.equal(pendingDeltaY, 0);

  // Second flush without new events does nothing
  flushWheel();
  assert.equal(dispatchedEvents.length, 1);
});

test('Phase 18: DataChannel backpressure drop policy for pointer move vs button events', () => {
  const sent = [];
  let mockBufferedAmount = 0;
  const mockDc = {
    readyState: 'open',
    get bufferedAmount() { return mockBufferedAmount; },
    send: (msg) => sent.push(JSON.parse(msg)),
  };

  const sendPointer = (evt) => {
    if (mockDc.bufferedAmount > 65536 && evt.event === 'move') {
      return false;
    }
    mockDc.send(JSON.stringify(evt));
    return true;
  };

  // Normal buffer: move is sent
  mockBufferedAmount = 1024;
  assert.ok(sendPointer({ event: 'move', x: 0.5, y: 0.5 }));
  assert.equal(sent.length, 1);

  // Congested buffer (>64KB): move is DROPPED
  mockBufferedAmount = 70000;
  assert.equal(sendPointer({ event: 'move', x: 0.51, y: 0.51 }), false);
  assert.equal(sent.length, 1);

  // Congested buffer: down and up are ALWAYS sent
  assert.ok(sendPointer({ event: 'down', x: 0.51, y: 0.51 }));
  assert.ok(sendPointer({ event: 'up', x: 0.51, y: 0.51 }));
  assert.equal(sent.length, 3);
});

test('Phase 18: ConnectionState generation advancement and stale rejection', () => {
  const conn = new ConnectionState();
  assert.equal(conn.generation, 1);
  assert.equal(conn.state, 'IDLE');

  conn.set('CONNECTING');
  assert.equal(conn.state, 'CONNECTING');

  // Generation 1 messages are valid
  assert.equal(conn.isStale(1), false);
  // Unspecified generation is not stale
  assert.equal(conn.isStale(undefined), false);

  // Advance generation on reconnect
  conn.advanceGeneration();
  assert.equal(conn.generation, 2);

  // Generation 1 message is now STALE
  assert.equal(conn.isStale(1), true);
  // Generation 2 message is VALID
  assert.equal(conn.isStale(2), false);
});

test('Phase 18: RtpPacketizer sequence number continuity, timestamp progression, and marker bit', () => {
  const packetizer = new RtpPacketizer({ payloadType: 98, ssrc: 7777, mtu: 1200 });

  // Frame 1: 2 NALs (SPS and PPS)
  const frame1Nals = [
    { data: Buffer.from([0x67, 0x42, 0x00, 0x0a]), type: NAL_TYPES.SPS },
    { data: Buffer.from([0x68, 0xce, 0x01]), type: NAL_TYPES.PPS },
  ];

  const packets1 = packetizer.packetizeAccessUnit(frame1Nals, 30);
  assert.equal(packets1.length, 2);

  // Sequence numbers strictly incrementing
  const seq0 = packets1[0].readUInt16BE(2);
  const seq1 = packets1[1].readUInt16BE(2);
  assert.equal(seq1, seq0 + 1);

  // Uniform timestamp within Frame 1
  const ts1 = packets1[0].readUInt32BE(4);
  assert.equal(packets1[1].readUInt32BE(4), ts1);

  // Marker bit M=1 strictly on the last packet of the AU
  assert.equal(packets1[0].marker, 0);
  assert.equal(packets1[1].marker, 1);

  // Frame 2: 1 NAL
  const frame2Nals = [
    { data: Buffer.from([0x65, 0x88, 0x01, 0x02]), type: NAL_TYPES.IDR },
  ];

  const packets2 = packetizer.packetizeAccessUnit(frame2Nals, 30);
  assert.equal(packets2.length, 1);

  // Sequence number continues from Frame 1
  const seq2 = packets2[0].readUInt16BE(2);
  assert.equal(seq2, seq1 + 1);

  // Timestamp increments by 3000 (90000 / 30)
  const ts2 = packets2[0].readUInt32BE(4);
  assert.equal(ts2, (ts1 + 3000) >>> 0);
  assert.equal(packets2[0].marker, 1);
});

test('Phase 18: SessionMetrics and ServerMetrics tracking and snapshot', () => {
  const session = new SessionMetrics('test-session-123');
  session.recordFrameReceived();
  session.recordFrameReceived();
  session.recordFrameDropped();
  session.recordPacketsSent(15);
  session.recordIdr();
  session.recordInputReceived();
  session.recordInputReceived();
  session.recordInputDropped();
  session.recordReconnect();

  const snap = session.getSnapshot();
  assert.equal(snap.sessionId, 'test-session-123');
  assert.equal(snap.media.framesReceived, 2);
  assert.equal(snap.media.framesDropped, 1);
  assert.equal(snap.media.dropRate, 0.5);
  assert.equal(snap.media.packetsSent, 15);
  assert.equal(snap.media.idrCount, 1);
  assert.equal(snap.input.eventsReceived, 2);
  assert.equal(snap.input.eventsDropped, 1);
  assert.equal(snap.input.dropRate, 0.5);
  assert.equal(snap.connection.reconnects, 1);

  const server = new ServerMetrics();
  server.sessions = 5;
  server.connectedSessions = 2;
  server.updateEncoder({ fps: 29.8, latencyMs: 12, encodedFrames: 450 });
  server.updateRtp({ packetsSent: 1200, framesPacketized: 450, idrFrames: 15 });

  const serverSnap = server.getSnapshot();
  assert.equal(serverSnap.sessions.total, 5);
  assert.equal(serverSnap.sessions.active, 2);
  assert.equal(serverSnap.encoder.encoderFps, 29.8);
  assert.equal(serverSnap.encoder.encodeLatency, 12);
  assert.equal(serverSnap.rtp.packetsSent, 1200);
});
