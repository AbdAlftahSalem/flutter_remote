import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { ServeSimAdapter } from '../src/simulator/ServeSimAdapter.js';
import { InputRouter } from '../src/input/InputRouter.js';

test('Phase 7: ServeSimAdapter normalized to pixel scaling and message formatting', async () => {
  const mockPort = 39872;
  const receivedMessages = [];

  const wss = new WebSocketServer({ port: mockPort });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      receivedMessages.push(JSON.parse(data.toString()));
    });
  });

  const adapter = new ServeSimAdapter({
    port: mockPort,
    width: 720,
    height: 1280,
  });

  await adapter.connect();

  // 1. Pointer event
  await adapter.pointer({ event: 'down', pointerId: 1, x: 0.5, y: 0.25 });

  // 2. Keyboard event with text & composition
  await adapter.keyboard({ event: 'input', key: 'a', text: 'مرحبا', isComposing: false });

  // 3. Scroll event
  await adapter.scroll({ deltaX: 0, deltaY: -50, x: 0.5, y: 0.5 });

  // 4. Clipboard event
  await adapter.clipboard('copied text');

  // Wait briefly for WebSocket dispatch
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(receivedMessages.length, 4);

  // Validate pointer scaling
  const ptr = receivedMessages[0];
  assert.equal(ptr.type, 'pointer');
  assert.equal(ptr.event, 'down');
  assert.equal(ptr.x, 360); // 0.5 * 720
  assert.equal(ptr.y, 320); // 0.25 * 1280

  // Validate keyboard
  const kb = receivedMessages[1];
  assert.equal(kb.type, 'keyboard');
  assert.equal(kb.text, 'مرحبا');

  // Validate scroll
  const scroll = receivedMessages[2];
  assert.equal(scroll.type, 'scroll');
  assert.equal(scroll.deltaY, -50);

  // Validate clipboard
  const clip = receivedMessages[3];
  assert.equal(clip.type, 'clipboard');
  assert.equal(clip.text, 'copied text');

  await adapter.close();
  await new Promise((r) => wss.close(r));
});

test('Phase 7: ServeSimAdapter offline buffering, move coalescing, and flush on connect', async () => {
  const mockPort = 39873;
  const receivedMessages = [];

  const adapter = new ServeSimAdapter({
    port: mockPort,
    width: 720,
    height: 1280,
  });

  // Queue events while offline: down, 3 moves (should coalesce to 1), up
  await adapter.pointer({ event: 'down', x: 0.1, y: 0.1 });
  await adapter.pointer({ event: 'move', x: 0.2, y: 0.2 });
  await adapter.pointer({ event: 'move', x: 0.3, y: 0.3 });
  await adapter.pointer({ event: 'move', x: 0.4, y: 0.4 });
  await adapter.pointer({ event: 'up', x: 0.4, y: 0.4 });

  // Now start server
  const wss = new WebSocketServer({ port: mockPort });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      receivedMessages.push(JSON.parse(data.toString()));
    });
  });

  // Connect and flush
  await adapter.connect();
  await new Promise((r) => setTimeout(r, 100));

  // Should have down, latest move (0.4), and up -> 3 messages, NOT 5!
  assert.equal(receivedMessages.length, 3);
  assert.equal(receivedMessages[0].event, 'down');
  assert.equal(receivedMessages[1].event, 'move');
  assert.equal(receivedMessages[1].normalizedX, 0.4);
  assert.equal(receivedMessages[2].event, 'up');

  await adapter.close();
  await new Promise((r) => wss.close(r));
});

test('Phase 7: ServeSimAdapter getServeSimWs connection promise sharing', async () => {
  const mockPort = 39874;
  const wss = new WebSocketServer({ port: mockPort });

  const adapter = new ServeSimAdapter({
    port: mockPort,
    width: 720,
    height: 1280,
  });

  // Call getServeSimWs multiple times simultaneously
  const p1 = adapter.getServeSimWs();
  const p2 = adapter.getServeSimWs();
  assert.equal(p1, p2, 'Concurrent calls to getServeSimWs must return the same promise');

  const [ws1, ws2] = await Promise.all([p1, p2]);
  assert.ok(ws1);
  assert.equal(ws1, ws2);
  assert.equal(ws1.readyState, 1 /* OPEN */);

  await adapter.close();
  await new Promise((r) => wss.close(r));
});

test('Phase 7: InputRouter stale out-of-order pointer move dropping', async () => {
  const dispatched = [];
  const mockAdapter = {
    pointer: async (e) => dispatched.push(e),
    keyboard: async () => {},
    scroll: async () => {},
    clipboard: async () => {},
  };

  const router = new InputRouter(mockAdapter);

  // 1. Valid sequential move
  await router.handleInputMessage({ v: 2, type: 'pointer', seq: 10, ts: Date.now(), event: 'move', x: 0.1, y: 0.1 });
  assert.equal(dispatched.length, 1);

  // 2. Stale out-of-order move (seq 9 < 10) -> dropped!
  await router.handleInputMessage({ v: 2, type: 'pointer', seq: 9, ts: Date.now(), event: 'move', x: 0.05, y: 0.05 });
  assert.equal(dispatched.length, 1, 'Stale move must be dropped');
  assert.equal(router.droppedStaleMoves, 1);

  // 3. Stale sequence number but down event -> MUST NOT be dropped!
  await router.handleInputMessage({ v: 2, type: 'pointer', seq: 8, ts: Date.now(), event: 'down', x: 0.2, y: 0.2 });
  assert.equal(dispatched.length, 2, 'Down event must NEVER be dropped even with older seq');
});
