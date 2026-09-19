/**
 * Flutter Remote WebRTC V2 ICE Candidate Handler
 */

import { logger } from '../shared/logger.js';

export class IceHandler {
  constructor(peerConnection, options = {}) {
    this.peerConnection = peerConnection;
    this.generation = options.generation !== undefined ? options.generation : 1;
    this._bufferedCandidates = [];
    this._remoteDescriptionSet = false;
  }

  setRemoteDescriptionReady() {
    this._remoteDescriptionSet = true;
    this._flushBuffered();
  }

  handleCandidate(candidateData, candidateGeneration = this.generation) {
    if (candidateGeneration < this.generation) {
      logger.debug('ice.candidate_stale_dropped', {
        generation: candidateGeneration,
        activeGeneration: this.generation,
      });
      return false;
    }

    if (!candidateData || !candidateData.candidate) {
      return false;
    }

    if (!this._remoteDescriptionSet) {
      this._bufferedCandidates.push(candidateData);
      return true;
    }

    this._applyCandidate(candidateData);
    return true;
  }

  _applyCandidate(candidateData) {
    try {
      const mid = candidateData.sdpMid || '0';
      if (this.peerConnection && typeof this.peerConnection.addRemoteCandidate === 'function') {
        this.peerConnection.addRemoteCandidate(candidateData.candidate, mid);
      }
    } catch (err) {
      logger.warn('ice.candidate_apply_failed', { error: err.message });
    }
  }

  _flushBuffered() {
    while (this._bufferedCandidates.length > 0) {
      const candidate = this._bufferedCandidates.shift();
      this._applyCandidate(candidate);
    }
  }

  get bufferedCount() {
    return this._bufferedCandidates.length;
  }

  clear() {
    this._bufferedCandidates = [];
    this._remoteDescriptionSet = false;
  }
}
