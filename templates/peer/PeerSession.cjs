// flutter-remote-template-version: 5
/**
 * Flutter Remote WebRTC V3 PeerSession (CommonJS)
 *
 * Manages an individual WebRTC client session:
 *   1. RTCPeerConnection negotiation (offer/answer/ice candidates)
 *   2. Video track setup (H.264 & VP8)
 *   3. DataChannels (input, keyboard, control, telemetry)
 *   4. Control channel commands (request_keyframe)
 */

const { DataChannelRouter } = require('./DataChannelRouter.cjs');

class PeerSession {
  constructor(options = {}) {
    this.ws = options.ws;
    this.ndc = options.ndc;
    this.videoEncoder = options.videoEncoder;
    this.serveSimConsumer = options.serveSimConsumer;
    this.activeVideoTracks = options.activeVideoTracks;
    this.transportMode = options.transportMode || 'webrtc';
    this.qualityController = options.qualityController || null;

    this.peer = null;
    this.videoTrack = null;
    this.router = new DataChannelRouter();
  }

  handleOffer(msg) {
    console.log('[webrtc-peer] WebRTC offer received');
    const { PeerConnection, Video } = this.ndc;
    if (!PeerConnection) {
      console.error('[webrtc-peer] Cannot create peer: node-datachannel unavailable');
      return;
    }

    const rawIceServers = (msg.payload && msg.payload.iceServers) || msg.iceServers || ['stun:stun.cloudflare.com:3478'];
    const iceServers = [];
    for (const item of rawIceServers) {
      if (typeof item === 'string') {
        iceServers.push(item);
      } else if (item && typeof item === 'object') {
        const urls = item.urls || item.url;
        if (Array.isArray(urls)) {
          for (const u of urls) {
            iceServers.push(item.username && item.credential ? { urls: u, username: item.username, credential: item.credential } : u);
          }
        } else if (urls) {
          iceServers.push(item.username && item.credential ? { urls, username: item.username, credential: item.credential } : urls);
        }
      }
    }

    this.peer = new PeerConnection('serve-sim-peer', { iceServers });

    // Add Video track in V2/V3 mode
    if (Video && this.transportMode !== 'v1') {
      try {
        const video = new Video('video', 'SendOnly');
        video.addH264Codec(98);
        video.addVP8Codec(97);
        this.videoTrack = this.peer.addTrack(video);
        this.activeVideoTracks.add(this.videoTrack);
        console.log('[webrtc-peer] video track ready');

        // Send cached keyframe immediately to new subscriber
        if (this.videoEncoder.hasKeyframe()) {
          const keyPackets = this.videoEncoder.getKeyframePackets();
          for (const kp of keyPackets) {
            try { this.videoTrack.sendMessageBinary(kp); } catch {}
          }
        }

        this.serveSimConsumer.ensureLocalStream();
      } catch (err) {
        console.warn('[webrtc-peer video track error]', err.message);
      }
    }

    this.generation = msg.generation || 1;

    this.peer.onLocalDescription((sdp, type) => {
      if (this.ws.readyState === 1 /* OPEN */) {
        this.ws.send(JSON.stringify({
          v: 2,
          type,
          generation: this.generation,
          payload: { sdp },
        }));
      }
    });

    this.peer.onLocalCandidate((candidate, mid) => {
      if (this.ws.readyState === 1 /* OPEN */) {
        this.ws.send(JSON.stringify({
          v: 2,
          type: 'ice-candidate',
          generation: this.generation,
          payload: { candidate, sdpMid: mid },
        }));
      }
    });

    this.peer.onDataChannel((dc) => {
      const label = dc.getLabel ? dc.getLabel() : 'input';
      console.log('[webrtc-peer] DataChannel opened:', label);
      this.router.registerChannel(label, dc);
      this.serveSimConsumer.initServeSimWs();

      if (this.serveSimConsumer.serveSimWs) {
        this.router.setServeSimWs(this.serveSimConsumer.serveSimWs);
        this.router.start();
      }

      dc.onMessage((rawMsg) => {
        if (label === 'control') {
          try {
            const cmd = JSON.parse(rawMsg.toString());
            if (cmd.generation && cmd.generation < this.generation) {
              return; // drop stale generation control event
            }
            if (cmd.type === 'request_keyframe') {
              this.videoEncoder.requestKeyframe(cmd.reason || 'client_request');
              return;
            }
            if (cmd.type === 'quality' || cmd.type === 'bitrate') {
              if (cmd.bitrateKbps && typeof this.videoEncoder.setBitrate === 'function') {
                this.videoEncoder.setBitrate(cmd.bitrateKbps);
              }
              if (cmd.fps && typeof this.videoEncoder.setFramerate === 'function') {
                this.videoEncoder.setFramerate(cmd.fps);
              }
              return;
            }
            if (cmd.type === 'adaptation') {
              if (this.qualityController && typeof this.qualityController.evaluateTelemetry === 'function') {
                this.qualityController.evaluateTelemetry(cmd);
              }
              return;
            }
            if (cmd.type === 'resize') {
              if (cmd.width && cmd.height && typeof this.videoEncoder.setResolution === 'function') {
                this.videoEncoder.setResolution(cmd.width, cmd.height);
              }
              return;
            }
          } catch {}
        }
        this.serveSimConsumer.sendToServeSim(rawMsg);
      });
    });

    const offerSdp = (msg.payload && msg.payload.sdp) || msg.sdp;
    this.peer.setRemoteDescription(offerSdp, 'offer');
  }

  handleCandidate(msg) {
    if (!this.peer) return;
    if (msg.generation && msg.generation < this.generation) {
      return; // Ignore stale ICE candidate from previous generation
    }
    const candidateData = msg.payload || msg.candidate;
    if (candidateData && candidateData.candidate) {
      const mid = candidateData.sdpMid || '0';
      this.peer.addRemoteCandidate(candidateData.candidate, mid);
    }
  }

  close() {
    this.router.stop();
    if (this.videoTrack) {
      this.activeVideoTracks.delete(this.videoTrack);
      this.videoTrack = null;
    }
    if (this.peer) {
      try { this.peer.close(); } catch {}
      this.peer = null;
    }
  }
}

module.exports = {
  PeerSession,
};
