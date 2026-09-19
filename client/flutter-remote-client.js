/**
 * Flutter Remote WebRTC V2 Browser Client & Modular Direct Engine
 *
 * ZERO MONKEY-PATCHING: Communicates directly over WebRTC Media and DataChannels.
 * Architecture:
 *   - ConnectionState: State machine, generation IDs, backoff retry
 *   - WebRTCClient: RTCPeerConnection, ICE restart, signaling, discrete DataChannels
 *   - VideoRenderer: <video> element, aspect-ratio letterboxing, first-frame detection
 *   - InputController: Pointer capture, normalized coordinates, RAF coalescing, backpressure
 *   - KeyboardController: Keydown/keyup, IME composition
 *   - ClipboardController: User-gesture copy/paste
 *   - SessionUI: Status banner and diagnostics overlay
 */
(function() {
  'use strict';

  if (window.__flutterRemoteV2Initialized) return;
  window.__flutterRemoteV2Initialized = true;

  const PROTOCOL_VERSION = 2;
  const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 10000];

  // 1. ConnectionState Machine
  class ConnectionState {
    constructor() {
      this.state = 'IDLE'; // IDLE, CONNECTING, CONNECTED, DISCONNECTED, RECONNECTING, FAILED
      this.generation = 1;
      this.reconnectAttempt = 0;
      this.reconnectTimer = null;
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
    }

    advanceGeneration() {
      this.generation++;
      return this.generation;
    }

    resetBackoff() {
      this.reconnectAttempt = 0;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    }

    scheduleReconnect(callback) {
      if (this.reconnectTimer) return;
      this.set('RECONNECTING');
      const delay = BACKOFF_MS[Math.min(this.reconnectAttempt, BACKOFF_MS.length - 1)];
      this.reconnectAttempt++;

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.advanceGeneration();
        callback();
      }, delay);
    }
  }

  // 2. VideoRenderer
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

  // 3. InputController
  class InputController {
    constructor(container, videoRenderer, dataChannels) {
      this.container = container;
      this.videoRenderer = videoRenderer;
      this.dataChannels = dataChannels;
      this.overlay = null;
      this.nextSeq = 1;
      this.pendingMove = null;
      this.rafId = null;
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
          // Drop pointer moves if backpressure is high (> 64KB)
          if (dc.bufferedAmount > 65536 && evt.event === 'move') return;
          dc.send(JSON.stringify(evt));
        }
      };

      const flush = () => {
        if (this.pendingMove) {
          sendPointer(this.pendingMove);
          this.pendingMove = null;
        }
        this.rafId = null;
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
          if (this.rafId) { cancelAnimationFrame(this.rafId); flush(); }
          sendPointer(evt);
        } else if (type === 'up' || type === 'cancel') {
          try { this.overlay.releasePointerCapture(e.pointerId); } catch {}
          if (this.rafId) { cancelAnimationFrame(this.rafId); flush(); }
          sendPointer(evt);
        } else if (type === 'move') {
          this.pendingMove = evt;
          if (!this.rafId) {
            this.rafId = requestAnimationFrame(flush);
          }
        }
      };

      this.overlay.addEventListener('pointerdown', (e) => handlePointer(e, 'down'));
      this.overlay.addEventListener('pointermove', (e) => handlePointer(e, 'move'));
      this.overlay.addEventListener('pointerup', (e) => handlePointer(e, 'up'));
      this.overlay.addEventListener('pointercancel', (e) => handlePointer(e, 'cancel'));

      // Wheel / Scroll
      this.overlay.addEventListener('wheel', (e) => {
        e.preventDefault();
        const dc = this.dataChannels.input;
        if (dc && dc.readyState === 'open') {
          dc.send(JSON.stringify({
            v: PROTOCOL_VERSION,
            type: 'scroll',
            seq: this.nextSeq++,
            ts: Date.now(),
            deltaX: e.deltaX,
            deltaY: e.deltaY,
          }));
        }
      }, { passive: false });
    }
  }

  // 4. KeyboardController
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

  // 5. ClipboardController
  class ClipboardController {
    constructor(dataChannels) {
      this.dataChannels = dataChannels;
      this.nextSeq = 1;
      this._init();
    }

    _init() {
      // User-gesture paste
      window.addEventListener('paste', async (e) => {
        let text = '';
        if (e.clipboardData) {
          text = e.clipboardData.getData('text/plain');
        } else if (navigator.clipboard && navigator.clipboard.readText) {
          try { text = await navigator.clipboard.readText(); } catch {}
        }

        if (text) {
          this.sendClipboard(text);
        }
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

  // 6. SessionUI
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
            if (this.statusEl.textContent === text) {
              this.statusEl.style.opacity = '0';
            }
          }, 2000);
        }
      }
    }

    updateDebug(metrics) {
      if (!this.debugPanel) return;
      this.debugPanel.innerHTML = `
        <div><strong>Flutter Remote V2 Diagnostics</strong></div>
        <div>Connection: ${metrics.connectionState}</div>
        <div>ICE State: ${metrics.iceState}</div>
        <div>RTT: ${metrics.rtt} ms</div>
        <div>Video FPS: ${metrics.fps}</div>
        <div>Packet Loss: ${metrics.packetLoss}</div>
        <div>First Frame: ${metrics.firstFrameTime ? metrics.firstFrameTime + 'ms' : 'pending'}</div>
        <div>Reconnects: ${metrics.reconnects}</div>
        <div>Generation: ${metrics.generation}</div>
      `;
    }
  }

  // 7. WebRTCClient & Coordinator
  class FlutterRemoteClient {
    constructor() {
      const urlParams = new URLSearchParams(window.location.search);
      this.sessionId = urlParams.get('session') || 'active';
      this.token = urlParams.get('k') || '';
      this.debugMode = urlParams.get('debug') === '1';

      this.connectionState = new ConnectionState();
      this.peer = null;
      this.signalingWs = null;
      this.dataChannels = {};

      this.metrics = {
        rtt: 0,
        fps: 0,
        packetLoss: 0,
        firstFrameTime: 0,
        reconnects: 0,
        connectionState: 'IDLE',
        iceState: 'new',
        generation: 1,
      };

      const container = document.getElementById('flutter-remote-container') || document.body;
      this.ui = new SessionUI(container, this.debugMode);
      this.videoRenderer = new VideoRenderer(container);
      this.inputController = new InputController(container, this.videoRenderer, this.dataChannels);
      this.keyboardController = new KeyboardController(this.dataChannels);
      this.clipboardController = new ClipboardController(this.dataChannels);

      this.connectionState.onChange((state, gen) => {
        this.metrics.connectionState = state;
        this.metrics.generation = gen;
        if (state === 'CONNECTING') this.ui.setStatus('Connecting to remote simulator...');
        else if (state === 'CONNECTED') this.ui.setStatus('Connected', true);
        else if (state === 'RECONNECTING') this.ui.setStatus(`Reconnecting (Gen ${gen})...`);
      });

      window.addEventListener('resize', () => this._handleResize());
      if (this.debugMode) this._startDebugLoop();

      this._connectSignaling();
    }

    async _connectSignaling() {
      this.connectionState.set('CONNECTING');
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${location.host}/signal?session=${encodeURIComponent(this.sessionId)}&k=${encodeURIComponent(this.token)}`;

      this.signalingWs = new WebSocket(url);

      this.signalingWs.onopen = async () => {
        this.ui.setStatus('Negotiating WebRTC...');
        await this._initPeerConnection();
      };

      this.signalingWs.onmessage = async (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.generation && msg.generation < this.connectionState.generation) {
            return; // Stale generation
          }

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
          console.warn('[flutter-remote signaling message error]', err);
        }
      };

      this.signalingWs.onclose = () => {
        this._scheduleReconnect();
      };
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
          this.connectionState.resetBackoff();
        };

        // Discrete DataChannels
        this.dataChannels.input = this.peer.createDataChannel('input', { ordered: false, maxRetransmits: 0 });
        this.dataChannels.keyboard = this.peer.createDataChannel('keyboard', { ordered: true });
        this.dataChannels.control = this.peer.createDataChannel('control', { ordered: true });
        this.dataChannels.telemetry = this.peer.createDataChannel('telemetry', { ordered: false, maxRetransmits: 0 });

        this.dataChannels.input.onopen = () => {
          this.connectionState.set('CONNECTED');
          this.connectionState.resetBackoff();
        };

        this.peer.onicecandidate = (e) => {
          if (e.candidate && this.signalingWs && this.signalingWs.readyState === WebSocket.OPEN) {
            this.signalingWs.send(JSON.stringify({
              v: PROTOCOL_VERSION,
              type: 'ice-candidate',
              sessionId: this.sessionId,
              generation: this.connectionState.generation,
              payload: e.candidate,
            }));
          }
        };

        this.peer.oniceconnectionstatechange = () => {
          this.metrics.iceState = this.peer.iceConnectionState;
          if (this.peer.iceConnectionState === 'disconnected') {
            // Attempt ICE restart before full tear down
            this._attemptIceRestart();
          } else if (this.peer.iceConnectionState === 'failed') {
            this._scheduleReconnect();
          }
        };
      }

      const offer = await this.peer.createOffer({ offerToReceiveVideo: true, iceRestart: isRestart });
      await this.peer.setLocalDescription(offer);

      this.signalingWs.send(JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'offer',
        sessionId: this.sessionId,
        generation: this.connectionState.generation,
        payload: { sdp: offer.sdp, iceServers },
      }));
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
      this.connectionState.scheduleReconnect(async () => {
        try {
          if (this.signalingWs && this.signalingWs.readyState === WebSocket.OPEN) {
            await this._initPeerConnection(false);
          } else {
            await this._connectSignaling();
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

    _startDebugLoop() {
      setInterval(async () => {
        if (this.peer && typeof this.peer.getStats === 'function') {
          try {
            const stats = await this.peer.getStats();
            stats.forEach((report) => {
              if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                this.metrics.rtt = Math.round((report.currentRoundTripTime || 0) * 1000);
              }
              if (report.type === 'inbound-rtp' && report.kind === 'video') {
                this.metrics.fps = Math.round(report.framesPerSecond || 0);
                this.metrics.packetLoss = report.packetsLost || 0;
              }
            });
          } catch {}
        }
        this.metrics.firstFrameTime = this.videoRenderer.firstFrameTime;
        this.ui.updateDebug(this.metrics);
      }, 1000);
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
