import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DataChannelRouter } from '../templates/peer/DataChannelRouter.cjs';
import { PeerSession } from '../templates/peer/PeerSession.cjs';
import { WebRTCStatsCollector } from '../client/webrtc/WebRTCStatsCollector.js';
import { FlutterRemoteClient } from '../client/flutter-remote-client.js';

// --- DataChannel Routing Regression Tests (Section 34) ---

test('Phase 19: Test 1 — Exactly One serveSimWs Message Listener in PeerSession', () => {
  const mockWs = new EventEmitter();
  const mockServeSimWs = new EventEmitter();

  const mockServeSimConsumer = {
    serveSimWs: mockServeSimWs,
    initServeSimWs: () => {},
    sendToServeSim: () => {},
    ensureLocalStream: () => {},
  };

  const session = new PeerSession({
    ws: mockWs,
    ndc: {},
    videoEncoder: { hasKeyframe: () => false },
    serveSimConsumer: mockServeSimConsumer,
    activeVideoTracks: new Set(),
  });

  // Mock peer onDataChannel trigger
  let dataChannelCb;
  session.peer = {
    onDataChannel: (cb) => { dataChannelCb = cb; },
    setRemoteDescription: () => {},
    close: () => {},
  };

  // Register 4 DataChannels
  const createMockDc = (label) => ({
    getLabel: () => label,
    onMessage: () => {},
    sendMessage: () => {},
  });

  session.router.setServeSimWs(mockServeSimWs);
  session.router.registerChannel('input', createMockDc('input'));
  session.router.registerChannel('keyboard', createMockDc('keyboard'));
  session.router.registerChannel('control', createMockDc('control'));
  session.router.registerChannel('telemetry', createMockDc('telemetry'));
  session.router.start();

  // Verify only 1 listener exists on serveSimWs despite 4 channels
  assert.equal(mockServeSimWs.listenerCount('message'), 1, 'Must have exactly one serveSimWs message listener');

  session.close();
  assert.equal(mockServeSimWs.listenerCount('message'), 0, 'Must clean up listener after close');
});

test('Phase 19: Test 2 — Correct Routing for Input messages', () => {
  const mockServeSimWs = new EventEmitter();
  const router = new DataChannelRouter({ serveSimWs: mockServeSimWs });

  let inputCalls = 0;
  let keyboardCalls = 0;
  let controlCalls = 0;
  let telemetryCalls = 0;

  router.registerChannel('input', { sendMessage: () => { inputCalls++; } });
  router.registerChannel('keyboard', { sendMessage: () => { keyboardCalls++; } });
  router.registerChannel('control', { sendMessage: () => { controlCalls++; } });
  router.registerChannel('telemetry', { sendMessage: () => { telemetryCalls++; } });

  router.start();

  // Send pointer message intended for input
  mockServeSimWs.emit('message', JSON.stringify({ v: 2, type: 'pointer', event: 'move', x: 0.5, y: 0.5 }));

  assert.equal(inputCalls, 1, 'Input channel must receive pointer message exactly once');
  assert.equal(keyboardCalls, 0, 'Keyboard channel must not receive pointer message');
  assert.equal(controlCalls, 0, 'Control channel must not receive pointer message');
  assert.equal(telemetryCalls, 0, 'Telemetry channel must not receive pointer message');

  router.stop();
});

test('Phase 19: Test 3 — Correct Routing for Keyboard messages', () => {
  const mockServeSimWs = new EventEmitter();
  const router = new DataChannelRouter({ serveSimWs: mockServeSimWs });

  let inputCalls = 0;
  let keyboardCalls = 0;
  let controlCalls = 0;
  let telemetryCalls = 0;

  router.registerChannel('input', { sendMessage: () => { inputCalls++; } });
  router.registerChannel('keyboard', { sendMessage: () => { keyboardCalls++; } });
  router.registerChannel('control', { sendMessage: () => { controlCalls++; } });
  router.registerChannel('telemetry', { sendMessage: () => { telemetryCalls++; } });

  router.start();

  // Send keyboard message
  mockServeSimWs.emit('message', JSON.stringify({ v: 2, type: 'keyboard', event: 'keydown', key: 'a' }));

  assert.equal(keyboardCalls, 1, 'Keyboard channel must receive keyboard message exactly once');
  assert.equal(inputCalls, 0, 'Input channel must not receive keyboard message');
  assert.equal(controlCalls, 0, 'Control channel must not receive keyboard message');
  assert.equal(telemetryCalls, 0, 'Telemetry channel must not receive keyboard message');

  router.stop();
});

