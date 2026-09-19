/**
 * Flutter Remote WebRTC V2 Input Coalescer
 *
 * Coalesces high-frequency pointermove and wheel events to frame rate (60-120/sec)
 * preventing input queue flooding.
 */

export class InputCoalescer {
  constructor(options = {}) {
    this.sendFn = options.onSend || (() => {});
    this._pendingMoves = new Map(); // pointerId -> latest event
    this._rafId = null;
    this._scheduleFn = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb) => setTimeout(cb, 16);
    this._cancelFn = typeof cancelAnimationFrame === 'function'
      ? cancelAnimationFrame
      : (id) => clearTimeout(id);
  }

  handlePointer(event) {
    // Non-move events (down, up, cancel) must NOT be delayed or coalesced
    if (event.event !== 'move') {
      this.flushMoves();
      this.sendFn(event);
      return;
    }

    // Coalesce move: latest event for pointerId overwrites previous
    this._pendingMoves.set(event.pointerId || 1, event);

    if (!this._rafId) {
      this._rafId = this._scheduleFn(() => {
        this.flushMoves();
      });
    }
  }

  flushMoves() {
    if (this._rafId) {
      this._cancelFn(this._rafId);
      this._rafId = null;
    }

    if (this._pendingMoves.size > 0) {
      for (const event of this._pendingMoves.values()) {
        this.sendFn(event);
      }
      this._pendingMoves.clear();
    }
  }

  destroy() {
    this.flushMoves();
  }
}
