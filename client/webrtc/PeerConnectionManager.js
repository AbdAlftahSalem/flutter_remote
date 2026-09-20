/**
 * Flutter Remote WebRTC V3 PeerConnectionManager
 *
 * Encapsulates RTCPeerConnection lifecycle, ICE server fetching,
 * offer creation, ICE candidate negotiation, ICE restart, and track handlers.
 */

export class PeerConnectionManager {
  constructor({
    iceConfigUrl = '/ice-config',
    onTrack,
    onIceCandidate,
    onIceConnectionStateChange,
    onConnectionStateChange,
  } = {}) {
    this.iceConfigUrl = iceConfigUrl;
    this.onTrack = onTrack || (() => {});
    this.onIceCandidate = onIceCandidate || (() => {});
    this.onIceConnectionStateChange = onIceConnectionStateChange || (() => {});
    this.onConnectionStateChange = onConnectionStateChange || (() => {});

    this.peer = null;
    this.iceServers = [{ urls: 'stun:stun.cloudflare.com:3478' }];
  }

  async fetchIceServers() {
    try {
      const res = await fetch(this.iceConfigUrl);
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.iceServers) && data.iceServers.length > 0) {
          this.iceServers = data.iceServers;
        }
      }
    } catch (err) {
      console.warn('[PeerConnectionManager fetchIceServers fallback to STUN]', err.message);
    }
    return this.iceServers;
  }

  async createPeer() {
    this.close();
    await this.fetchIceServers();

    this.peer = new RTCPeerConnection({ iceServers: this.iceServers });

    this.peer.ontrack = (event) => {
      this.onTrack(event);
    };

    this.peer.onicecandidate = (event) => {
      if (event.candidate) {
        this.onIceCandidate(event.candidate);
      }
    };

    this.peer.oniceconnectionstatechange = () => {
      if (this.peer) {
        this.onIceConnectionStateChange(this.peer.iceConnectionState);
      }
    };

    this.peer.onconnectionstatechange = () => {
      if (this.peer) {
        this.onConnectionStateChange(this.peer.connectionState);
      }
    };

    return this.peer;
  }

  createDataChannel(label, options) {
    if (!this.peer) {
      throw new Error('Cannot create DataChannel: PeerConnection not initialized');
    }
    return this.peer.createDataChannel(label, options);
  }

  async createOffer({ iceRestart = false } = {}) {
    if (!this.peer) {
      await this.createPeer();
    }
    const offer = await this.peer.createOffer({
      offerToReceiveVideo: true,
      iceRestart,
    });
    await this.peer.setLocalDescription(offer);
    return {
      sdp: offer.sdp,
      iceServers: this.iceServers,
    };
  }

  async handleAnswer(sdp) {
    if (!this.peer) return;
    await this.peer.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
  }

  async addIceCandidate(candidate) {
    if (!this.peer) return;
    await this.peer.addIceCandidate(new RTCIceCandidate(candidate));
  }

  async restartIce() {
    return this.createOffer({ iceRestart: true });
  }

  async getStats() {
    if (this.peer && typeof this.peer.getStats === 'function') {
      return this.peer.getStats();
    }
    return null;
  }

  get iceConnectionState() {
    return this.peer ? this.peer.iceConnectionState : 'new';
  }

  get connectionState() {
    return this.peer ? this.peer.connectionState : 'new';
  }

  close() {
    if (this.peer) {
      this.peer.ontrack = null;
      this.peer.onicecandidate = null;
      this.peer.oniceconnectionstatechange = null;
      this.peer.onconnectionstatechange = null;
      try {
        this.peer.close();
      } catch {}
      this.peer = null;
    }
  }
}
