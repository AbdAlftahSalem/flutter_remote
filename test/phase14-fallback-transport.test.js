import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TransportManager,
  WebRTCInputTransport,
  WebSocketInputTransport,
} from '../src/webrtc/TransportManager.js';

test('Phase 14: TransportManager automatic failover to WebSocket', () => {
  let webrtcConnected = true;
  const webrtcMessages = [];
  const wsMessages = [];

  const mockDcManager = {
    isChannelOpen: () => webrtcConnected,
    sendInput: (e) => { webrtcMessages.push(e); return true; },
    sendKeyboard: (e) => { webrtcMessages.push(e); return true; },
    sendControl: (e) => { webrtcMessages.push(e); return true; },
  };

  const mockWs = {
    readyState: 1, // OPEN
    send: (msg) => wsMessages.push(msg),
  };

  const primary = new WebRTCInputTransport(mockDcManager);
  const fallback = new WebSocketInputTransport(mockWs);

  const manager = new TransportManager({ primary, fallback });

  assert.equal(manager.activeMode, 'webrtc');

  // 1. Send via WebRTC while connected
  manager.send({ type: 'pointer', event: 'down', x: 0.5, y: 0.5 });
  assert.equal(webrtcMessages.length, 1);
  assert.equal(wsMessages.length, 0);

  // 2. WebRTC disconnects -> auto failover to WebSocket
  webrtcConnected = false;
  manager.send({ type: 'pointer', event: 'move', x: 0.6, y: 0.6 });

  assert.equal(manager.activeMode, 'websocket');
  assert.equal(webrtcMessages.length, 1); // Unchanged
  assert.equal(wsMessages.length, 1);     // Routed through WebSocket fallback

  // 3. Restore WebRTC
  webrtcConnected = true;
  manager.restoreWebRTC();
  assert.equal(manager.activeMode, 'webrtc');

  manager.send({ type: 'pointer', event: 'up', x: 0.6, y: 0.6 });
  assert.equal(webrtcMessages.length, 2);
  assert.equal(wsMessages.length, 1);
});