test('Phase 19: Test 4 — Correct Routing for Control messages', () => {
  const mockServeSimWs = new EventEmitter();
  const router = new DataChannelRouter({ serveSimWs: mockServeSimWs });

  let inputCalls = 0;
  let keyboardCalls = 0;
  let controlCalls = 0;
  let telemetryCalls = 0;

  router.registerChannel('input', { sendMessage: () => { inputCalls++; } });
  router.registerChannel('keyboard', { sendMessage: () => { keyboardCalls++; } });
  router.registerChannel('control', { sendMessage: () => { controlCalls++; } });
  router.registerChannel('telemetry', { sendMessage: () => { telemetryCalls++; } });

  router.start();

  // Send control / clipboard message
  mockServeSimWs.emit('message', JSON.stringify({ v: 2, type: 'control', command: 'orientation', value: 'portrait' }));

  assert.equal(controlCalls, 1, 'Control channel must receive control message exactly once');
  assert.equal(inputCalls, 0, 'Input channel must not receive control message');
  assert.equal(keyboardCalls, 0, 'Keyboard channel must not receive control message');
  assert.equal(telemetryCalls, 0, 'Telemetry channel must not receive control message');

  // Test clipboard
  mockServeSimWs.emit('message', JSON.stringify({ v: 2, type: 'clipboard', text: 'hello' }));
  assert.equal(controlCalls, 2, 'Control channel must receive clipboard message');

  router.stop();
});

test('Phase 19: Test 5 — No Duplicate Delivery across any channel', () => {
  const mockServeSimWs = new EventEmitter();
  const router = new DataChannelRouter({ serveSimWs: mockServeSimWs });

  const delivered = [];

  router.registerChannel('input', { sendMessage: (m) => delivered.push({ ch: 'input', m }) });
  router.registerChannel('keyboard', { sendMessage: (m) => delivered.push({ ch: 'keyboard', m }) });
  router.registerChannel('control', { sendMessage: (m) => delivered.push({ ch: 'control', m }) });
  router.registerChannel('telemetry', { sendMessage: (m) => delivered.push({ ch: 'telemetry', m }) });

  router.start();

  // Send 1 message
  mockServeSimWs.emit('message', JSON.stringify({ v: 2, type: 'scroll', deltaX: 0, deltaY: 10 }));

  assert.equal(delivered.length, 1, 'Must receive exactly one message across all channels');
  assert.equal(delivered[0].ch, 'input');

  router.stop();
});

test('Phase 19: Test 6 — Listener Cleanup on Session Close', () => {
  const mockServeSimWs = new EventEmitter();
  const router = new DataChannelRouter({ serveSimWs: mockServeSimWs });

  router.start();
  assert.equal(mockServeSimWs.listenerCount('message'), 1, 'Before close: 1 listener');

  router.stop();
  assert.equal(mockServeSimWs.listenerCount('message'), 0, 'After close: 0 listeners');
});

test('Phase 19: Test 7 — Reconnect Safety (Listener never accumulates)', () => {
  const mockServeSimWs = new EventEmitter();

  for (let i = 0; i < 3; i++) {
    const router = new DataChannelRouter({ serveSimWs: mockServeSimWs });
    router.start();
    assert.equal(mockServeSimWs.listenerCount('message'), 1, `Cycle ${i + 1}: exactly 1 listener active`);
    router.stop();
    assert.equal(mockServeSimWs.listenerCount('message'), 0, `Cycle ${i + 1}: exactly 0 listeners after stop`);
  }
});

// --- Stats & Candidate Pair Tests (Sections 36 & 37) ---

test('Phase 19: Delta packet loss, counter reset, and zero packets edge cases', async () => {
  let mockStats = [];
  const mockPeer = {
    getStats: async () => mockStats,
  };

  const collector = new WebRTCStatsCollector(mockPeer, { intervalMs: 1000 });

  // Baseline: received=1000, lost=10
  mockStats = [
    { type: 'inbound-rtp', kind: 'video', packetsReceived: 1000, packetsLost: 10, bytesReceived: 100000 },
  ];
  await collector.sample();
  assert.equal(collector.metrics.packets.lossRate, 0);

  // Sample 2: received=1100, lost=12
  // deltaReceived=100, deltaLost=2 -> total=102 -> lossRate = 2 / 102 ≈ 0.0196078 (1.96%)
  mockStats = [
    { type: 'inbound-rtp', kind: 'video', packetsReceived: 1100, packetsLost: 12, bytesReceived: 110000 },
  ];
  await collector.sample();
  const expectedRate = 2 / 102;
  assert.ok(Math.abs(collector.metrics.packets.lossRate - expectedRate) < 0.0001);
  assert.equal(collector.metrics.packets.lossPercentage, '1.96%');

  // Counter reset: lost drops from 12 to 2 (e.g. SSRC reset)
  // Must NOT produce negative loss; deltaLost should be 0
  mockStats = [
    { type: 'inbound-rtp', kind: 'video', packetsReceived: 1200, packetsLost: 2, bytesReceived: 120000 },
  ];
  await collector.sample();
  assert.equal(collector.metrics.packets.lossRate, 0);
  assert.equal(collector.metrics.packets.lossPercentage, '0.00%');

  // No packets: deltaReceived=0, deltaLost=0
  mockStats = [
    { type: 'inbound-rtp', kind: 'video', packetsReceived: 1200, packetsLost: 2, bytesReceived: 120000 },
  ];
  await collector.sample();
  assert.equal(collector.metrics.packets.lossRate, 0);
  assert.equal(collector.metrics.packets.lossPercentage, '0.00%');
});

