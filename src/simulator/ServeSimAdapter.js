/**
 * Flutter Remote WebRTC V2 ServeSim Adapter
 *
 * The sole module in the codebase that encapsulates serve-sim's local /ws protocol.
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
    this._reconnectTimer = null;
    this._queue = [];
    this._closed = false;
  }

  async connect() {
    if (this._closed) return;

    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(`ws://${this.host}:${this.port}/ws`);

        this.ws.on('open', () => {
          this._connected = true;
          logger.info('serve_sim.connected', { port: this.port });
          this._flushQueue();
          resolve(true);
        });

        this.ws.on('error', (err) => {
          logger.warn('serve_sim.connection_error', { error: err.message, port: this.port });
          resolve(false);
        });

        this.ws.on('close', () => {
          this._connected = false;
          if (!this._closed) {
            this._scheduleReconnect();
          }
        });
      } catch (err) {
        logger.warn('serve_sim.socket_creation_failed', { error: err.message });
        resolve(false);
      }
    });
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || this._closed) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, 1000);
  }

  _send(msg) {
    if (this._connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
        return true;
      } catch {}
    }

    // Buffer in queue if disconnected, bounded to MAX_INPUT_QUEUE_SIZE
    if (this._queue.length < LIMITS.MAX_INPUT_QUEUE_SIZE) {
      this._queue.push(msg);
    }
    return false;
  }

  _flushQueue() {
    while (this._queue.length > 0 && this._connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      const msg = this._queue.shift();
      this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
  }

  async pointer(event) {
    // Map normalized event to serve-sim format with pixel dimensions
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
  }
}
