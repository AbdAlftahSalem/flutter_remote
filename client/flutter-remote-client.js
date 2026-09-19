/**
 * Flutter Remote WebRTC V2 Browser Client & Direct Input Engine
 *
 * ZERO MONKEY-PATCHING: Communicates directly over WebRTC Media and DataChannels.
 */
(function() {
  'use strict';

  if (window.__flutterRemoteV2Initialized) return;
  window.__flutterRemoteV2Initialized = true;

  const PROTOCOL_VERSION = 2;
  const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 10000];

  class FlutterRemoteClient {
    constructor() {
      this.sessionId = this._getQueryParam('session') || 'active';
      this.token = this._getQueryParam('k') || '';
      this.debugMode = this._getQueryParam('debug') === '1';
      this.generation = 1;
      this.peer = null;
      this.signalingWs = null;
      this.dataChannels = {};
      this.inputCoalescer = null;
      this.reconnectAttempt = 0;
      this.reconnectTimer = null;
      this.lastPongTs = Date.now();
      this.rtt = 0;

      this.metrics = {
        rtt: 0,
        fps: 0,
        bitrate: 0,
        packetLoss: 0,
        inputLatencyP50: 0,
        reconnects: 0,
        connectionState: 'IDLE',
        iceState: 'new',
        candidateType: 'unknown',
      };

      this.elements = {};
      this._initDOM();
      this._initInputEngine();
      this._connectSignaling();
    }

    _getQueryParam(key) {
      return new URLSearchParams(window.location.search).get(key);
    }

    _initDOM() {
      // Container
      const container = document.getElementById('flutter-remote-container') || document.body;

      // Video element
      let video = document.getElementById('flutter-remote-video');
      if (!video) {
        video = document.createElement('video');
        video.id = 'flutter-remote-video';
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        video.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;display:block;';
        container.appendChild(video);
      }
      this.elements.video = video;

      // Input overlay layer
      let overlay = document.getElementById('flutter-remote-input-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'flutter-remote-input-overlay';
        overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;touch-action:none;cursor:pointer;z-index:10;';
        container.style.position = 'relative';
        container.appendChild(overlay);
      }
      this.elements.overlay = overlay;

      // Status banner
      let status = document.getElementById('flutter-remote-status');
      if (!status) {
        status = document.createElement('div');
        status.id = 'flutter-remote-status';
        status.style.cssText = 'position:absolute;top:10px;left:50%;transform:translateX(-50%);padding:6px 14px;background:rgba(0,0,0,0.75);color:#fff;border-radius:20px;font:12px sans-serif;z-index:20;transition:opacity 0.3s;pointer-events:none;';
        container.appendChild(status);
      }
      this.elements.status = status;

      // Debug panel
      if (this.debugMode) {
        const debugPanel = document.createElement('div');
        debugPanel.id = 'flutter-remote-debug-panel';
        debugPanel.style.cssText = 'position:absolute;bottom:10px;left:10px;padding:10px;background:rgba(0,0,0,0.85);color:#0f0;font:11px monospace;border-radius:6px;z-index:30;pointer-events:none;line-height:1.4;';
        container.appendChild(debugPanel);
        this.elements.debugPanel = debugPanel;
        this._startDebugLoop();
      }

      this._updateStatus('Connecting to remote simulator...');
    }

    _updateStatus(text) {
      if (this.elements.status) {
        this.elements.status.textContent = text;
        this.elements.status.style.opacity = '1';
        if (text === 'Connected') {
          setTimeout(() => {
            if (this.elements.status.textContent === 'Connected') {
              this.elements.status.style.opacity = '0';
            }
          }, 2000);
        }
      }
    }

    _initInputEngine() {
      const overlay = this.elements.overlay;
      let nextSeq = 1;

      // Coalescing queue for pointer moves
      let pendingMove = null;
      let rafId = null;

      const sendPointerEvent = (eventData) => {
        const dc = this.dataChannels.input;
        if (dc && dc.readyState === 'open') {
          // Backpressure check: if buffered amount is high, skip move
          if (dc.bufferedAmount > 65536 && eventData.event === 'move') {
            return;
          }
          dc.send(JSON.stringify(eventData));
        }
      };

      const flushMove = () => {
        if (pendingMove) {
          sendPointerEvent(pendingMove);
          pendingMove = null;
        }
        rafId = null;
      };

      // Pointer events
      const handlePointer = (e, type) => {
        const rect = this.elements.video.getBoundingClientRect();
        const clientX = e.clientX;
        const clientY = e.clientY;

        // Calculate aspect-ratio letterboxing
        const videoWidth = this.elements.video.videoWidth || 720;
        const videoHeight = this.elements.video.videoHeight || 1280;
        const containerAspect = rect.width / rect.height;
        const videoAspect = videoWidth / videoHeight;

        let displayedWidth = rect.width;
        let displayedHeight = rect.height;
        let offsetX = 0;
        let offsetY = 0;

        if (containerAspect > videoAspect) {
          displayedWidth = rect.height * videoAspect;
          offsetX = (rect.width - displayedWidth) / 2;
        } else {
          displayedHeight = rect.width / videoAspect;
          offsetY = (rect.height - displayedHeight) / 2;
        }

        const rawX = clientX - rect.left - offsetX;
        const rawY = clientY - rect.top - offsetY;

        const normX = Math.max(0, Math.min(1, rawX / displayedWidth));
        const normY = Math.max(0, Math.min(1, rawY / displayedHeight));

        const eventData = {
          v: PROTOCOL_VERSION,
          type: 'pointer',
          seq: nextSeq++,
          ts: Date.now(), // t0 client capture timestamp
          event: type,
          pointerId: e.pointerId || 1,
          x: Number(normX.toFixed(5)),
          y: Number(normY.toFixed(5)),
          button: e.button || 0,
          buttons: e.buttons !== undefined ? e.buttons : 1,
        };

        if (type === 'down') {
          try { overlay.setPointerCapture(e.pointerId); } catch {}
          if (rafId) { cancelAnimationFrame(rafId); flushMove(); }
          sendPointerEvent(eventData);
        } else if (type === 'up' || type === 'cancel') {
          try { overlay.releasePointerCapture(e.pointerId); } catch {}
          if (rafId) { cancelAnimationFrame(rafId); flushMove(); }
          sendPointerEvent(eventData);
        } else if (type === 'move') {
          pendingMove = eventData;
          if (!rafId) {
            rafId = requestAnimationFrame(flushMove);
          }
        }
      };

      overlay.addEventListener('pointerdown', (e) => handlePointer(e, 'down'));
      overlay.addEventListener('pointermove', (e) => handlePointer(e, 'move'));
      overlay.addEventListener('pointerup', (e) => handlePointer(e, 'up'));
      overlay.addEventListener('pointercancel', (e) => handlePointer(e, 'cancel'));

      // Keyboard & text input
      window.addEventListener('keydown', (e) => {
        const dc = this.dataChannels.keyboard;
        if (dc && dc.readyState === 'open') {
          dc.send(JSON.stringify({
            v: PROTOCOL_VERSION,
            type: 'keyboard',
            seq: nextSeq++,
            ts: Date.now(),
            event: 'keydown',
            key: e.key,
            code: e.code,
          }));
        }
      });

      window.addEventListener('keyup', (e) => {
        const dc = this.dataChannels.keyboard;
        if (dc && dc.readyState === 'open') {
          dc.send(JSON.stringify({
            v: PROTOCOL_VERSION,
            type: 'keyboard',
            seq: nextSeq++,
            ts: Date.now(),
            event: 'keyup',
            key: e.key,
            code: e.code,
          }));
        }
      });

      // Scroll / Wheel
      overlay.addEventListener('wheel', (e) => {
        e.preventDefault();
        const dc = this.dataChannels.input;
        if (dc && dc.readyState === 'open') {
          dc.send(JSON.stringify({
            v: PROTOCOL_VERSION,
            type: 'scroll',
            seq: nextSeq++,
            ts: Date.now(),
            deltaX: e.deltaX,
            deltaY: e.deltaY,
          }));
        }
      }, { passive: false });
    }

    async _connectSignaling() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${location.host}/signal?session=${encodeURIComponent(this.sessionId)}&k=${encodeURIComponent(this.token)}`;

      this.signalingWs = new WebSocket(url);

      this.signalingWs.onopen = async () => {
        this._updateStatus('Establishing secure WebRTC connection...');
        await this._initPeerConnection();
      };

      this.signalingWs.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.generation && msg.generation < this.generation) {
            return; // Ignore stale generation
          }

          if (msg.type === 'answer' && this.peer) {
            await this.peer.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.payload.sdp }));
          } else if (msg.type === 'ice-candidate' && this.peer && msg.payload.candidate) {
            await this.peer.addIceCandidate(new RTCIceCandidate(msg.payload));
          } else if (msg.type === 'pong') {
            this.lastPongTs = Date.now();
            if (msg.payload && msg.payload.clientTs) {
              this.rtt = Date.now() - msg.payload.clientTs;
              this.metrics.rtt = this.rtt;
            }
          }
        } catch (err) {
          console.warn('[flutter-remote signaling message error]', err);
        }
      };

      this.signalingWs.onclose = () => {
        this._scheduleReconnect('Signaling connection lost');
      };
    }

    async _initPeerConnection() {
      if (this.peer) {
        try { this.peer.close(); } catch {}
        this.peer = null;
      }

      // Fetch ICE config
      let iceServers = [{ urls: 'stun:stun.cloudflare.com:3478' }];
      try {
        const res = await fetch('/ice-config');
        const data = await res.json();
        if (data && data.iceServers) iceServers = data.iceServers;
      } catch {}

      this.peer = new RTCPeerConnection({ iceServers });

      // Video track receiver
      this.peer.ontrack = (event) => {
        if (event.streams && event.streams[0]) {
          this.elements.video.srcObject = event.streams[0];
        } else {
          const stream = new MediaStream([event.track]);
          this.elements.video.srcObject = stream;
        }
        this._updateStatus('Connected');
      };

      // Create DataChannels
      const inputDc = this.peer.createDataChannel('input', { ordered: false, maxRetransmits: 0 });
      const keyboardDc = this.peer.createDataChannel('keyboard', { ordered: true });
      const controlDc = this.peer.createDataChannel('control', { ordered: true });
      const telemetryDc = this.peer.createDataChannel('telemetry', { ordered: false, maxRetransmits: 0 });

      this.dataChannels = { input: inputDc, keyboard: keyboardDc, control: controlDc, telemetry: telemetryDc };

      inputDc.onopen = () => {
        this._updateStatus('Connected');
        this.metrics.connectionState = 'CONNECTED';
        this.reconnectAttempt = 0;
      };

      this.peer.onicecandidate = (e) => {
        if (e.candidate && this.signalingWs && this.signalingWs.readyState === WebSocket.OPEN) {
          this.signalingWs.send(JSON.stringify({
            v: PROTOCOL_VERSION,
            type: 'ice-candidate',
            sessionId: this.sessionId,
            generation: this.generation,
            payload: e.candidate,
          }));
        }
      };

      this.peer.oniceconnectionstatechange = () => {
        this.metrics.iceState = this.peer.iceConnectionState;
        if (this.peer.iceConnectionState === 'failed' || this.peer.iceConnectionState === 'disconnected') {
          this._scheduleReconnect('ICE state failed');
        }
      };

      // Create offer
      const offer = await this.peer.createOffer({ offerToReceiveVideo: true });
      await this.peer.setLocalDescription(offer);

      this.signalingWs.send(JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'offer',
        sessionId: this.sessionId,
        generation: this.generation,
        payload: { sdp: offer.sdp, iceServers },
      }));
    }

    _scheduleReconnect(reason) {
      if (this.reconnectTimer) return;

      this.metrics.reconnects++;
      this.metrics.connectionState = 'RECONNECTING';
      const delay = BACKOFF_MS[Math.min(this.reconnectAttempt, BACKOFF_MS.length - 1)];
      this.reconnectAttempt++;

      this._updateStatus(`Connection lost. Reconnecting... (Attempt ${this.reconnectAttempt})`);

      this.reconnectTimer = setTimeout(async () => {
        this.reconnectTimer = null;
        this.generation++;
        try {
          if (this.signalingWs && this.signalingWs.readyState === WebSocket.OPEN) {
            await this._initPeerConnection();
          } else {
            await this._connectSignaling();
          }
        } catch {
          this._scheduleReconnect('Retry after failed reconnect');
        }
      }, delay);
    }

    _startDebugLoop() {
      setInterval(async () => {
        if (!this.elements.debugPanel) return;

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

        this.elements.debugPanel.innerHTML = `
          <div><strong>Flutter Remote Debug Diagnostics</strong></div>
          <div>Connection: ${this.metrics.connectionState}</div>
          <div>ICE: ${this.metrics.iceState}</div>
          <div>RTT: ${this.metrics.rtt} ms</div>
          <div>Video FPS: ${this.metrics.fps}</div>
          <div>Packet Loss: ${this.metrics.packetLoss}</div>
          <div>Reconnects: ${this.metrics.reconnects}</div>
          <div>Generation: ${this.generation}</div>
        `;
      }, 1000);
    }
  }

  // Auto-bootstrap client on window load
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    window.__flutterRemoteClient = new FlutterRemoteClient();
  } else {
    window.addEventListener('DOMContentLoaded', () => {
      window.__flutterRemoteClient = new FlutterRemoteClient();
    });
  }
})();
