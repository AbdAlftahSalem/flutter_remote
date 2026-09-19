/**
 * Flutter Remote WebRTC V2 Input Router
 *
 * Receives DataChannel input events, validates sequence numbers, drops stale
 * out-of-order pointer moves, records per-stage timestamps (t1, t2),
 * and routes events to the simulator input adapter.
 */

import { EventEmitter } from 'node:events';
import { validateInputEvent } from '../shared/validation.js';
import { logger } from '../shared/logger.js';

export class InputRouter extends EventEmitter {
  constructor(simulatorAdapter, latencyTracker = null) {
    super();
    this.simulatorAdapter = simulatorAdapter;
    this.latencyTracker = latencyTracker;
    this.lastSeenPointerSeq = 0;
    this.droppedStaleMoves = 0;
  }

  async handleInputMessage(event) {
    validateInputEvent(event);

    const seq = event.seq || 0;
    const t0 = event.ts || Date.now();

    // Out-of-order / stale pointer move check
    if (event.type === 'pointer') {
      if (event.event === 'move') {
        if (seq > 0 && seq <= this.lastSeenPointerSeq) {
          this.droppedStaleMoves++;
          this.emit('stale_move_dropped', { seq, lastSeen: this.lastSeenPointerSeq });
          return;
        }
      }
      if (seq > this.lastSeenPointerSeq) {
        this.lastSeenPointerSeq = seq;
      }
    }

    // t1: server receive
    if (this.latencyTracker) {
      this.latencyTracker.recordServerReceive(seq, t0);
    }

    try {
      if (event.type === 'pointer') {
        await this.simulatorAdapter.pointer(event);
      } else if (event.type === 'keyboard') {
        await this.simulatorAdapter.keyboard(event);
      } else if (event.type === 'scroll') {
        await this.simulatorAdapter.scroll(event);
      } else if (event.type === 'clipboard') {
        await this.simulatorAdapter.clipboard(event.text || '');
      }

      // t2: simulator dispatch complete
      if (this.latencyTracker) {
        this.latencyTracker.recordSimulatorDispatch(seq);
      }

      this.emit('event_dispatched', { seq, type: event.type });
    } catch (err) {
      logger.warn('input.router_dispatch_error', { error: err.message, type: event.type, seq });
      this.emit('dispatch_error', { seq, error: err.message });
    }
  }
}
