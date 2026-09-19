/**
 * Flutter Remote WebRTC V2 Peer Manager
 */

import { EventEmitter } from 'node:events';
import { PeerConnectionWrapper } from './PeerConnection.js';
import { logger } from '../shared/logger.js';

export class PeerManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sessionId = options.sessionId;
    this.iceServers = options.iceServers || ['stun:stun.cloudflare.com:3478'];
    this.preferredCodec = options.codec || 'auto';
    this.generation = 1;
    this.currentPeer = null;
  }

  async createPeer(options = {}) {
    // Ensure previous peer is closed before creating a new one
    if (this.currentPeer) {
      await this.closeCurrentPeer('replaced_by_new_generation');
    }

    const peer = new PeerConnectionWrapper({
      sessionId: this.sessionId,
      generation: this.generation,
      iceServers: options.iceServers || this.iceServers,
      codec: options.codec || this.preferredCodec,
    });

    await peer.init(options.nativePeerOverride || null);
    this.currentPeer = peer;

    // Relay events
    peer.on('local_description', (data) => this.emit('local_description', data));
    peer.on('local_candidate', (data) => this.emit('local_candidate', data));
    peer.on('datachannel', (data) => this.emit('datachannel', data));

    peer.state.on('transition', (entry) => {
      this.emit('state_change', { generation: this.generation, ...entry });
    });

    logger.info('webrtc.peer_created', { sessionId: this.sessionId, generation: this.generation });
    this.emit('peer_created', { peer, generation: this.generation });
    return peer;
  }

  async recreatePeer(reason = 'reconnect') {
    this.generation++;
    logger.info('webrtc.peer_recreating', {
      sessionId: this.sessionId,
      newGeneration: this.generation,
      reason,
    });
    return this.createPeer();
  }

  async closeCurrentPeer(reason = 'closed') {
    if (this.currentPeer) {
      logger.info('webrtc.peer_closing', {
        sessionId: this.sessionId,
        generation: this.currentPeer.generation,
        reason,
      });
      this.currentPeer.close();
      this.emit('peer_closed', { generation: this.currentPeer.generation, reason });
      this.currentPeer = null;
    }
  }

  get activePeer() {
    return this.currentPeer;
  }

  async close(reason = 'shutdown') {
    await this.closeCurrentPeer(reason);
    this.removeAllListeners();
  }
}
