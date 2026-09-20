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
(function() {
  'use strict';

  if (window.__flutterRemoteV3Initialized) return;
  window.__flutterRemoteV3Initialized = true;

  const PROTOCOL_VERSION = 2;
  const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 10000];

  // 1. ConnectionState Machine
  class ConnectionState {
    constructor() {
      this.state = 'IDLE'; // IDLE, CONNECTING, CONNECTED, DISCONNECTED, RECONNECTING, FAILED, CLOSED
      this.generation = 1;
      this.listeners = new Set();
    }

    set(newState) {
      if (this.state === newState) return;
      this.state = newState;
      for (const fn of this.listeners) {
        try { fn(this.state, this.generation); } catch {}
      }
    }

    onChange(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }

    advanceGeneration() {
      this.generation++;
      return this.generation;
    }

    isStale(gen) {
      return Boolean(gen && gen < this.generation);
    }
  }

  // 2. ReconnectController
  class ReconnectController {
    constructor(connectionState) {
      this.connectionState = connectionState;
      this.reconnectAttempt = 0;
      this.reconnectTimer = null;
      this.totalReconnects = 0;
    }

    scheduleReconnect(callback) {
      if (this.reconnectTimer) return;
      this.connectionState.set('RECONNECTING');
      this.totalReconnects++;

      const delayIndex = Math.min(this.reconnectAttempt, BACKOFF_MS.length - 1);
      const delay = BACKOFF_MS[delayIndex];
      this.reconnectAttempt++;

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connectionState.advanceGeneration();
        callback(this.connectionState.generation);
      }, delay);
    }

    reset() {
      this.reconnectAttempt = 0;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    }
  }

  // 3. SignalingClient
  class SignalingClient {
    constructor(sessionId, token, connectionState, onMessage, onOpen, onClose) {
      this.sessionId = sessionId;
      this.token = token;
      this.connectionState = connectionState;
      this.onMessage = onMessage;
      this.onOpen = onOpen;
      this.onClose = onClose;
      this.ws = null;
    }

    connect() {
      this.close();
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${location.host}/signal?session=${encodeURIComponent(this.sessionId)}&k=${encodeURIComponent(this.token)}`;

      this.ws = new WebSocket(url);
      this.ws.onopen = () => this.onOpen();
      this.ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (this.connectionState.isStale(msg.generation)) return;
          this.onMessage(msg);
        } catch (err) {
          console.warn('[Signaling parse error]', err);
        }
      };
      this.ws.onclose = () => this.onClose();
    }

    send(msg) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        if (typeof msg === 'object') {
          if (!msg.generation) msg.generation = this.connectionState.generation;
          if (!msg.sessionId) msg.sessionId = this.sessionId;
          this.ws.send(JSON.stringify(msg));
        } else {
          this.ws.send(msg);
        }
      }
    }

    close() {
      if (this.ws) {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onclose = null;
        try { this.ws.close(); } catch {}
        this.ws = null;
      }
    }
  }

  // 4. VideoRenderer
  class VideoRenderer {
    constructor(container) {
      this.container = container;
      this.video = null;
      this.firstFrameTime = 0;
      this.connectTime = Date.now();
      this._initElement();
    }

    _initElement() {
      let video = document.getElementById('flutter-remote-video');
      if (!video) {
        video = document.createElement('video');
        video.id = 'flutter-remote-video';
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        video.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;display:block;';
        this.container.appendChild(video);
      }
      this.video = video;

      this.video.addEventListener('loadeddata', () => {
        if (!this.firstFrameTime) {
          this.firstFrameTime = Date.now() - this.connectTime;
          console.log(`[flutter-remote] First video frame rendered in ${this.firstFrameTime}ms`);
        }
      });
    }

    attachStream(stream) {
      this.connectTime = Date.now();
      this.firstFrameTime = 0;
      this.video.srcObject = stream;
      this.video.play().catch(() => {});
    }

    getBounds() {
      return this.video.getBoundingClientRect();
    }

    getVideoResolution() {
      return {
        width: this.video.videoWidth || 720,
        height: this.video.videoHeight || 1280,
      };
    }
  }

  // 5. InputController with Pointer & Wheel Coalescing
  class InputController {
    constructor(container, videoRenderer, dataChannels) {
      this.container = container;
      this.videoRenderer = videoRenderer;
      this.dataChannels = dataChannels;
      this.overlay = null;
      this.nextSeq = 1;

      // Pointer move coalescing
      this.pendingMove = null;
      this.pointerRafId = null;

      // Wheel delta accumulation & coalescing
      this.pendingWheelDeltaX = 0;
      this.pendingWheelDeltaY = 0;
      this.wheelRafId = null;

      this._initOverlay();
    }

    _initOverlay() {
      let overlay = document.getElementById('flutter-remote-input-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'flutter-remote-input-overlay';
        overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;touch-action:none;cursor:pointer;z-index:10;';
        this.container.style.position = 'relative';
        this.container.appendChild(overlay);
      }
      this.overlay = overlay;

      const sendPointer = (evt) => {
        const dc = this.dataChannels.input;
        if (dc && dc.readyState === 'open') {
          if (dc.bufferedAmount > 65536 && evt.event === 'move') return;
          dc.send(JSON.stringify(evt));
        }
      };

      const flushPointer = () => {
        if (this.pendingMove) {
          sendPointer(this.pendingMove);
          this.pendingMove = null;
        }
        this.pointerRafId = null;
      };

      const handlePointer = (e, type) => {
        const rect = this.videoRenderer.getBounds();
        const { width: vW, height: vH } = this.videoRenderer.getVideoResolution();
        const containerAspect = rect.width / rect.height;
        const videoAspect = vW / vH;

        let dispW = rect.width;
        let dispH = rect.height;
        let offX = 0;
        let offY = 0;

        if (containerAspect > videoAspect) {
          dispW = rect.height * videoAspect;
          offX = (rect.width - dispW) / 2;
        } else {
          dispH = rect.width / videoAspect;
          offY = (rect.height - dispH) / 2;
        }

        const rawX = e.clientX - rect.left - offX;
        const rawY = e.clientY - rect.top - offY;
        const normX = Math.max(0, Math.min(1, rawX / dispW));
        const normY = Math.max(0, Math.min(1, rawY / dispH));

        const evt = {
          v: PROTOCOL_VERSION,
          type: 'pointer',
          seq: this.nextSeq++,
          ts: Date.now(),
          event: type,
          pointerId: e.pointerId || 1,
          x: Number(normX.toFixed(5)),
          y: Number(normY.toFixed(5)),
          button: e.button || 0,
          buttons: e.buttons !== undefined ? e.buttons : 1,
        };

        if (type === 'down') {
          try { this.overlay.setPointerCapture(e.pointerId); } catch {}
          if (this.pointerRafId) { cancelAnimationFrame(this.pointerRafId); flushPointer(); }
          sendPointer(evt);
        } else if (type === 'up' || type === 'cancel') {
          try { this.overlay.releasePointerCapture(e.pointerId); } catch {}
          if (this.pointerRafId) { cancelAnimationFrame(this.pointerRafId); flushPointer(); }
          sendPointer(evt);
        } else if (type === 'move') {
          this.pendingMove = evt;
          if (!this.pointerRafId) {
            this.pointerRafId = requestAnimationFrame(flushPointer);
          }
        }
      };

      this.overlay.addEventListener('pointerdown', (e) => handlePointer(e, 'down'));
      this.overlay.addEventListener('pointermove', (e) => handlePointer(e, 'move'));
      this.overlay.addEventListener('pointerup', (e) => handlePointer(e, 'up'));
      this.overlay.addEventListener('pointercancel', (e) => handlePointer(e, 'cancel'));

      // Coalesced Wheel / Scroll
      const flushWheel = () => {
        if (this.pendingWheelDeltaX !== 0 || this.pendingWheelDeltaY !== 0) {
          const dc = this.dataChannels.input;
          if (dc && dc.readyState === 'open') {
            dc.send(JSON.stringify({
              v: PROTOCOL_VERSION,
              type: 'scroll',
              seq: this.nextSeq++,
              ts: Date.now(),
              deltaX: this.pendingWheelDeltaX,
              deltaY: this.pendingWheelDeltaY,
            }));
          }
          this.pendingWheelDeltaX = 0;
          this.pendingWheelDeltaY = 0;
        }
        this.wheelRafId = null;
      };

      this.overlay.addEventListener('wheel', (e) => {
        e.preventDefault();
        this.pendingWheelDeltaX += e.deltaX;
        this.pendingWheelDeltaY += e.deltaY;

        if (!this.wheelRafId) {
          this.wheelRafId = requestAnimationFrame(flushWheel);
        }
      }, { passive: false });
    }
  }

  // 6. KeyboardController
  class KeyboardController {
    constructor(dataChannels) {
      this.dataChannels = dataChannels;
      this.nextSeq = 1;
      this._init();
    }

    _init() {
      const sendKey = (e, eventType) => {
        const dc = this.dataChannels.keyboard;
        if (dc && dc.readyState === 'open') {
          dc.send(JSON.stringify({
            v: PROTOCOL_VERSION,
            type: 'keyboard',
            seq: this.nextSeq++,
            ts: Date.now(),
            event: eventType,
            key: e.key,
            code: e.code,
            isComposing: Boolean(e.isComposing),
          }));
        }
      };

      window.addEventListener('keydown', (e) => sendKey(e, 'keydown'));
      window.addEventListener('keyup', (e) => sendKey(e, 'keyup'));
    }
  }

  // 7. ClipboardController
  class ClipboardController {
    constructor(dataChannels) {
      this.dataChannels = dataChannels;
      this.nextSeq = 1;
      this._init();
    }

    _init() {
      window.addEventListener('paste', async (e) => {
        let text = '';
        if (e.clipboardData) {
          text = e.clipboardData.getData('text/plain');
        } else if (navigator.clipboard && navigator.clipboard.readText) {
          try { text = await navigator.clipboard.readText(); } catch {}
        }
        if (text) this.sendClipboard(text);
      });
    }

    sendClipboard(text) {
      const dc = this.dataChannels.control;
      if (dc && dc.readyState === 'open') {
        dc.send(JSON.stringify({
          v: PROTOCOL_VERSION,
          type: 'clipboard',
          seq: this.nextSeq++,
          ts: Date.now(),
          text: String(text),
        }));
      }
    }
  }

  // 8. WebRTCStatsCollector (Delta-Based Packet Loss)
  class WebRTCStatsCollector {
    constructor(peerProvider, onMetrics) {
      this.peerProvider = peerProvider;
      this.onMetrics = onMetrics;
      this.timer = null;
      this.prevStats = {
        ts: 0,
        bytesReceived: 0,
        packetsReceived: 0,
        packetsLost: 0,
      };
    }

    start() {
      this.stop();
      this.timer = setInterval(() => this.sample(), 1000);
    }

    stop() {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }

    async sample() {
      const peer = this.peerProvider();
      if (!peer || typeof peer.getStats !== 'function') return;

      try {
        const stats = await peer.getStats();
        const now = Date.now();
        let rtt = 0;
        let candidateType = 'unknown';
        let fps = 0;
        let bytesReceived = 0;
        let packetsReceived = 0;
        let packetsLost = 0;
        let jitter = 0;

        stats.forEach((report) => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            rtt = Math.round((report.currentRoundTripTime || 0) * 1000);
          }
          if (report.type === 'remote-candidate') {
            candidateType = report.candidateType || candidateType;
          }
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            fps = Math.round(report.framesPerSecond || 0);
            bytesReceived = report.bytesReceived || 0;
            packetsReceived = report.packetsReceived || 0;
            packetsLost = report.packetsLost || 0;
            jitter = Math.round((report.jitter || 0) * 1000);
          }
        });

        let bitrate = 0;
        let lossRate = 0;

        if (this.prevStats.ts > 0) {
          const timeDelta = (now - this.prevStats.ts) / 1000;
          if (timeDelta > 0) {
            const bytesDelta = Math.max(0, bytesReceived - this.prevStats.bytesReceived);
            bitrate = Math.round((bytesDelta * 8) / (timeDelta * 1000)); // kbps

            // Delta-based packet loss calculation:
            const lostDelta = Math.max(0, packetsLost - this.prevStats.packetsLost);
            const rcvdDelta = Math.max(0, packetsReceived - this.prevStats.packetsReceived);
            const totalDelta = lostDelta + rcvdDelta;
            lossRate = totalDelta > 0 ? (lostDelta / totalDelta) : 0;
          }
        }

        this.prevStats = { ts: now, bytesReceived, packetsReceived, packetsLost };

        this.onMetrics({
          rtt,
          candidateType,
          fps,
          bitrate,
          jitter,
          packetsLostTotal: packetsLost,
          packetLossRate: lossRate,
          packetLossDisplay: `${(lossRate * 100).toFixed(2)}%`,
        });
      } catch {}
    }
  }

  // 9. SessionUI & DebugOverlay
  class SessionUI {
    constructor(container, debugMode = false) {
      this.container = container;
      this.debugMode = debugMode;
      this.statusEl = null;
      this.debugPanel = null;
      this._init();
    }

    _init() {
      let status = document.getElementById('flutter-remote-status');
      if (!status) {
        status = document.createElement('div');
        status.id = 'flutter-remote-status';
        status.style.cssText = 'position:absolute;top:10px;left:50%;transform:translateX(-50%);padding:6px 14px;background:rgba(0,0,0,0.75);color:#fff;border-radius:20px;font:12px sans-serif;z-index:20;transition:opacity 0.3s;pointer-events:none;';
        this.container.appendChild(status);
      }
      this.statusEl = status;

      if (this.debugMode) {
        let debugPanel = document.getElementById('flutter-remote-debug-panel');
        if (!debugPanel) {
          debugPanel = document.createElement('div');
          debugPanel.id = 'flutter-remote-debug-panel';
          debugPanel.style.cssText = 'position:absolute;bottom:10px;left:10px;padding:10px;background:rgba(0,0,0,0.85);color:#0f0;font:11px monospace;border-radius:6px;z-index:30;pointer-events:none;line-height:1.4;';
          this.container.appendChild(debugPanel);
        }
        this.debugPanel = debugPanel;
      }
    }

    setStatus(text, autoHide = false) {
      if (this.statusEl) {
        this.statusEl.textContent = text;
        this.statusEl.style.opacity = '1';
        if (autoHide) {
          setTimeout(() => {
            if (this.statusEl && this.statusEl.textContent === text) {
              this.statusEl.style.opacity = '0';
            }
          }, 2000);
        }
      }
    }

    updateDebug(metrics) {
      if (!this.debugPanel) return;
      const bitrateStr = metrics.bitrate >= 1000
        ? `${(metrics.bitrate / 1000).toFixed(2)} Mbps`
        : `${metrics.bitrate} kbps`;

      this.debugPanel.innerHTML = `
        <div><strong>Flutter Remote V3 Diagnostics</strong></div>
        <div>Connection: ${metrics.connectionState}</div>
        <div>ICE: ${metrics.iceState} (${metrics.candidateType || 'unknown'})</div>
        <div>RTT: ${metrics.rtt} ms</div>
        <div>FPS: ${metrics.fps}</div>
        <div>Bitrate: ${bitrateStr}</div>
        <div>Jitter: ${metrics.jitter || 0} ms</div>
        <div>Packet Loss: ${metrics.packetLossDisplay || '0.00%'} (total: ${metrics.packetsLostTotal || 0})</div>
        <div>First Frame: ${metrics.firstFrameTime ? metrics.firstFrameTime + 'ms' : 'pending'}</div>
        <div>Reconnects: ${metrics.reconnects}</div>
        <div>Generation: ${metrics.generation}</div>
      `;
    }
  }

  // 10. FlutterRemoteClient Orchestrator
  class FlutterRemoteClient {
    constructor() {
      const urlParams = new URLSearchParams(window.location.search);
      this.sessionId = urlParams.get('session') || 'active';
      this.token = urlParams.get('k') || '';
      this.debugMode = urlParams.get('debug') === '1';

      this.connectionState = new ConnectionState();
      this.reconnectController = new ReconnectController(this.connectionState);
      this.peer = null;
      this.dataChannels = {};

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

      const container = document.getElementById('flutter-remote-container') || document.body;
      this.ui = new SessionUI(container, this.debugMode);
      this.videoRenderer = new VideoRenderer(container);
      this.inputController = new InputController(container, this.videoRenderer, this.dataChannels);
      this.keyboardController = new KeyboardController(this.dataChannels);
      this.clipboardController = new ClipboardController(this.dataChannels);

      this.statsCollector = new WebRTCStatsCollector(
        () => this.peer,
        (sample) => {
          Object.assign(this.metrics, sample);
          this.metrics.firstFrameTime = this.videoRenderer.firstFrameTime;
          this.ui.updateDebug(this.metrics);
        }
      );

      this.signaling = new SignalingClient(
        this.sessionId,
        this.token,
        this.connectionState,
        (msg) => this._handleSignalingMessage(msg),
        async () => {
          this.ui.setStatus('Negotiating WebRTC...');
          await this._initPeerConnection();
        },
        () => this._scheduleReconnect()
      );

      this.connectionState.onChange((state, gen) => {
        this.metrics.connectionState = state;
        this.metrics.generation = gen;
        if (state === 'CONNECTING') this.ui.setStatus('Connecting to remote simulator...');
        else if (state === 'CONNECTED') this.ui.setStatus('Connected', true);
        else if (state === 'RECONNECTING') this.ui.setStatus(`Reconnecting (Gen ${gen})...`);
      });

      window.addEventListener('resize', () => this._handleResize());
      if (this.debugMode) this.statsCollector.start();

      this._connect();
    }

    _connect() {
      this.connectionState.set('CONNECTING');
      this.signaling.connect();
    }

    async _handleSignalingMessage(msg) {
      try {
        if (msg.type === 'answer' && this.peer) {
          const sdp = (msg.payload && msg.payload.sdp) || msg.sdp;
          await this.peer.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
        } else if ((msg.type === 'ice-candidate' || msg.type === 'candidate') && this.peer) {
          const cand = msg.payload || msg.candidate;
          if (cand && cand.candidate) {
            await this.peer.addIceCandidate(new RTCIceCandidate(cand));
          }
        }
      } catch (err) {
        console.warn('[Signaling message error]', err);
      }
    }

    async _initPeerConnection(isRestart = false) {
      if (!isRestart && this.peer) {
        try { this.peer.close(); } catch {}
        this.peer = null;
      }

      let iceServers = [{ urls: 'stun:stun.cloudflare.com:3478' }];
      try {
        const res = await fetch('/ice-config');
        const data = await res.json();
        if (data && data.iceServers) iceServers = data.iceServers;
      } catch {}

      if (!this.peer) {
        this.peer = new RTCPeerConnection({ iceServers });

        this.peer.ontrack = (event) => {
          if (event.streams && event.streams[0]) {
            this.videoRenderer.attachStream(event.streams[0]);
          } else {
            this.videoRenderer.attachStream(new MediaStream([event.track]));
          }
          this.connectionState.set('CONNECTED');
          this.reconnectController.reset();
        };

        // Discrete DataChannels
        this.dataChannels.input = this.peer.createDataChannel('input', { ordered: false, maxRetransmits: 0 });
        this.dataChannels.keyboard = this.peer.createDataChannel('keyboard', { ordered: true });
        this.dataChannels.control = this.peer.createDataChannel('control', { ordered: true });
        this.dataChannels.telemetry = this.peer.createDataChannel('telemetry', { ordered: false, maxRetransmits: 0 });

        this.dataChannels.input.onopen = () => {
          this.connectionState.set('CONNECTED');
          this.reconnectController.reset();
        };

        this.peer.onicecandidate = (e) => {
          if (e.candidate) {
            this.signaling.send({
              v: PROTOCOL_VERSION,
              type: 'ice-candidate',
              payload: e.candidate,
            });
          }
        };

        this.peer.oniceconnectionstatechange = () => {
          this.metrics.iceState = this.peer.iceConnectionState;
          if (this.peer.iceConnectionState === 'disconnected') {
            this._attemptIceRestart();
          } else if (this.peer.iceConnectionState === 'failed') {
            this._scheduleReconnect();
          }
        };
      }

      const offer = await this.peer.createOffer({ offerToReceiveVideo: true, iceRestart: isRestart });
      await this.peer.setLocalDescription(offer);

      this.signaling.send({
        v: PROTOCOL_VERSION,
        type: 'offer',
        payload: { sdp: offer.sdp, iceServers },
      });
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
      this.metrics.reconnects++;
      this.reconnectController.scheduleReconnect(async () => {
        try {
          if (this.signaling.ws && this.signaling.ws.readyState === WebSocket.OPEN) {
            await this._initPeerConnection(false);
          } else {
            this._connect();
          }
        } catch {
          this._scheduleReconnect();
        }
      });
    }

    _handleResize() {
      const dc = this.dataChannels.control;
      if (dc && dc.readyState === 'open') {
        const bounds = this.videoRenderer.getBounds();
        dc.send(JSON.stringify({
          v: PROTOCOL_VERSION,
          type: 'resize',
          width: Math.round(bounds.width),
          height: Math.round(bounds.height),
        }));
      }
    }
  }

  // Bootstrap client on DOM load
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    window.__flutterRemoteClient = new FlutterRemoteClient();
  } else {
    window.addEventListener('DOMContentLoaded', () => {
      window.__flutterRemoteClient = new FlutterRemoteClient();
    });
  }
})();
