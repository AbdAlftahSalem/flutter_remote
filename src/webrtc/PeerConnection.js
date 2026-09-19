/**
 * Flutter Remote WebRTC V2 Peer Connection Wrapper
 */

import { EventEmitter } from 'node:events';
import { WebRTCState } from './WebRTCState.js';
import { CONNECTION_STATES, CHANNELS, CHANNEL_CONFIGS, CODECS } from '../shared/constants.js';
import { WebRTCError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';

let ndcModule = null;
async function getNdc() {
  if (!ndcModule) {
    try {
      const imported = await import('node-datachannel');
      ndcModule = imported.default || imported;
    } catch (e) {
      ndcModule = null;
    }
  }
  return ndcModule;
}

export class PeerConnectionWrapper extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sessionId = options.sessionId;
    this.generation = options.generation || 1;
    this.iceServers = options.iceServers || ['stun:stun.cloudflare.com:3478'];
    this.preferredCodec = options.codec || CODECS.AUTO;
    this.state = new WebRTCState(CONNECTION_STATES.IDLE);

    this.nativePeer = null;
    this.videoTrack = null;
    this.dataChannels = new Map(); // name -> DataChannel
    this._closed = false;
  }

  async init(nativePeerOverride = null) {
    if (nativePeerOverride) {
      this.nativePeer = nativePeerOverride;
    } else {
      const ndc = await getNdc();
      if (!ndc || !ndc.PeerConnection) {
        throw new WebRTCError('node-datachannel PeerConnection not available');
      }

      const normalizedIce = this._normalizeIceServers(this.iceServers);
      this.nativePeer = new ndc.PeerConnection(`peer-${this.sessionId}-${this.generation}`, {
        iceServers: normalizedIce,
      });

      // Configure video track (SendOnly H264 & VP8)
      if (ndc.Video) {
        const video = new ndc.Video('video', 'SendOnly');
        video.addH264Codec(98);
        video.addVP8Codec(97);
        this.videoTrack = this.nativePeer.addTrack(video);
      }
    }

    this._setupNativeListeners();
    this.state.transition(CONNECTION_STATES.CONNECTING);
  }

  _setupNativeListeners() {
    if (!this.nativePeer) return;

    this.nativePeer.onLocalDescription((sdp, type) => {
      this.emit('local_description', { sdp, type, generation: this.generation });
    });

    this.nativePeer.onLocalCandidate((candidate, mid) => {
      this.emit('local_candidate', { candidate, sdpMid: mid, generation: this.generation });
    });

    this.nativePeer.onStateChange((nativeState) => {
      logger.debug('webrtc.native_state_change', { state: nativeState, generation: this.generation });
      if (nativeState === 'connected' && this.state.canTransition(CONNECTION_STATES.CONNECTED)) {
        this.state.transition(CONNECTION_STATES.CONNECTED);
      } else if (nativeState === 'failed' && this.state.canTransition(CONNECTION_STATES.FAILED)) {
        this.state.transition(CONNECTION_STATES.FAILED);
      } else if (nativeState === 'closed' && this.state.canTransition(CONNECTION_STATES.CLOSED)) {
        this.state.transition(CONNECTION_STATES.CLOSED);
      }
    });

    this.nativePeer.onDataChannel((dc) => {
      const label = dc.getLabel ? dc.getLabel() : dc.label;
      this.dataChannels.set(label, dc);
      this.emit('datachannel', { label, channel: dc, generation: this.generation });
    });
  }

  createDataChannel(name, options = null) {
    if (!this.nativePeer) throw new WebRTCError('PeerConnection not initialized');
    const opts = options || CHANNEL_CONFIGS[name] || { ordered: true };
    const dc = this.nativePeer.createDataChannel(name, opts);
    this.dataChannels.set(name, dc);
    return dc;
  }

  setRemoteDescription(sdp, type) {
    if (!this.nativePeer) throw new WebRTCError('PeerConnection not initialized');
    if (this.state.canTransition(CONNECTION_STATES.SIGNALING)) {
      this.state.transition(CONNECTION_STATES.SIGNALING);
    }
    this.nativePeer.setRemoteDescription(sdp, type);
  }

  setLocalDescription(type = 'offer') {
    if (!this.nativePeer) throw new WebRTCError('PeerConnection not initialized');
    this.nativePeer.setLocalDescription(type);
  }

  addRemoteCandidate(candidate, mid = '0') {
    if (!this.nativePeer) return;
    this.nativePeer.addRemoteCandidate(candidate, mid);
  }

  sendVideoRtp(packetBuffer) {
    if (!this.videoTrack || this._closed) return false;
    try {
      if (typeof this.videoTrack.sendMessageBinary === 'function') {
        this.videoTrack.sendMessageBinary(packetBuffer);
        return true;
      }
    } catch (err) {
      logger.warn('webrtc.video_rtp_send_failed', { error: err.message });
    }
    return false;
  }

  _normalizeIceServers(iceServers) {
    if (!Array.isArray(iceServers)) return ['stun:stun.cloudflare.com:3478'];
    const result = [];
    for (const item of iceServers) {
      if (typeof item === 'string') {
        result.push(item);
      } else if (item && typeof item === 'object') {
        const urls = item.urls || item.url;
        if (Array.isArray(urls)) {
          for (const u of urls) {
            result.push(item.username && item.credential ? { urls: u, username: item.username, credential: item.credential } : u);
          }
        } else if (urls) {
          result.push(item.username && item.credential ? { urls, username: item.username, credential: item.credential } : urls);
        }
      }
    }
    return result.length > 0 ? result : ['stun:stun.cloudflare.com:3478'];
  }

  close() {
    if (this._closed) return;
    this._closed = true;

    if (this.state.canTransition(CONNECTION_STATES.CLOSED)) {
      this.state.transition(CONNECTION_STATES.CLOSED);
    }

    if (this.nativePeer) {
      try {
        this.nativePeer.close();
      } catch {}
      this.nativePeer = null;
    }
    this.videoTrack = null;
    this.dataChannels.clear();
    this.removeAllListeners();
  }
}
