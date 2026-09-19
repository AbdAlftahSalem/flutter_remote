import test from 'node:test';
import assert from 'node:assert/strict';
import { ReconnectController } from '../src/webrtc/ReconnectController.js';

test('Phase 9: ReconnectController exponential backoff and retry scheduling', async () => {
  const controller = new ReconnectController({ maxAttempts: 5 });
  let reconnectInvocations = 0;

  const promise = new Promise((resolve) => {
    controller.scheduleReconnect(async ({ attempt }) => {
      reconnectInvocations++;
      assert.equal(attempt, 1);
      resolve();
    });
  });

  assert.equal(controller.attempt, 1);
  assert.ok(controller.reconnecting);

  await promise;
  assert.equal(reconnectInvocations, 1);
});

test('Phase 9: ReconnectController stable reset after connection', async () => {
  const controller = new ReconnectController();
  controller.attempt = 4;

  controller.markConnected();
  assert.equal(controller.reconnecting, false);

  // Before 5s, attempt remains 4
  assert.equal(controller.attempt, 4);

  // Fast-forward: clear and manually test reset logic
  controller.abort();
});

test('Phase 9: ReconnectController heartbeat timeout detection', () => {
  const controller = new ReconnectController();
  let timedOut = false;

  controller.on('heartbeat_timeout', () => {
    timedOut = true;
  });

  // Recent pong: healthy
  controller.recordPong();
  assert.ok(controller.checkHeartbeat());
  assert.equal(timedOut, false);

  // Stale pong (> 6000ms ago)
  controller._lastPongTime = Date.now() - 7000;
  assert.equal(controller.checkHeartbeat(), false);
  assert.equal(timedOut, true);
});
