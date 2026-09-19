/**
 * Flutter Remote WebRTC V2 Session State Machine
 */

import { EventEmitter } from 'node:events';
import { SESSION_STATES } from '../shared/constants.js';
import { SessionError } from '../shared/errors.js';

const VALID_TRANSITIONS = {
  [SESSION_STATES.CREATING]: new Set([
    SESSION_STATES.BOOTING_SIMULATOR,
    SESSION_STATES.STARTING_GATEWAY,
    SESSION_STATES.FAILED,
    SESSION_STATES.STOPPING,
  ]),
  [SESSION_STATES.BOOTING_SIMULATOR]: new Set([
    SESSION_STATES.STARTING_CAPTURE,
    SESSION_STATES.FAILED,
    SESSION_STATES.STOPPING,
  ]),
  [SESSION_STATES.STARTING_CAPTURE]: new Set([
    SESSION_STATES.STARTING_GATEWAY,
    SESSION_STATES.FAILED,
    SESSION_STATES.STOPPING,
  ]),
  [SESSION_STATES.STARTING_GATEWAY]: new Set([
    SESSION_STATES.STARTING_TUNNEL,
    SESSION_STATES.READY,
    SESSION_STATES.FAILED,
    SESSION_STATES.STOPPING,
  ]),
  [SESSION_STATES.STARTING_TUNNEL]: new Set([
    SESSION_STATES.READY,
    SESSION_STATES.FAILED,
    SESSION_STATES.STOPPING,
  ]),
  [SESSION_STATES.READY]: new Set([
    SESSION_STATES.ACTIVE,
    SESSION_STATES.STOPPING,
    SESSION_STATES.FAILED,
  ]),
  [SESSION_STATES.ACTIVE]: new Set([
    SESSION_STATES.DEGRADED,
    SESSION_STATES.RECONNECTING,
    SESSION_STATES.STOPPING,
    SESSION_STATES.FAILED,
  ]),
  [SESSION_STATES.DEGRADED]: new Set([
    SESSION_STATES.ACTIVE,
    SESSION_STATES.RECONNECTING,
    SESSION_STATES.STOPPING,
    SESSION_STATES.FAILED,
  ]),
  [SESSION_STATES.RECONNECTING]: new Set([
    SESSION_STATES.ACTIVE,
    SESSION_STATES.DEGRADED,
    SESSION_STATES.STOPPING,
    SESSION_STATES.FAILED,
  ]),
  [SESSION_STATES.STOPPING]: new Set([
    SESSION_STATES.STOPPED,
  ]),
  [SESSION_STATES.FAILED]: new Set([
    SESSION_STATES.STOPPING,
    SESSION_STATES.STOPPED,
  ]),
  [SESSION_STATES.STOPPED]: new Set([]), // Terminal
};

export class SessionState extends EventEmitter {
  constructor(initialState = SESSION_STATES.CREATING) {
    super();
    this._state = initialState;
    this._history = [{ state: initialState, ts: Date.now() }];
  }

  get current() {
    return this._state;
  }

  get history() {
    return [...this._history];
  }

  isTerminal() {
    return this._state === SESSION_STATES.STOPPED;
  }

  canTransition(toState) {
    const allowed = VALID_TRANSITIONS[this._state];
    return Boolean(allowed && allowed.has(toState));
  }

  transition(toState, reason = null) {
    if (this._state === toState) return;

    if (!this.canTransition(toState)) {
      throw new SessionError(
        `Invalid session state transition from ${this._state} to ${toState}`,
        { code: 'INVALID_STATE_TRANSITION', details: { from: this._state, to: toState } }
      );
    }

    const prev = this._state;
    this._state = toState;
    const entry = { from: prev, to: toState, ts: Date.now(), reason };
    this._history.push(entry);

    this.emit('transition', entry);
    this.emit(toState, entry);
  }
}
