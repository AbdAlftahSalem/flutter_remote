/**
 * Flutter Remote WebRTC V2 Reconnection & ICE Restart Controller
 */

import { EventEmitter } from 'node:events';
import { calculateBackoff } from '../shared/utils.js';
import { TIMEOUTS } from '../shared/constants.js';
import { logger } from '../shared/logger.js';

export class ReconnectController extends EventEmitter {
  constructor(options = {}) {
    super();
    this.maxAttempts = options.maxAttempts || 10;
    this.attempt = 0;
    this.reconnecting = false;
    this._reconnectTimer = null;
    this._stableTimer = null;
    this._heartbeatTimer = null;
    this._lastPongTime = Date.now();
  }

  scheduleReconnect(onReconnectFn, reason = 'connection_loss') {
    if (this._reconnectTimer) return;

    this.reconnecting = true;
    this._clearStableTimer();

    const delayMs = calculateBackoff(this.attempt);
    this.attempt++;

    logger.info('webrtc.reconnect_scheduled', {
      attempt: this.attempt,
      delayMs,
      reason,
    });

    this.emit('reconnecting', { attempt: this.attempt, delayMs, reason });

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      try {
        await onReconnectFn({ attempt: this.attempt });
      } catch (err) {
        logger.warn('webrtc.reconnect_execution_failed', {
          attempt: this.attempt,
          error: err.message,
        });
        // Schedule next attempt
        this.scheduleReconnect(onReconnectFn, 'retry_after_failure');
      }
    }, delayMs);
  }

  markConnected() {
    this.reconnecting = false;
    this._clearReconnectTimer();

    // After 5s of stable connection, reset attempt counter
    this._clearStableTimer();
    this._stableTimer = setTimeout(() => {
      if (!this.reconnecting) {
        this.attempt = 0;
        logger.debug('webrtc.reconnect_backoff_reset');
      }
    }, TIMEOUTS.STABLE_CONNECTION_RESET_MS);

    this.emit('connected');
  }

  recordPong() {
    this._lastPongTime = Date.now();
  }

  checkHeartbeat() {
    const elapsed = Date.now() - this._lastPongTime;
    if (elapsed > TIMEOUTS.HEARTBEAT_TIMEOUT_MS && !this.reconnecting) {
      logger.warn('webrtc.heartbeat_timed_out', { elapsedMs: elapsed });
      this.emit('heartbeat_timeout');
      return false;
    }
    return true;
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  _clearStableTimer() {
    if (this._stableTimer) {
      clearTimeout(this._stableTimer);
      this._stableTimer = null;
    }
  }

  abort() {
    this._clearReconnectTimer();
    this._clearStableTimer();
    this.reconnecting = false;
  }
}
