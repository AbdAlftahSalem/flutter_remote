import test from 'node:test';
import assert from 'node:assert/strict';
import { WebRTCState } from '../src/webrtc/WebRTCState.js';
import { PeerManager } from '../src/webrtc/PeerManager.js';
import { CONNECTION_STATES } from '../src/shared/constants.js';
import { WebRTCError } from '../src/shared/errors.js';

test('Phase 4: WebRTCState transitions and validity', () => {
  const state = new WebRTCState(CONNECTION_STATES.IDLE);
  assert.equal(state.current, CONNECTION_STATES.IDLE);

  state.transition(CONNECTION_STATES.CONNECTING);
  state.transition(CONNECTION_STATES.SIGNALING);
  state.transition(CONNECTION_STATES.CHECKING);
  state.transition(CONNECTION_STATES.CONNECTED);
  assert.ok(state.isConnected());

  state.transition(CONNECTION_STATES.DEGRADED);
  state.transition(CONNECTION_STATES.RECONNECTING);
  state.transition(CONNECTION_STATES.CONNECTED);

  state.transition(CONNECTION_STATES.CLOSED);
  assert.ok(state.isClosed());
  assert.throws(() => state.transition(CONNECTION_STATES.CONNECTED), WebRTCError);
});

test('Phase 4: PeerManager lifecycle, generation advancement, and cleanup', async () => {
  const manager = new PeerManager({
    sessionId: 'session-pm-test',
    iceServers: ['stun:stun.cloudflare.com:3478'],
  });

  assert.equal(manager.generation, 1);
  assert.equal(manager.activePeer, null);

  // Create initial peer
  const peer1 = await manager.createPeer();
  assert.ok(peer1);
  assert.equal(peer1.generation, 1);
  assert.equal(manager.activePeer, peer1);

  // Configure DataChannels
  const inputDc = peer1.createDataChannel('input');
  assert.ok(inputDc);
  assert.ok(peer1.dataChannels.has('input'));

  // Recreate peer (simulates reconnect)
  const peer2 = await manager.recreatePeer('ice_failure_reconnect');
  assert.equal(manager.generation, 2);
  assert.equal(peer2.generation, 2);
  assert.equal(manager.activePeer, peer2);

  // Old peer1 must be cleanly closed
  assert.equal(peer1.state.current, CONNECTION_STATES.CLOSED);
  assert.equal(peer1.nativePeer, null);

  // Final shutdown
  await manager.close();
  assert.equal(manager.activePeer, null);
  assert.equal(peer2.state.current, CONNECTION_STATES.CLOSED);
});
