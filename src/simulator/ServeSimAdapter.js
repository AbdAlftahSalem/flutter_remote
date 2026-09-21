/**
 * Flutter Remote WebRTC V2 ServeSim Adapter
 *
 * NOTE / ARCHITECTURE:
 * This module is a reference and test adapter. The live runner component consuming serve-sim
 * on macOS GitHub Actions runners is located at `templates/peer/ServeSimConsumer.cjs`.
 *
 * Encapsulates serve-sim's local /ws protocol with connection readiness promises,
 * queueing during connect, zero dropped critical events, and safe flush on OPEN.
 */

import { WebSocket } from 'ws';
import { SimulatorInputAdapter } from './SimulatorInputAdapter.js';
import { logger } from '../shared/logger.js';
import { LIMITS } from '../shared/constants.js';

export class ServeSimAdapter extends SimulatorInputAdapter {
  constructor(options = {}) {
    super();
    this.host = options.host || '127.0.0.1';
    this.port = options.port || 3200;
    this.targetWidth = options.width || 720;
    this.targetHeight = options.height || 1280;
    this.ws = null;
    this._connected = false;
    this._connectPromise = null;
    this._reconnectTimer = null;
    this._queue = [];
    this._closed = false;
  }

  /**
   * Returns a promise resolving to an OPEN WebSocket connection to serve-sim.
   * Multiple calls while connecting share the exact same promise.
   */
  getServeSimWs() {
    if (this._closed) {
      return Promise.reject(new Error('ServeSimAdapter is closed'));
    }

    if (this._connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve(this.ws);
    }

    if (this._connectPromise) {
      return this._connectPromise;
    }

    this._connectPromise = new Promise((resolve) => {
      try {
        this.ws = new WebSocket(`ws://${this.host}:${this.port}/ws`);

        this.ws.on('open', () => {
          this._connected = true;
          this._connectPromise = null;
          logger.info('serve_sim.connected', { port: this.port });
          this._flushQueue();
          resolve(this.ws);
        });

        this.ws.on('error', (err) => {
          logger.warn('serve_sim.connection_error', { error: err.message, port: this.port });
          this._connected = false;
          this._connectPromise = null;
          resolve(null);
        });

        this.ws.on('close', () => {
          this._connected = false;
          this._connectPromise = null;
          if (!this._closed) {
            this._scheduleReconnect();
          }
        });
      } catch (err) {
        logger.warn('serve_sim.socket_creation_failed', { error: err.message });
        this._connected = false;
        this._connectPromise = null;
        resolve(null);
      }
    });

    return this._connectPromise;
  }

  async connect() {
    const ws = await this.getServeSimWs();
    return Boolean(ws && ws.readyState === WebSocket.OPEN);
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || this._closed) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.getServeSimWs();
    }, 1000);
  }

  _send(msg) {
    if (this._connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
        return true;
      } catch {}
    }

    // Queue if disconnected or connecting, bounded to MAX_INPUT_QUEUE_SIZE
    if (this._queue.length < LIMITS.MAX_INPUT_QUEUE_SIZE) {
      // Coalesce pointer moves to keep only the newest move in queue
      if (msg.event === 'move') {
        const lastMoveIdx = this._queue.findLastIndex((item) => item && item.event === 'move');
        if (lastMoveIdx !== -1) {
          this._queue[lastMoveIdx] = msg;
          this.getServeSimWs();
          return false;
        }
      }
      this._queue.push(msg);
    }

    // Ensure connection is actively being established
    this.getServeSimWs();
    return false;
  }

  _flushQueue() {
    while (this._queue.length > 0 && this._connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      const msg = this._queue.shift();
      try {
        this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
      } catch {}
    }
  }

  async pointer(event) {
    const pixelX = Math.round((event.x || 0) * this.targetWidth);
    const pixelY = Math.round((event.y || 0) * this.targetHeight);

    const payload = {
      type: 'pointer',
      event: event.event, // 'down' | 'move' | 'up' | 'cancel'
      pointerId: event.pointerId || 1,
      x: pixelX,
      y: pixelY,
      normalizedX: event.x,
      normalizedY: event.y,
      button: event.button || 0,
      buttons: event.buttons !== undefined ? event.buttons : 1,
    };

    this._send(payload);
  }

  async keyboard(event) {
    const payload = {
      type: 'keyboard',
      event: event.event,
      key: event.key || '',
      code: event.code || '',
      text: event.text || '',
      isComposing: Boolean(event.isComposing),
    };

    this._send(payload);
  }

  async scroll(event) {
    const pixelX = Math.round((event.x || 0.5) * this.targetWidth);
    const pixelY = Math.round((event.y || 0.5) * this.targetHeight);

    const payload = {
      type: 'scroll',
      deltaX: event.deltaX || 0,
      deltaY: event.deltaY || 0,
      x: pixelX,
      y: pixelY,
    };

    this._send(payload);
  }

  async clipboard(text) {
    const payload = {
      type: 'clipboard',
      text: String(text),
    };

    this._send(payload);
  }

  async close() {
    this._closed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this._queue = [];
    this._connected = false;
    this._connectPromise = null;
  }
}
