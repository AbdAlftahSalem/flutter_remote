/**
 * Flutter Remote WebRTC V2 Validation Utilities
 */

import { timingSafeEqual } from 'node:crypto';
import { LIMITS, PROTOCOL_VERSION } from './constants.js';
import { SignalingError, SessionError, AuthenticationError } from './errors.js';

export function timingSafeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function validateToken(token, expectedToken) {
  if (!token || typeof token !== 'string') {
    throw new AuthenticationError('Token must be a non-empty string');
  }
  if (!expectedToken || typeof expectedToken !== 'string') {
    throw new AuthenticationError('Expected token not configured');
  }
  if (!timingSafeCompare(token, expectedToken)) {
    throw new AuthenticationError('Invalid session token');
  }
  return true;
}

export function validatePayloadSize(rawPayload, maxSize = LIMITS.MAX_SIGNALING_MESSAGE_SIZE) {
  const byteLength = typeof rawPayload === 'string'
    ? Buffer.byteLength(rawPayload)
    : (Buffer.isBuffer(rawPayload) ? rawPayload.length : 0);

  if (byteLength > maxSize) {
    throw new SessionError(`Payload size (${byteLength} bytes) exceeds limit of ${maxSize} bytes`, {
      code: 'PAYLOAD_TOO_LARGE',
      status: 413,
    });
  }
}

export function validateSignalingMessage(msg) {
  if (!msg || typeof msg !== 'object') {
    throw new SignalingError('Signaling message must be an object');
  }
  if (msg.v !== undefined && msg.v !== PROTOCOL_VERSION) {
    throw new SignalingError(`Unsupported protocol version: ${msg.v}, expected ${PROTOCOL_VERSION}`);
  }
  if (!msg.type || typeof msg.type !== 'string') {
    throw new SignalingError('Signaling message requires a valid type string');
  }
  return true;
}

export function validateInputEvent(event) {
  if (!event || typeof event !== 'object') {
    throw new SessionError('Input event must be an object');
  }
  if (!event.type || typeof event.type !== 'string') {
    throw new SessionError('Input event requires a valid type string');
  }

  if (event.type === 'pointer') {
    if (event.x !== undefined) {
      if (typeof event.x !== 'number' || event.x < 0 || event.x > 1) {
        throw new SessionError(`Pointer x coordinate must be normalized between 0.0 and 1.0, got ${event.x}`);
      }
    }
    if (event.y !== undefined) {
      if (typeof event.y !== 'number' || event.y < 0 || event.y > 1) {
        throw new SessionError(`Pointer y coordinate must be normalized between 0.0 and 1.0, got ${event.y}`);
      }
    }
  }

  return true;
}
