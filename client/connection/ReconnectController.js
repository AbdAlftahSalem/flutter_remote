/**
 * Flutter Remote WebRTC V3 ReconnectController
 *
 * Owns retry counts, exponential backoff, reconnect scheduling,
 * cancellation, and generation advancement.
 */

export const DEFAULT_BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 10000];

export class ReconnectController {
  constructor(connectionState, options = {}) {
    this.connectionState = connectionState;
    this.backoffMs = options.backoffMs || DEFAULT_BACKOFF_MS;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.totalReconnects = 0;
  }

  scheduleReconnect(callback) {
    if (this.reconnectTimer) return;
    this.connectionState.set('RECONNECTING');
    this.totalReconnects++;

    const delayIndex = Math.min(this.reconnectAttempt, this.backoffMs.length - 1);
    const delay = this.backoffMs[delayIndex];
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectionState.advanceGeneration();
      callback(this.connectionState.generation);
    }, delay);
  }

  reset() {
    this.reconnectAttempt = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  cancel() {
    this.reset();
  }

  get isScheduled() {
    return this.reconnectTimer !== null;
  }
}
