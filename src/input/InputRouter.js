/**
 * Flutter Remote WebRTC V2 Input Router
 *
 * Receives DataChannel input events, records per-stage timestamps (t1, t2),
 * routes events to the simulator input adapter, and tracks latencies.
 */

import { EventEmitter } from 'node:events';
import { validateInputEvent } from '../shared/validation.js';
import { logger } from '../shared/logger.js';

export class InputRouter extends EventEmitter {
  constructor(simulatorAdapter, latencyTracker = null) {
    super();
    this.simulatorAdapter = simulatorAdapter;
    this.latencyTracker = latencyTracker;
  }

  async handleInputMessage(event) {
    validateInputEvent(event);

    const seq = event.seq || 0;
    const t0 = event.ts || Date.now();

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
