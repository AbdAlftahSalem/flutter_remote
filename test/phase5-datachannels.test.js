import test from 'node:test';
import assert from 'node:assert/strict';
import { DataChannelManager } from '../src/webrtc/DataChannelManager.js';
import { CHANNELS, CHANNEL_CONFIGS } from '../src/shared/constants.js';

test('Phase 5: DataChannel configuration semantics', () => {
  assert.equal(CHANNEL_CONFIGS[CHANNELS.INPUT].ordered, false);
  assert.equal(CHANNEL_CONFIGS[CHANNELS.INPUT].maxRetransmits, 0);

  assert.equal(CHANNEL_CONFIGS[CHANNELS.KEYBOARD].ordered, true);
  assert.equal(CHANNEL_CONFIGS[CHANNELS.CONTROL].ordered, true);
  assert.equal(CHANNEL_CONFIGS[CHANNELS.TELEMETRY].ordered, false);
});

test('Phase 5: Backpressure drop policy for pointer move events', () => {
  let mockBufferedAmount = 0;
  const sentMessages = [];

  const mockInputDc = {
    bufferedAmount: () => mockBufferedAmount,
    sendMessage: (msg) => sentMessages.push(msg),
  };

  const mockPeer = {
    sessionId: 'test-sess',
    createDataChannel: () => mockInputDc,
  };

  const manager = new DataChannelManager(mockPeer, {
    bufferedAmountThreshold: 1000,
  });
  manager.attachChannel(CHANNELS.INPUT, mockInputDc);

  // 1. Normal state (bufferedAmount <= 1000): all events sent
  const sentDown = manager.sendInput({ v: 2, type: 'pointer', event: 'down', x: 0.5, y: 0.5 });
  const sentMove = manager.sendInput({ v: 2, type: 'pointer', event: 'move', x: 0.51, y: 0.51 });
  assert.ok(sentDown);
  assert.ok(sentMove);
  assert.equal(manager.droppedInputEvents, 0);
  assert.equal(sentMessages.length, 2);

  // 2. Congested state (bufferedAmount > 1000): pointer move is DROPPED
  mockBufferedAmount = 5000;
  const droppedMove = manager.sendInput({ v: 2, type: 'pointer', event: 'move', x: 0.52, y: 0.52 });
  assert.equal(droppedMove, false);
  assert.equal(manager.droppedInputEvents, 1);
  assert.equal(sentMessages.length, 2); // Unchanged

  // 3. Pointer up during congestion is NOT dropped (vital for touch release)
  const sentUp = manager.sendInput({ v: 2, type: 'pointer', event: 'up', x: 0.52, y: 0.52 });
  assert.ok(sentUp);
  assert.equal(sentMessages.length, 3);
});

test('Phase 5: Keyboard events are never dropped during congestion', () => {
  const sentKeyboard = [];
  const mockKeyboardDc = {
    bufferedAmount: () => 100000, // Highly congested buffer
    sendMessage: (msg) => sentKeyboard.push(msg),
  };

  const mockPeer = { sessionId: 'test-sess' };
  const manager = new DataChannelManager(mockPeer, { bufferedAmountThreshold: 1000 });
  manager.attachChannel(CHANNELS.KEYBOARD, mockKeyboardDc);

  // Send keyboard events during congestion
  const sent1 = manager.sendKeyboard({ v: 2, type: 'keyboard', event: 'keydown', key: 'h' });
  const sent2 = manager.sendKeyboard({ v: 2, type: 'keyboard', event: 'keydown', key: 'i' });

  assert.ok(sent1);
  assert.ok(sent2);
  assert.equal(sentKeyboard.length, 2);
});

test('Phase 5: Incoming message dispatching to channel handlers', () => {
  let messageHandler;
  const mockDc = {
    onMessage: (fn) => { messageHandler = fn; },
  };

  const mockPeer = { sessionId: 'test-sess' };
  const manager = new DataChannelManager(mockPeer);
  manager.attachChannel(CHANNELS.CONTROL, mockDc);

  let receivedControl = null;
  manager.on('control', (data) => {
    receivedControl = data;
  });

  // Simulate incoming control message
  messageHandler(JSON.stringify({ v: 2, type: 'control', command: 'orientation', value: 'landscape' }));

  assert.ok(receivedControl);
  assert.equal(receivedControl.command, 'orientation');
  assert.equal(receivedControl.value, 'landscape');
});
