/**
 * Flutter Remote WebRTC V2 Signaling Protocol
 */

import { PROTOCOL_VERSION } from '../shared/constants.js';
import { SignalingError } from '../shared/errors.js';
import { validatePayloadSize } from '../shared/validation.js';

export const SIGNALING_TYPES = {
  HELLO: 'hello',
  OFFER: 'offer',
  ANSWER: 'answer',
  ICE_CANDIDATE: 'ice-candidate',
  ICE_COMPLETE: 'ice-complete',
  RESTART: 'restart',
  CONNECTED: 'connected',
  DISCONNECT: 'disconnect',
  ERROR: 'error',
  PING: 'ping',
  PONG: 'pong',
};

export class SignalingProtocol {
  static createMessage(type, options = {}) {
    if (!type || !Object.values(SIGNALING_TYPES).includes(type)) {
      throw new SignalingError(`Invalid signaling message type: ${type}`);
    }

    return {
      v: PROTOCOL_VERSION,
      type,
      sessionId: options.sessionId || null,
      generation: options.generation !== undefined ? options.generation : 1,
      ts: Date.now(),
      payload: options.payload || {},
      ...(options.error ? { error: options.error, code: options.code || 'SIGNALING_ERROR' } : {}),
    };
  }

  static createOffer(sessionId, generation, sdp, iceServers = []) {
    return this.createMessage(SIGNALING_TYPES.OFFER, {
      sessionId,
      generation,
      payload: { sdp, iceServers },
    });
  }

  static createAnswer(sessionId, generation, sdp) {
    return this.createMessage(SIGNALING_TYPES.ANSWER, {
      sessionId,
      generation,
      payload: { sdp },
    });
  }

  static createCandidate(sessionId, generation, candidate, sdpMid = '0', sdpMLineIndex = 0) {
    return this.createMessage(SIGNALING_TYPES.ICE_CANDIDATE, {
      sessionId,
      generation,
      payload: { candidate, sdpMid, sdpMLineIndex },
    });
  }

  static createPing(sessionId, generation) {
    return this.createMessage(SIGNALING_TYPES.PING, {
      sessionId,
      generation,
      payload: { clientTs: Date.now() },
    });
  }

  static createPong(sessionId, generation, clientTs) {
    return this.createMessage(SIGNALING_TYPES.PONG, {
      sessionId,
      generation,
      payload: { clientTs, serverTs: Date.now() },
    });
  }

  static parse(rawString, activeGeneration = null) {
    validatePayloadSize(rawString);

    let msg;
    try {
      msg = JSON.parse(rawString);
    } catch (e) {
      throw new SignalingError(`Malformed signaling JSON: ${e.message}`);
    }

    if (!msg || typeof msg !== 'object') {
      throw new SignalingError('Signaling message must be an object');
    }

    if (msg.v !== PROTOCOL_VERSION) {
      throw new SignalingError(`Protocol version mismatch: expected ${PROTOCOL_VERSION}, got ${msg.v}`);
    }

    if (!msg.type || !Object.values(SIGNALING_TYPES).includes(msg.type)) {
      throw new SignalingError(`Unknown signaling type: ${msg.type}`);
    }

    // Check generation staleness
    if (activeGeneration !== null && msg.generation !== undefined) {
      if (msg.generation < activeGeneration) {
        return {
          isStale: true,
          message: msg,
          reason: `Stale generation ${msg.generation} (active is ${activeGeneration})`,
        };
      }
    }

    return {
      isStale: false,
      message: msg,
    };
  }
}
