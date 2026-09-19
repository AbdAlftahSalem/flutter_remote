/**
 * Flutter Remote WebRTC V2 Shared Utilities
 */

import { randomBytes } from 'node:crypto';
import { BACKOFF_INTERVALS_MS } from './constants.js';

export function nowMs() {
  return Date.now();
}

export function generateToken(byteCount = 32) {
  return randomBytes(byteCount).toString('base64url');
}

export function generateSessionId() {
  return randomBytes(8).toString('hex');
}

export function calculateBackoff(attempt, maxMs = 10000) {
  const index = Math.min(attempt, BACKOFF_INTERVALS_MS.length - 1);
  const base = BACKOFF_INTERVALS_MS[index];
  // Add 10% random jitter to avoid thundering herd
  const jitter = Math.floor(Math.random() * (base * 0.1));
  return Math.min(base + jitter, maxMs);
}

export function createSequenceGenerator(start = 1) {
  let seq = start;
  return () => seq++;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
