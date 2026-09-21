/**
 * Flutter Remote WebRTC V3 Browser Client & Modular Direct Engine
 *
 * ZERO MONKEY-PATCHING: Communicates directly over WebRTC Media and DataChannels.
 * Architecture:
 *   - ConnectionState: State machine & generation tracking
 *   - ReconnectController: Exponential backoff & retry scheduling
 *   - SignalingClient: WebSocket signaling for offer/answer & ICE trickle
 *   - PeerConnectionManager: RTCPeerConnection, ICE restart, ontrack
 *   - DataChannelManager: Discrete channels (input, keyboard, control, telemetry)
 *   - WebRTCStatsCollector: Normalized stats & delta-based packet loss rate
 *   - VideoRenderer: <video> element, aspect-ratio letterboxing, first-frame detection
 *   - InputController: Pointer capture, RAF move coalescing, RAF wheel delta accumulation
 *   - KeyboardController: Keydown/keyup, IME composition
 *   - ClipboardController: User-gesture copy/paste
 *   - SessionUI: Status banner
 *   - DebugOverlay: Diagnostics display
 */

import { ConnectionState } from './connection/ConnectionState.js';
import { ReconnectController } from './connection/ReconnectController.js';
import { SignalingClient } from './connection/SignalingClient.js';

import { PeerConnectionManager } from './webrtc/PeerConnectionManager.js';
import { DataChannelManager } from './webrtc/DataChannelManager.js';
import { WebRTCStatsCollector } from './webrtc/WebRTCStatsCollector.js';

import { InputController } from './input/InputController.js';
import { KeyboardController } from './input/KeyboardController.js';
import { ClipboardController } from './input/ClipboardController.js';

import { VideoRenderer } from './video/VideoRenderer.js';

import { SessionUI } from './ui/SessionUI.js';
import { DebugOverlay } from './ui/DebugOverlay.js';

