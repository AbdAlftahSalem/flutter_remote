/**
 * Flutter Remote WebRTC V2 Frame Controller
 *
 * Implements a bounded frame queue where stale frames are dropped immediately
 * so that the latest frame always wins for interactive simulator streaming.
 */

import { EventEmitter } from 'node:events';

export class FrameController extends EventEmitter {
  constructor(options = {}) {
    super();
    this.maxQueueSize = options.maxQueueSize || 2;
    this._queue = [];
    this.totalFramesReceived = 0;
    this.totalFramesDropped = 0;
    this.totalFramesEmitted = 0;
  }

  pushFrame(frame) {
    this.totalFramesReceived++;

    // Bounded queue: if queue is at capacity, drop oldest frames
    while (this._queue.length >= this.maxQueueSize) {
      this._queue.shift();
      this.totalFramesDropped++;
      this.emit('frame_dropped', { totalDropped: this.totalFramesDropped });
    }

    this._queue.push({
      frame,
      ts: Date.now(),
    });

    this.emit('frame_available');
  }

  popFrame() {
    if (this._queue.length === 0) return null;
    this.totalFramesEmitted++;
    return this._queue.shift();
  }

  get queueLength() {
    return this._queue.length;
  }

  clear() {
    this._queue = [];
  }
}
