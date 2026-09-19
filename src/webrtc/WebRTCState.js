/**
 * Flutter Remote WebRTC V2 Connection State Machine
 */

import { EventEmitter } from 'node:events';
import { CONNECTION_STATES } from '../shared/constants.js';
import { WebRTCError } from '../shared/errors.js';

const VALID_WEBRTC_TRANSITIONS = {
  [CONNECTION_STATES.IDLE]: new Set([
    CONNECTION_STATES.CONNECTING,
    CONNECTION_STATES.SIGNALING,
    CONNECTION_STATES.CLOSED,
    CONNECTION_STATES.FAILED,
  ]),
  [CONNECTION_STATES.CONNECTING]: new Set([
    CONNECTION_STATES.SIGNALING,
    CONNECTION_STATES.CHECKING,
    CONNECTION_STATES.CONNECTED,
    CONNECTION_STATES.FAILED,
    CONNECTION_STATES.CLOSED,
  ]),
  [CONNECTION_STATES.SIGNALING]: new Set([
    CONNECTION_STATES.CHECKING,
    CONNECTION_STATES.CONNECTED,
    CONNECTION_STATES.FAILED,
    CONNECTION_STATES.CLOSED,
  ]),
  [CONNECTION_STATES.CHECKING]: new Set([
    CONNECTION_STATES.CONNECTED,
    CONNECTION_STATES.DEGRADED,
    CONNECTION_STATES.FAILED,
    CONNECTION_STATES.CLOSED,
  ]),
  [CONNECTION_STATES.CONNECTED]: new Set([
    CONNECTION_STATES.DEGRADED,
    CONNECTION_STATES.RECONNECTING,
    CONNECTION_STATES.FAILED,
    CONNECTION_STATES.CLOSED,
  ]),
  [CONNECTION_STATES.DEGRADED]: new Set([
    CONNECTION_STATES.CONNECTED,
    CONNECTION_STATES.RECONNECTING,
    CONNECTION_STATES.FAILED,
    CONNECTION_STATES.CLOSED,
  ]),
  [CONNECTION_STATES.RECONNECTING]: new Set([
    CONNECTION_STATES.CONNECTING,
    CONNECTION_STATES.SIGNALING,
    CONNECTION_STATES.CHECKING,
    CONNECTION_STATES.CONNECTED,
    CONNECTION_STATES.DEGRADED,
    CONNECTION_STATES.FAILED,
    CONNECTION_STATES.CLOSED,
  ]),
  [CONNECTION_STATES.FAILED]: new Set([
    CONNECTION_STATES.RECONNECTING,
    CONNECTION_STATES.CLOSED,
  ]),
  [CONNECTION_STATES.CLOSED]: new Set([]), // Terminal
};

export class WebRTCState extends EventEmitter {
  constructor(initialState = CONNECTION_STATES.IDLE) {
    super();
    this._state = initialState;
    this._history = [{ state: initialState, ts: Date.now() }];
  }

  get current() {
    return this._state;
  }

  isClosed() {
    return this._state === CONNECTION_STATES.CLOSED;
  }

  isConnected() {
    return this._state === CONNECTION_STATES.CONNECTED;
  }

  canTransition(toState) {
    const allowed = VALID_WEBRTC_TRANSITIONS[this._state];
    return Boolean(allowed && allowed.has(toState));
  }

  transition(toState, reason = null) {
    if (this._state === toState) return;

    if (!this.canTransition(toState)) {
      throw new WebRTCError(
        `Invalid WebRTC state transition from ${this._state} to ${toState}`,
        { code: 'INVALID_WEBRTC_STATE_TRANSITION', details: { from: this._state, to: toState } }
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
