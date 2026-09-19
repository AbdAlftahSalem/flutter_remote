import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { ServeSimAdapter } from '../src/simulator/ServeSimAdapter.js';

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

test('Phase 7: ServeSimAdapter offline buffering and flush on connect', async () => {
  const mockPort = 39873;
  const receivedMessages = [];

  const adapter = new ServeSimAdapter({
    port: mockPort,
    width: 720,
    height: 1280,
  });

  // Queue events while offline
  await adapter.pointer({ event: 'down', x: 0.1, y: 0.1 });
  await adapter.pointer({ event: 'up', x: 0.1, y: 0.1 });

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

  assert.equal(receivedMessages.length, 2);
  assert.equal(receivedMessages[0].event, 'down');
  assert.equal(receivedMessages[1].event, 'up');

  await adapter.close();
  await new Promise((r) => wss.close(r));
});
