/**
 * Flutter Remote WebRTC V2 Transport Manager & Fallback Architecture
 */

import { EventEmitter } from 'node:events';
import { logger } from '../shared/logger.js';

export class InputTransport extends EventEmitter {
  async connect() { throw new Error('connect() not implemented'); }
  send(event) { throw new Error('send() not implemented'); }
  close() { throw new Error('close() not implemented'); }
  isConnected() { return false; }
}

export class WebRTCInputTransport extends InputTransport {
  constructor(dataChannelManager) {
    super();
    this.dcManager = dataChannelManager;
  }

  async connect() {
    return this.isConnected();
  }

  send(event) {
    if (event.type === 'keyboard') {
      return this.dcManager.sendKeyboard(event);
    }
    if (event.type === 'control') {
      return this.dcManager.sendControl(event);
    }
    return this.dcManager.sendInput(event);
  }

  close() {
    // Managed by peer connection
  }

  isConnected() {
    return this.dcManager.isChannelOpen('input');
  }
}

export class WebSocketInputTransport extends InputTransport {
  constructor(wsClient) {
    super();
    this.ws = wsClient;
  }

  async connect() {
    return this.isConnected();
  }

  send(event) {
    if (this.isConnected()) {
      const payload = typeof event === 'string' ? event : JSON.stringify(event);
      this.ws.send(payload);
      return true;
    }
    return false;
  }

  close() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }

  isConnected() {
    return Boolean(this.ws && this.ws.readyState === 1 /* OPEN */);
  }
}

export class TransportManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.primaryTransport = options.primary || null;
    this.fallbackTransport = options.fallback || null;
    this.activeMode = 'webrtc'; // 'webrtc' | 'websocket'
  }

  get current() {
    return this.activeMode === 'webrtc' ? this.primaryTransport : this.fallbackTransport;
  }

  send(event) {
    const transport = this.current;
    if (transport && transport.isConnected()) {
      return transport.send(event);
    }

    // Auto-fallback if primary is disconnected and fallback is available
    if (this.activeMode === 'webrtc' && this.fallbackTransport && this.fallbackTransport.isConnected()) {
      this.fallbackToWebSocket();
      return this.fallbackTransport.send(event);
    }

    return false;
  }

  fallbackToWebSocket(reason = 'webrtc_unavailable') {
    if (this.activeMode === 'websocket') return;
    this.activeMode = 'websocket';
    logger.warn('transport.fallback_to_websocket', { reason });
    this.emit('transport_switched', { mode: 'websocket', reason });
  }

  restoreWebRTC() {
    if (this.activeMode === 'webrtc') return;
    this.activeMode = 'webrtc';
    logger.info('transport.restored_to_webrtc');
    this.emit('transport_switched', { mode: 'webrtc' });
  }

  close() {
    if (this.primaryTransport) this.primaryTransport.close();
    if (this.fallbackTransport) this.fallbackTransport.close();
    this.removeAllListeners();
  }
}
