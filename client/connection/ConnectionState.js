/**
 * Flutter Remote WebRTC V3 ConnectionState Machine
 *
 * Manages deterministic connection state transitions and generation IDs
 * to protect against stale signaling messages.
 */

export class ConnectionState {
  constructor() {
    this.state = 'IDLE'; // IDLE, CONNECTING, CONNECTED, DISCONNECTED, RECONNECTING, FAILED, CLOSED
    this.generation = 1;
    this.listeners = new Set();
  }

  set(newState) {
    if (this.state === newState) return;
    this.state = newState;
    for (const fn of this.listeners) {
      try {
        fn(this.state, this.generation);
      } catch (err) {
        console.warn('[ConnectionState listener error]', err);
      }
    }
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  advanceGeneration() {
    this.generation++;
    return this.generation;
  }

  isStale(generation) {
    return Boolean(generation && generation < this.generation);
  }

  reset() {
    this.state = 'IDLE';
    this.generation = 1;
  }
}
