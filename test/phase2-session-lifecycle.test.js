import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionState } from '../src/session/SessionState.js';
import { SessionStore } from '../src/session/SessionStore.js';
import { SessionLifecycle } from '../src/session/SessionLifecycle.js';
import { SessionManager } from '../src/session/SessionManager.js';
import { SESSION_STATES } from '../src/shared/constants.js';
import { SessionError, AuthenticationError } from '../src/shared/errors.js';

test('Phase 2: SessionState deterministic transitions', () => {
  const sm = new SessionState(SESSION_STATES.CREATING);
  assert.equal(sm.current, SESSION_STATES.CREATING);

  // Valid transition sequence
  sm.transition(SESSION_STATES.BOOTING_SIMULATOR);
  assert.equal(sm.current, SESSION_STATES.BOOTING_SIMULATOR);

  sm.transition(SESSION_STATES.STARTING_CAPTURE);
  sm.transition(SESSION_STATES.STARTING_GATEWAY);
  sm.transition(SESSION_STATES.READY);
  sm.transition(SESSION_STATES.ACTIVE);
  sm.transition(SESSION_STATES.DEGRADED);
  sm.transition(SESSION_STATES.ACTIVE);

  // Invalid transition: cannot jump from ACTIVE directly to BOOTING_SIMULATOR
  assert.throws(
    () => sm.transition(SESSION_STATES.BOOTING_SIMULATOR),
    (err) => err instanceof SessionError && err.code === 'INVALID_STATE_TRANSITION'
  );

  // Terminal state transition
  sm.transition(SESSION_STATES.STOPPING);
  sm.transition(SESSION_STATES.STOPPED);
  assert.ok(sm.isTerminal());
  assert.throws(() => sm.transition(SESSION_STATES.ACTIVE), SessionError);
});

test('Phase 2: SessionStore authentication & isolation', () => {
  const store = new SessionStore();
  const session1 = {
    id: 'session-alpha',
    token: 'token-alpha-123456789012345678901234',
    reconnectToken: 'reconnect-alpha-1234567890123456',
    expiresAt: Date.now() + 60000,
  };
  const session2 = {
    id: 'session-beta',
    token: 'token-beta-123456789012345678901234',
    reconnectToken: 'reconnect-beta-1234567890123456',
    expiresAt: Date.now() + 60000,
  };

  store.register(session1);
  store.register(session2);

  // Successful auth with primary token
  const authed1 = store.authenticate('session-alpha', session1.token);
  assert.equal(authed1.id, 'session-alpha');

  // Successful auth with reconnect token
  const authedReconnect = store.authenticate('session-alpha', session1.reconnectToken);
  assert.equal(authedReconnect.id, 'session-alpha');

  // Session isolation: token from session 1 cannot access session 2
  assert.throws(
    () => store.authenticate('session-beta', session1.token),
    AuthenticationError
  );

  // Non-existent session
  assert.throws(
    () => store.authenticate('session-gamma', 'random-token'),
    AuthenticationError
  );
});

test('Phase 2: SessionLifecycle idempotent cleanup & LIFO execution', async () => {
  const lifecycle = new SessionLifecycle('test-session');
  const executionOrder = [];

  lifecycle.addCleanupHook('hook1', async () => { executionOrder.push('hook1'); });
  lifecycle.addCleanupHook('hook2', async () => { executionOrder.push('hook2'); });
  lifecycle.addCleanupHook('hook3', async () => { executionOrder.push('hook3'); });

  // Call cleanup 3 times consecutively
  const p1 = lifecycle.cleanup('first_call');
  const p2 = lifecycle.cleanup('second_call');
  const p3 = lifecycle.cleanup('third_call');

  await Promise.all([p1, p2, p3]);

  // Verify LIFO order: hook3, hook2, hook1
  assert.deepEqual(executionOrder, ['hook3', 'hook2', 'hook1']);

  // Calling it again after completion does not throw or re-run
  await lifecycle.cleanup('fourth_call');
  assert.deepEqual(executionOrder, ['hook3', 'hook2', 'hook1']);
});

test('Phase 2: SessionManager creation and generation tracking', async () => {
  const store = new SessionStore();
  const manager = new SessionManager(store);

  const session = manager.createSession({ durationMinutes: 15 });
  assert.ok(session.id);
  assert.ok(session.token);
  assert.equal(session.generation, 1);

  assert.equal(session.nextGeneration(), 2);
  assert.equal(session.nextGeneration(), 3);
  assert.equal(session.generation, 3);

  // Close session
  await session.close();
  assert.equal(session.state.current, SESSION_STATES.STOPPED);
  assert.equal(store.get(session.id), null);
});