test('Phase 19: Candidate Pair Selection Hierarchy (Section 37)', () => {
  const collector = new WebRTCStatsCollector(null);

  // 1. Selected candidate pair exists via transport.selectedCandidatePairId
  const statsWithTransport = [
    { type: 'transport', id: 't1', selectedCandidatePairId: 'cp-selected' },
    { type: 'candidate-pair', id: 'cp-selected', state: 'succeeded', currentRoundTripTime: 0.025 },
    { type: 'candidate-pair', id: 'cp-other', state: 'succeeded', currentRoundTripTime: 0.050 },
  ];
  const pair1 = collector.getSelectedCandidatePair(statsWithTransport);
  assert.ok(pair1);
  assert.equal(pair1.id, 'cp-selected');
  assert.equal(pair1.currentRoundTripTime, 0.025);

  // 2. Selected pair unavailable, fallback to nominated/active pair
  const statsWithActive = [
    { type: 'candidate-pair', id: 'cp-inactive', state: 'succeeded', currentRoundTripTime: 0.060 },
    { type: 'candidate-pair', id: 'cp-active', active: true, state: 'succeeded', currentRoundTripTime: 0.030 },
  ];
  const pair2 = collector.getSelectedCandidatePair(statsWithActive);
  assert.ok(pair2);
  assert.equal(pair2.id, 'cp-active');

  // 3. Fallback to succeeded pair
  const statsWithSucceeded = [
    { type: 'candidate-pair', id: 'cp-failed', state: 'failed' },
    { type: 'candidate-pair', id: 'cp-succ', state: 'succeeded', currentRoundTripTime: 0.040 },
  ];
  const pair3 = collector.getSelectedCandidatePair(statsWithSucceeded);
  assert.ok(pair3);
  assert.equal(pair3.id, 'cp-succ');

  // 4. No candidate pair exists -> returns null without throwing
  assert.equal(collector.getSelectedCandidatePair([]), null);
  assert.equal(collector.getSelectedCandidatePair(null), null);
  assert.equal(collector.getSelectedCandidatePair([{ type: 'inbound-rtp' }]), null);
});

// --- Browser Module Architecture Tests (Section 35) ---

test('Phase 19: FlutterRemoteClient orchestrator wiring and clean lifecycle', () => {
  const clientPath = join(process.cwd(), 'client', 'flutter-remote-client.js');
  const clientCode = readFileSync(clientPath, 'utf8');

  // Verify no duplicate class definitions exist
  const duplicateClasses = [
    'class ConnectionState',
    'class ReconnectController',
    'class SignalingClient',
    'class PeerConnectionManager',
    'class DataChannelManager',
    'class WebRTCStatsCollector',
    'class InputController',
    'class KeyboardController',
    'class ClipboardController',
    'class VideoRenderer',
    'class SessionUI',
    'class DebugOverlay',
  ];
  for (const cls of duplicateClasses) {
    assert.ok(!clientCode.includes(cls), `flutter-remote-client.js must not declare ${cls}`);
  }

  // Instantiate client with autoConnect=false to verify dependency wiring and destruction
  const client = new FlutterRemoteClient({
    sessionId: 'test-sess',
    token: 'test-token',
    debugMode: false,
    autoConnect: false,
    container: null,
  });

  assert.ok(client.connectionState, 'Must have ConnectionState');
  assert.ok(client.reconnectController, 'Must have ReconnectController');
  assert.ok(client.peerConnectionManager, 'Must have PeerConnectionManager');
  assert.ok(client.dataChannelManager, 'Must have DataChannelManager');
  assert.ok(client.statsCollector, 'Must have WebRTCStatsCollector');
  assert.ok(client.signaling, 'Must have SignalingClient');

  // Verify clean shutdown
  client.destroy();
  assert.equal(client.connectionState.state, 'CLOSED');
  assert.equal(client._destroyed, true);
});
