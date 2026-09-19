/**
 * Flutter Remote WebRTC V2 Session Store
 */

import { AuthenticationError, SessionError } from '../shared/errors.js';
import { timingSafeCompare } from '../shared/validation.js';
import { TIMEOUTS } from '../shared/constants.js';

export class SessionStore {
  constructor() {
    this._sessions = new Map();
  }

  register(session) {
    if (!session || !session.id) {
      throw new SessionError('Session must have a valid id');
    }
    if (this._sessions.has(session.id)) {
      throw new SessionError(`Session ${session.id} already exists`);
    }
    this._sessions.set(session.id, session);
    return session;
  }

  get(sessionId) {
    return this._sessions.get(sessionId) || null;
  }

  authenticate(sessionId, token) {
    const session = this.get(sessionId);
    if (!session) {
      throw new AuthenticationError('Session not found');
    }

    const matchesPrimary = session.token && timingSafeCompare(session.token, token);
    const matchesReconnect = session.reconnectToken && timingSafeCompare(session.reconnectToken, token);

    if (!matchesPrimary && !matchesReconnect) {
      throw new AuthenticationError('Invalid session credentials');
    }

    if (session.expiresAt && Date.now() > session.expiresAt) {
      throw new AuthenticationError('Session has expired');
    }

    return session;
  }

  remove(sessionId) {
    return this._sessions.delete(sessionId);
  }

  clear() {
    this._sessions.clear();
  }

  count() {
    return this._sessions.size;
  }
}

export const sessionStore = new SessionStore();