export class FlutterRemoteClient {
  constructor(options = {}) {
    const urlParams = typeof window !== 'undefined' && window.location
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();

    this.sessionId = options.sessionId || urlParams.get('session') || 'active';
    this.token = options.token || urlParams.get('k') || '';
    this.debugMode = options.debugMode !== undefined
      ? options.debugMode
      : (urlParams.get('debug') === '1');
    this.protocolVersion = options.protocolVersion || 2;

    const container = options.container || (typeof document !== 'undefined'
      ? (document.getElementById('flutter-remote-container') || document.body)
      : null);

    this.connectionState = new ConnectionState();
    this.reconnectController = new ReconnectController(this.connectionState);

    this.metrics = {
      rtt: 0,
      fps: 0,
      bitrate: 0,
      jitter: 0,
      packetsLostTotal: 0,
      packetLossRate: 0,
      packetLossDisplay: '0.00%',
      firstFrameTime: 0,
      reconnects: 0,
      connectionState: 'IDLE',
      iceState: 'new',
      candidateType: 'unknown',
      generation: 1,
    };

    // UI Modules
    this.ui = container ? new SessionUI(container) : null;
    this.debugOverlay = (container && this.debugMode) ? new DebugOverlay(container) : null;

    this._videoFrameCheckTimer = null;

    // Video Module
    this.videoRenderer = container
      ? new VideoRenderer(container, {
          onFirstFrame: (firstFrameTime) => {
            if (this._videoFrameCheckTimer) {
              clearTimeout(this._videoFrameCheckTimer);
              this._videoFrameCheckTimer = null;
            }
            if (this.ui) this.ui.setStatus('Connected', true);
            this.metrics.firstFrameTime = firstFrameTime;
            this._updateDebug();
          },
        })
      : null;

    // WebRTC Modules
    this.peerConnectionManager = new PeerConnectionManager({
      iceConfigUrl: options.iceConfigUrl || '/ice-config',
      onTrack: (event) => this._handleTrack(event),
      onIceCandidate: (candidate) => this._handleIceCandidate(candidate),
      onIceConnectionStateChange: (state) => this._handleIceConnectionState(state),
      onConnectionStateChange: (state) => {
        this.metrics.connectionState = state;
        this._updateDebug();
      },
    });

    this.dataChannelManager = new DataChannelManager(this.peerConnectionManager, {
      onOpen: (name) => this._handleDataChannelOpen(name),
    });

    // Input Modules
    this.inputController = container && this.videoRenderer
      ? new InputController(container, this.videoRenderer, this.dataChannelManager, {
          protocolVersion: this.protocolVersion,
        })
      : null;

    this.keyboardController = new KeyboardController(this.dataChannelManager, {
      protocolVersion: this.protocolVersion,
    });

    this.clipboardController = new ClipboardController(this.dataChannelManager, {
      protocolVersion: this.protocolVersion,
    });

    // Stats Module
    this.statsCollector = new WebRTCStatsCollector(this.peerConnectionManager, {
      intervalMs: 1000,
      onMetrics: (sample) => this._handleMetrics(sample),
    });

    // Connection / Signaling Module
    this.signaling = new SignalingClient({
      url: options.signalingUrl,
      sessionId: this.sessionId,
      token: this.token,
      connectionState: this.connectionState,
      onMessage: (msg) => this._handleSignalingMessage(msg),
      onOpen: async () => {
        if (this.ui) this.ui.setStatus('Negotiating WebRTC...');
        await this._initPeerConnection();
      },
      onClose: () => this._scheduleReconnect(),
      onError: () => this._scheduleReconnect(),
    });

    // Event Wire-up
    this.connectionState.onChange((state, gen) => {
      this.metrics.connectionState = state;
      this.metrics.generation = gen;
      if (this.ui) {
        if (state === 'CONNECTING') this.ui.setStatus('Connecting to remote simulator...');
        else if (state === 'CONNECTED') this.ui.setStatus('Connected', true);
        else if (state === 'RECONNECTING') this.ui.setStatus(`Reconnecting (Gen ${gen})...`);
      }
      this._updateDebug();
    });

    this._boundResize = () => this._handleResize();
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this._boundResize);
    }

    if (this.debugMode) {
      this.statsCollector.start();
    }

    this._destroyed = false;

    if (options.autoConnect !== false) {
      this.start();
    }
  }

  start() {
    this.connectionState.set('CONNECTING');
    this.signaling.connect();
  }

  connect() {
    this.start();
  }

  async _initPeerConnection(isRestart = false) {
    try {
      if (!isRestart) {
        await this.peerConnectionManager.createPeer();
        this.dataChannelManager.setupChannels();
      }

      const offer = await this.peerConnectionManager.createOffer({ iceRestart: isRestart });
      this.signaling.sendOffer(offer.sdp, offer.iceServers);
    } catch (err) {
      console.warn('[flutter-remote] PeerConnection init error:', err.message);
      this._scheduleReconnect();
    }
  }

  async _handleSignalingMessage(msg) {
    try {
      if (msg.type === 'answer') {
        const sdp = (msg.payload && msg.payload.sdp) || msg.sdp;
        await this.peerConnectionManager.handleAnswer(sdp);
      } else if (msg.type === 'ice-candidate' || msg.type === 'candidate') {
        const cand = msg.payload || msg.candidate;
        if (cand && cand.candidate) {
          await this.peerConnectionManager.addIceCandidate(cand);
        }
      }
    } catch (err) {
      console.warn('[flutter-remote] Signaling message handling error:', err.message);
    }
  }

  _handleTrack(event) {
    if (this.videoRenderer) {
      if (event.streams && event.streams[0]) {
        this.videoRenderer.attachStream(event.streams[0]);
      } else if (event.track) {
        this.videoRenderer.attachStream(new MediaStream([event.track]));
      }
    }
    this.connectionState.set('CONNECTED');
    this.reconnectController.reset();

    if (this._videoFrameCheckTimer) {
      clearTimeout(this._videoFrameCheckTimer);
    }
    this._videoFrameCheckTimer = setTimeout(() => {
      if (this.videoRenderer && !this.videoRenderer.firstFrameTime && this.connectionState.state === 'CONNECTED') {
        if (this.ui) this.ui.setStatus('Connected, waiting for video feed...');
        console.warn('[flutter-remote] WebRTC connected, but 0 video frames decoded after 5s');
      }
    }, 5000);
  }

  _handleIceCandidate(candidate) {
    this.signaling.sendCandidate(candidate);
  }

  _handleIceConnectionState(iceState) {
    this.metrics.iceState = iceState;
    if (iceState === 'disconnected') {
      this._attemptIceRestart();
    } else if (iceState === 'failed') {
      this._scheduleReconnect();
    }
    this._updateDebug();
  }

  _handleDataChannelOpen(name) {
    if (name === 'input') {
      this.connectionState.set('CONNECTED');
      this.reconnectController.reset();
    }
  }

  async _attemptIceRestart() {
    console.log('[flutter-remote] ICE disconnected, attempting ICE restart...');
    try {
      await this._initPeerConnection(true);
    } catch {
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this._destroyed) return;
    this.metrics.reconnects++;
    this.reconnectController.scheduleReconnect(async () => {
      try {
        if (this.signaling && this.signaling.isOpen) {
          await this._initPeerConnection(false);
        } else {
          this.start();
        }
      } catch {
        this._scheduleReconnect();
      }
    });
  }

  _handleResize() {
    if (!this.videoRenderer) return;
    const bounds = this.videoRenderer.getBounds();
    this.dataChannelManager.sendControl({
      v: this.protocolVersion,
      type: 'resize',
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
  }

  _handleMetrics(sample) {
    const conn = sample.connection || {};
    const vid = sample.video || {};
    const pkt = sample.packets || {};

    this.metrics.rtt = conn.rtt || 0;
    this.metrics.candidateType = conn.candidateType || 'unknown';
    this.metrics.fps = vid.fps || 0;
    this.metrics.bitrate = vid.bitrate || 0;
    this.metrics.jitter = vid.jitter || 0;
    this.metrics.packetsLostTotal = pkt.lost || 0;
    this.metrics.packetLossRate = pkt.lossRate || 0;
    this.metrics.packetLossDisplay = pkt.lossPercentage || '0.00%';

    this._updateDebug();
  }

  _updateDebug() {
    if (this.debugOverlay) {
      this.debugOverlay.update(
        {
          connection: {
            connectionState: this.metrics.connectionState,
            iceState: this.metrics.iceState,
            candidateType: this.metrics.candidateType,
            rtt: this.metrics.rtt,
          },
          video: {
            fps: this.metrics.fps,
            bitrate: this.metrics.bitrate,
            jitter: this.metrics.jitter,
          },
          packets: {
            lossPercentage: this.metrics.packetLossDisplay,
            lost: this.metrics.packetsLostTotal,
          },
        },
        {
          firstFrameTime: this.metrics.firstFrameTime,
          reconnects: this.metrics.reconnects,
          generation: this.metrics.generation,
        }
      );
    }
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    if (typeof window !== 'undefined' && this._boundResize) {
      window.removeEventListener('resize', this._boundResize);
      this._boundResize = null;
    }

    if (this._videoFrameCheckTimer) {
      clearTimeout(this._videoFrameCheckTimer);
      this._videoFrameCheckTimer = null;
    }
    if (this.statsCollector) {
      this.statsCollector.stop();
    }
    if (this.reconnectController) {
      this.reconnectController.cancel();
    }
    if (this.inputController) {
      this.inputController.destroy();
    }
    if (this.keyboardController) {
      this.keyboardController.destroy();
    }
    if (this.clipboardController) {
      this.clipboardController.destroy();
    }
    if (this.dataChannelManager) {
      this.dataChannelManager.close();
    }
    if (this.peerConnectionManager) {
      this.peerConnectionManager.close();
    }
    if (this.signaling) {
      this.signaling.close();
    }
    if (this.videoRenderer) {
      this.videoRenderer.destroy();
    }
    if (this.ui) {
      this.ui.destroy();
    }
    if (this.debugOverlay) {
      this.debugOverlay.destroy();
    }
    if (this.connectionState) {
      this.connectionState.set('CLOSED');
    }
  }

  close() {
    this.destroy();
  }
}

// Browser bootstrap
if (typeof window !== 'undefined') {
  if (!window.__flutterRemoteV3Initialized) {
    window.__flutterRemoteV3Initialized = true;
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      window.__flutterRemoteClient = new FlutterRemoteClient();
    } else {
      window.addEventListener('DOMContentLoaded', () => {
        window.__flutterRemoteClient = new FlutterRemoteClient();
      });
    }
  }
}
