/**
 * Flutter Remote WebRTC V2 Session Manager
 */

import { generateSessionId, generateToken } from '../shared/utils.js';
import { SessionState } from './SessionState.js';
import { SessionLifecycle } from './SessionLifecycle.js';
import { sessionStore } from './SessionStore.js';
import { SESSION_STATES, TIMEOUTS } from '../shared/constants.js';

export class Session {
  constructor(options = {}) {
    this.id = options.id || generateSessionId();
    this.token = options.token || generateToken(32);
    this.reconnectToken = options.reconnectToken || generateToken(32);
    this.createdAt = Date.now();
    this.expiresAt = options.expiresAt || (Date.now() + (options.durationMinutes || 10) * 60 * 1000);
    this.state = new SessionState(options.initialState || SESSION_STATES.CREATING);
    this.lifecycle = new SessionLifecycle(this.id);
    this.generation = 1;
    this.metadata = options.metadata || {};
    this.store = options.store || sessionStore;

    // Subsystem ownership (Section 32, 33)
    this.simulator = options.simulator || null;
    this.capture = options.capture || null;
    this.media = options.media || null;
    this.peer = options.peer || null;
    this.input = options.input || null;
    this.signaling = options.signaling || null;
    this.metrics = options.metrics || null;
  }

  attachSubsystems(subsystems = {}) {
    if (subsystems.simulator) this.simulator = subsystems.simulator;
    if (subsystems.capture) this.capture = subsystems.capture;
    if (subsystems.media) this.media = subsystems.media;
    if (subsystems.peer) this.peer = subsystems.peer;
    if (subsystems.input) this.input = subsystems.input;
    if (subsystems.signaling) this.signaling = subsystems.signaling;
    if (subsystems.metrics) this.metrics = subsystems.metrics;
  }

  nextGeneration() {
    this.generation++;
    return this.generation;
  }

  async close(reason = 'normal_closure') {
    if (this.state.canTransition(SESSION_STATES.STOPPING)) {
      this.state.transition(SESSION_STATES.STOPPING, reason);
    }

    // Clean up owned subsystems safely
    try { if (this.media && typeof this.media.close === 'function') this.media.close(); } catch {}
    try { if (this.capture && typeof this.capture.close === 'function') this.capture.close(); } catch {}
    try { if (this.peer && typeof this.peer.close === 'function') this.peer.close(); } catch {}
    try { if (this.signaling && typeof this.signaling.close === 'function') this.signaling.close(); } catch {}
    try { if (this.simulator && typeof this.simulator.close === 'function') this.simulator.close(); } catch {}
    try { if (this.metrics && typeof this.metrics.close === 'function') this.metrics.close(); } catch {}

    await this.lifecycle.cleanup(reason);
    if (this.state.canTransition(SESSION_STATES.STOPPED)) {
      this.state.transition(SESSION_STATES.STOPPED, reason);
    }
    this.store.remove(this.id);
  }
}

export class SessionManager {
  constructor(store = sessionStore) {
    this.store = store;
  }

  createSession(options = {}) {
    const session = new Session({ ...options, store: this.store });
    this.store.register(session);
    return session;
  }

  getSession(sessionId) {
    return this.store.get(sessionId);
  }

  authenticate(sessionId, token) {
    return this.store.authenticate(sessionId, token);
  }

  async closeSession(sessionId, reason = 'requested') {
    const session = this.store.get(sessionId);
    if (session) {
      await session.close(reason);
    }
  }

  async closeAll(reason = 'shutdown') {
    for (const session of this.store._sessions.values()) {
      await session.close(reason);
    }
  }
}

export const sessionManager = new SessionManager();
