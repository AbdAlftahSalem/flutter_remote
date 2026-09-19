/**
 * Flutter Remote WebRTC V2 Signaling Server
 */

import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { SignalingProtocol, SIGNALING_TYPES } from './SignalingProtocol.js';
import { logger } from '../shared/logger.js';
import { sessionStore } from '../session/SessionStore.js';

export class SignalingServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.server = options.server || null;
    this.port = options.port || null;
    this.store = options.store || sessionStore;
    this.wss = null;
    this._clients = new Map(); // sessionId -> Set<ws>
  }

  start() {
    const wssOptions = this.server ? { server: this.server, path: '/signal' } : { port: this.port };
    this.wss = new WebSocketServer(wssOptions);

    this.wss.on('connection', (ws, req) => {
      this._handleConnection(ws, req);
    });

    logger.info('signaling.server_started', { port: this.port });
    return this;
  }

  _handleConnection(ws, req) {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('k') || url.searchParams.get('token');
    const sessionId = url.searchParams.get('session') || url.searchParams.get('sessionId');

    // Authenticate session if store is populated
    let session = null;
    if (this.store && this.store.count() > 0) {
      try {
        if (!sessionId || !token) {
          ws.close(4401, 'Authentication required: session and token must be provided');
          return;
        }
        session = this.store.authenticate(sessionId, token);
      } catch (err) {
        ws.close(4403, `Authentication failed: ${err.message}`);
        return;
      }
    }

    const clientSessionId = session ? session.id : (sessionId || 'anonymous');
    if (!this._clients.has(clientSessionId)) {
      this._clients.set(clientSessionId, new Set());
    }
    this._clients.get(clientSessionId).add(ws);

    logger.info('signaling.client_connected', { sessionId: clientSessionId });

    ws.on('message', (raw) => {
      try {
        const text = raw.toString();
        const activeGen = session ? session.generation : 1;
        const { isStale, message, reason } = SignalingProtocol.parse(text, activeGen);

        if (isStale) {
          logger.warn('signaling.stale_message_dropped', { reason, sessionId: clientSessionId });
          return;
        }

        if (message.type === SIGNALING_TYPES.PING) {
          const pong = SignalingProtocol.createPong(clientSessionId, message.generation, message.payload.clientTs);
          ws.send(JSON.stringify(pong));
          return;
        }

        this.emit('message', {
          ws,
          sessionId: clientSessionId,
          session,
          message,
        });

        this.emit(message.type, {
          ws,
          sessionId: clientSessionId,
          session,
          message,
        });
      } catch (err) {
        logger.error('signaling.message_error', { error: err.message, sessionId: clientSessionId });
        const errMsg = SignalingProtocol.createMessage(SIGNALING_TYPES.ERROR, {
          sessionId: clientSessionId,
          error: err.message,
        });
        if (ws.readyState === 1 /* OPEN */) {
          ws.send(JSON.stringify(errMsg));
        }
      }
    });

    ws.on('close', () => {
      const set = this._clients.get(clientSessionId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) this._clients.delete(clientSessionId);
      }
      logger.info('signaling.client_disconnected', { sessionId: clientSessionId });
      this.emit('client_close', { sessionId: clientSessionId, ws });
    });
  }

  sendToSession(sessionId, message) {
    const clients = this._clients.get(sessionId);
    if (!clients) return false;

    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    let sent = false;
    for (const ws of clients) {
      if (ws.readyState === 1 /* OPEN */) {
        ws.send(payload);
        sent = true;
      }
    }
    return sent;
  }

  close() {
    return new Promise((resolve) => {
      if (this.wss) {
        this.wss.close(() => {
          this.wss = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
