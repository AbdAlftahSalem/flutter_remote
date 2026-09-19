/**
 * Flutter Remote WebRTC V2 Signaling Client
 */

import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { SignalingProtocol, SIGNALING_TYPES } from './SignalingProtocol.js';
import { TIMEOUTS } from '../shared/constants.js';

export class SignalingClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.url = options.url;
    this.sessionId = options.sessionId;
    this.token = options.token;
    this.generation = options.generation || 1;
    this.ws = null;
    this._pingTimer = null;
    this._pongTimeoutTimer = null;
    this.rtt = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const fullUrl = new URL(this.url);
      if (this.sessionId) fullUrl.searchParams.set('session', this.sessionId);
      if (this.token) fullUrl.searchParams.set('k', this.token);

      this.ws = new WebSocket(fullUrl.toString());

      this.ws.on('open', () => {
        this._startHeartbeat();
        resolve();
      });

      this.ws.on('error', (err) => {
        reject(err);
      });

      this.ws.on('message', (raw) => {
        try {
          const { isStale, message } = SignalingProtocol.parse(raw.toString(), this.generation);
          if (isStale) return;

          if (message.type === SIGNALING_TYPES.PONG) {
            this._handlePong(message);
            return;
          }

          this.emit('message', message);
          this.emit(message.type, message);
        } catch (err) {
          this.emit('error', err);
        }
      });

      this.ws.on('close', (code, reason) => {
        this._stopHeartbeat();
        this.emit('close', { code, reason: reason.toString() });
      });
    });
  }

  sendOffer(sdp, iceServers = []) {
    const msg = SignalingProtocol.createOffer(this.sessionId, this.generation, sdp, iceServers);
    this._send(msg);
  }

  sendAnswer(sdp) {
    const msg = SignalingProtocol.createAnswer(this.sessionId, this.generation, sdp);
    this._send(msg);
  }

  sendCandidate(candidate, sdpMid = '0', sdpMLineIndex = 0) {
    const msg = SignalingProtocol.createCandidate(this.sessionId, this.generation, candidate, sdpMid, sdpMLineIndex);
    this._send(msg);
  }

  _send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._pingTimer = setInterval(() => {
      const ping = SignalingProtocol.createPing(this.sessionId, this.generation);
      this._send(ping);

      this._pongTimeoutTimer = setTimeout(() => {
        this.emit('heartbeat_timeout');
      }, TIMEOUTS.HEARTBEAT_TIMEOUT_MS);
    }, TIMEOUTS.HEARTBEAT_INTERVAL_MS);
  }

  _handlePong(pongMessage) {
    clearTimeout(this._pongTimeoutTimer);
    if (pongMessage.payload && pongMessage.payload.clientTs) {
      this.rtt = Date.now() - pongMessage.payload.clientTs;
      this.emit('rtt', this.rtt);
    }
  }

  _stopHeartbeat() {
    if (this._pingTimer) clearInterval(this._pingTimer);
    if (this._pongTimeoutTimer) clearTimeout(this._pongTimeoutTimer);
    this._pingTimer = null;
    this._pongTimeoutTimer = null;
  }

  close() {
    this._stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
