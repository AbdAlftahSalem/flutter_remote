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
  }

  nextGeneration() {
    this.generation++;
    return this.generation;
  }

  async close(reason = 'normal_closure') {
    if (this.state.canTransition(SESSION_STATES.STOPPING)) {
      this.state.transition(SESSION_STATES.STOPPING, reason);
    }
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
