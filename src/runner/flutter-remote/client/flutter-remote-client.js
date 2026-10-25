(function() {
  'use strict';
  if (window.__flutterRemoteV2Initialized) return;
  window.__flutterRemoteV2Initialized = true;

  const PROTOCOL_VERSION = 2;
  const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 10000];

  class ConnectionState {
    constructor() {
      this.state = 'IDLE';
      this.generation = 1;
      this.reconnectAttempt = 0;
      this.reconnectTimer = null;
      this.listeners = new Set();
    }
    set(s) {
      if (this.state === s) return;
      this.state = s;
      for (const fn of this.listeners) { try { fn(this.state, this.generation); } catch {} }
    }
    onChange(fn) { this.listeners.add(fn); }
    advanceGeneration() { return ++this.generation; }
    resetBackoff() {
      this.reconnectAttempt = 0;
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    }
    scheduleReconnect(cb) {
      if (this.reconnectTimer) return;
      this.set('RECONNECTING');
      const delay = BACKOFF_MS[Math.min(this.reconnectAttempt, BACKOFF_MS.length - 1)];
      this.reconnectAttempt++;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.advanceGeneration();
        cb();
      }, delay);
    }
  }

  class VideoRenderer {
    constructor(container, onFirstFrame) {
      this.container = container;
      this.onFirstFrame = onFirstFrame || (() => {});
      this.video = null;
      this.firstFrameTime = 0;
      this.lastFramePresentedTime = 0;
      this.connectTime = Date.now();
      this._rvfcId = null;
      this._init();
    }
    _init() {
      let v = document.getElementById('flutter-remote-video');
      if (!v) {
        v = document.createElement('video');
        v.id = 'flutter-remote-video';
        v.autoplay = true;
        v.playsInline = true;
        v.muted = true;
        v.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;display:block;';
        this.container.appendChild(v);
      }
      this.video = v;

      const resumeVideo = () => {
        if (this.video && this.video.paused && this.video.srcObject) {
          this.video.play().catch(() => {});
        }
      };
      window.addEventListener('pointerdown', resumeVideo, { passive: true });
      window.addEventListener('keydown', resumeVideo, { passive: true });

      this.video.addEventListener('loadeddata', () => {
        this.lastFramePresentedTime = Date.now();
        if (!this.firstFrameTime) {
          this.firstFrameTime = Date.now() - this.connectTime;
          this.onFirstFrame(this.firstFrameTime);
        }
      });
      this.video.addEventListener('timeupdate', () => {
        this.lastFramePresentedTime = Date.now();
      });
    }
    attachStream(s) {
      if (this.video.srcObject === s) return;
      this.connectTime = Date.now();
      this.firstFrameTime = 0;
      this.lastFramePresentedTime = 0;
      this.video.srcObject = s;
      this.video.play().catch((err) => {
        console.warn('[flutter-remote] autoplay blocked or error, awaiting interaction', err);
      });

      const onFrame = () => {
        if (!this.video) return;
        this.lastFramePresentedTime = Date.now();
        if (!this.firstFrameTime) {
          this.firstFrameTime = Date.now() - this.connectTime;
          this.onFirstFrame(this.firstFrameTime);
        }
        if (typeof this.video.requestVideoFrameCallback === 'function') {
          this._rvfcId = this.video.requestVideoFrameCallback(onFrame);
        }
      };
      if (typeof this.video.requestVideoFrameCallback === 'function') {
        this._rvfcId = this.video.requestVideoFrameCallback(onFrame);
      }
    }
    getLastFramePresentedTime() { return this.lastFramePresentedTime; }
    getBounds() { return this.video.getBoundingClientRect(); }
    getVideoResolution() {
      return { width: this.video.videoWidth || 720, height: this.video.videoHeight || 1280 };
    }
  }

  class InputController {
    constructor(container, videoRenderer, dataChannels) {
      this.container = container;
      this.videoRenderer = videoRenderer;
      this.dataChannels = dataChannels;
      this.overlay = null;
      this.nextSeq = 1;
      this.pendingMove = null;
      this.rafId = null;
      this.lastInteractionTime = 0;
      this._init();
    }
    getLastInteractionTime() { return this.lastInteractionTime; }
    _init() {
      let o = document.getElementById('flutter-remote-input-overlay');
      if (!o) {
        o = document.createElement('div');
        o.id = 'flutter-remote-input-overlay';
        o.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;touch-action:none;cursor:pointer;z-index:10;';
        this.container.style.position = 'relative';
        this.container.appendChild(o);
      }
      this.overlay = o;

      const sendPointer = (evt) => {
        const dc = this.dataChannels.input;
        if (dc && dc.readyState === 'open') {
          if (dc.bufferedAmount > 65536 && evt.event === 'move') return;
          dc.send(JSON.stringify(evt));
        }
      };

      const flush = () => {
        if (this.pendingMove) { sendPointer(this.pendingMove); this.pendingMove = null; }
        this.rafId = null;
      };

      const handlePointer = (e, type) => {
        this.lastInteractionTime = Date.now();
        const rect = this.videoRenderer.getBounds();
        const { width: vW, height: vH } = this.videoRenderer.getVideoResolution();
        const containerAspect = rect.width / rect.height;
        const videoAspect = vW / vH;
        let dispW = rect.width, dispH = rect.height, offX = 0, offY = 0;

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
          if (!this.rafId) this.rafId = requestAnimationFrame(flush);
        }
      };

      this.overlay.addEventListener('pointerdown', (e) => handlePointer(e, 'down'));
      this.overlay.addEventListener('pointermove', (e) => handlePointer(e, 'move'));
      this.overlay.addEventListener('pointerup', (e) => handlePointer(e, 'up'));
      this.overlay.addEventListener('pointercancel', (e) => handlePointer(e, 'cancel'));

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

  class KeyboardController {
    constructor(dataChannels) {
      this.dataChannels = dataChannels;
      this.nextSeq = 1;
      this._init();
    }
    _init() {
      const sendKey = (e, evtType) => {
        const dc = this.dataChannels.keyboard;
        if (dc && dc.readyState === 'open') {
          dc.send(JSON.stringify({
            v: PROTOCOL_VERSION,
            type: 'keyboard',
            seq: this.nextSeq++,
            ts: Date.now(),
            event: evtType,
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

  class ClipboardController {
    constructor(dataChannels) {
      this.dataChannels = dataChannels;
      this.nextSeq = 1;
      this._init();
    }
    _init() {
      window.addEventListener('paste', async (e) => {
        let text = '';
        if (e.clipboardData) text = e.clipboardData.getData('text/plain');
        else if (navigator.clipboard && navigator.clipboard.readText) {
          try { text = await navigator.clipboard.readText(); } catch {}
        }
        if (text) {
          const dc = this.dataChannels.control;
          if (dc && dc.readyState === 'open') {
            dc.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'clipboard', seq: this.nextSeq++, ts: Date.now(), text: String(text) }));
          }
        }
      });
    }
  }

  class SessionUI {
    constructor(container, debugMode) {
      this.container = container;
      this.debugMode = debugMode;
      this.statusEl = null;
      this.debugPanel = null;
      this._init();
    }
    _init() {
      let s = document.getElementById('flutter-remote-status');
      if (!s) {
        s = document.createElement('div');
        s.id = 'flutter-remote-status';
        s.style.cssText = 'position:absolute;top:10px;left:50%;transform:translateX(-50%);padding:6px 14px;background:rgba(0,0,0,0.75);color:#fff;border-radius:20px;font:12px sans-serif;z-index:20;transition:opacity 0.3s;pointer-events:none;';
        this.container.appendChild(s);
      }
      this.statusEl = s;

      if (this.debugMode) {
        let p = document.getElementById('flutter-remote-debug-panel');
        if (!p) {
          p = document.createElement('div');
          p.id = 'flutter-remote-debug-panel';
          p.style.cssText = 'position:absolute;bottom:10px;left:10px;padding:10px;background:rgba(0,0,0,0.85);color:#0f0;font:11px monospace;border-radius:6px;z-index:30;pointer-events:none;line-height:1.4;';
          this.container.appendChild(p);
        }
        this.debugPanel = p;
      }
    }
    setStatus(t, autoHide = false) {
      if (!this.statusEl) return;
      this.statusEl.textContent = t;
      this.statusEl.style.opacity = '1';
      if (autoHide) {
        setTimeout(() => { if (this.statusEl.textContent === t) this.statusEl.style.opacity = '0'; }, 2000);
      }
    }
    updateDebug(m) {
      if (!this.debugPanel) return;
      this.debugPanel.innerHTML =
        '<div><strong>Flutter Remote Diagnostics</strong></div>' +
        '<div>State: ' + m.connectionState + '</div>' +
        '<div>ICE State: ' + m.iceState + ' (' + (m.candidateType || 'direct') + ')</div>' +
        '<div>Codec: ' + (m.codec || 'H.264') + ' (' + (m.resolution || '720x1280') + ')</div>' +
        '<div>FPS: ' + m.fps + ' | Bitrate: ' + (m.bitrate || 0) + ' kbps</div>' +
        '<div>RTT: ' + m.rtt + ' ms | Jitter: ' + (m.jitter || 0) + ' ms</div>' +
        '<div>Packet Loss: ' + (m.lossPercentage || '0.00%') + '</div>' +
        '<div>Dropped Frames: ' + (m.framesDropped || 0) + '</div>' +
        '<div>Reconnects: ' + m.reconnects + ' | Gen: ' + m.generation + '</div>';
    }
  }

  class FlutterRemoteClient {
    constructor() {
      const p = new URLSearchParams(window.location.search);
      this.sessionId = p.get('session') || 'active';
      this.token = p.get('k') || '';
      this.debugMode = p.get('debug') === '1';

      this.connectionState = new ConnectionState();
      this.peer = null;
      this.signalingWs = null;
      this.dataChannels = {};

      this.metrics = { rtt: 0, fps: 0, reconnects: 0, connectionState: 'IDLE', iceState: 'new', generation: 1 };

      const c = document.getElementById('flutter-remote-container') || document.body;
      this._videoFrameCheckTimer = null;
      this._lastKeyframeRequestTime = 0;
      this._stallWatchdogTimer = null;
      this.ui = new SessionUI(c, this.debugMode);
      this.videoRenderer = new VideoRenderer(c, () => {
        if (this._videoFrameCheckTimer) {
          clearTimeout(this._videoFrameCheckTimer);
          this._videoFrameCheckTimer = null;
        }
        if (this.ui) this.ui.setStatus('Connected', true);
      });
      this.inputController = new InputController(c, this.videoRenderer, this.dataChannels);
      this.keyboardController = new KeyboardController(this.dataChannels);
      this.clipboardController = new ClipboardController(this.dataChannels);

      this.connectionState.onChange((s, gen) => {
        this.metrics.connectionState = s;
        this.metrics.generation = gen;
        if (s === 'LOADING') this.ui.setStatus('Loading session...');
        else if (s === 'CONNECTING') this.ui.setStatus('Connecting to remote simulator...');
        else if (s === 'CONNECTED') this.ui.setStatus('Connected', true);
        else if (s === 'DEGRADED') this.ui.setStatus('Network Degraded (Adapting Video)');
        else if (s === 'RECONNECTING') this.ui.setStatus('Reconnecting (Gen ' + gen + ')...');
        else if (s === 'DISCONNECTED') this.ui.setStatus('Disconnected from remote runner');
        else if (s === 'EXPIRED') this.ui.setStatus('Session Expired');
        else if (s === 'ERROR') this.ui.setStatus('Connection Error');
      });

      window.addEventListener('resize', () => this._handleResize());
      if (this.debugMode) this._startDebugLoop();

      this._connectSignaling();
    }

    async _connectSignaling() {
      this.connectionState.set('CONNECTING');
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = proto + '//' + location.host + '/signal?session=' + encodeURIComponent(this.sessionId) + '&k=' + encodeURIComponent(this.token);

      this.signalingWs = new WebSocket(url);
      this.signalingWs.onopen = async () => {
        this.ui.setStatus('Negotiating WebRTC...');
        await this._initPeer();
      };

      this.signalingWs.onmessage = async (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.generation && msg.generation < this.connectionState.generation) return;
          if (msg.type === 'answer' && this.peer) {
            const sdp = (msg.payload && msg.payload.sdp) || msg.sdp;
            await this.peer.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
          } else if ((msg.type === 'ice-candidate' || msg.type === 'candidate') && this.peer) {
            const cand = msg.payload || msg.candidate;
            if (cand && cand.candidate) await this.peer.addIceCandidate(new RTCIceCandidate(cand));
          }
        } catch (err) { console.warn('[flutter-remote signaling error]', err); }
      };

      this.signalingWs.onclose = () => this._scheduleReconnect();
    }

    async _initPeer(isRestart = false) {
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

        this.peer.ontrack = (e) => {
          if (e.streams && e.streams[0]) this.videoRenderer.attachStream(e.streams[0]);
          else this.videoRenderer.attachStream(new MediaStream([e.track]));
          this.connectionState.set('CONNECTED');
          this.connectionState.resetBackoff();
          this._startWatchdog();

          if (this._videoFrameCheckTimer) clearTimeout(this._videoFrameCheckTimer);
          this._videoFrameCheckTimer = setTimeout(() => {
            if (this.videoRenderer && !this.videoRenderer.firstFrameTime && this.connectionState.state === 'CONNECTED') {
              if (this.ui) this.ui.setStatus('Connected, waiting for video feed...');
            }
          }, 5000);
        };

        this.dataChannels.input = this.peer.createDataChannel('input', { ordered: false, maxRetransmits: 0 });
        this.dataChannels.keyboard = this.peer.createDataChannel('keyboard', { ordered: true });
        this.dataChannels.control = this.peer.createDataChannel('control', { ordered: true });
        this.dataChannels.telemetry = this.peer.createDataChannel('telemetry', { ordered: false, maxRetransmits: 0 });

        this.dataChannels.input.onopen = () => {
          this.connectionState.set('CONNECTED');
          this.connectionState.resetBackoff();
        };

        this.dataChannels.control.onopen = () => {
          this.requestKeyframe('control_channel_open');
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
          const iceState = this.peer.iceConnectionState;
          this.metrics.iceState = iceState;
          if (iceState === 'connected' || iceState === 'completed') {
            setTimeout(() => {
              if (this.connectionState.state === 'CONNECTED') {
                this.requestKeyframe('ice_connected');
              }
            }, 500);
          } else if (iceState === 'disconnected') {
            this._attemptIceRestart();
          } else if (iceState === 'failed') {
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
      console.log('[flutter-remote] Attempting ICE restart...');
      try { await this._initPeer(true); } catch { this._scheduleReconnect(); }
    }

    _scheduleReconnect() {
      this.metrics.reconnects++;
      this.connectionState.scheduleReconnect(async () => {
        try {
          if (this.signalingWs && this.signalingWs.readyState === WebSocket.OPEN) await this._initPeer(false);
          else await this._connectSignaling();
        } catch { this._scheduleReconnect(); }
      });
    }

    requestKeyframe(reason = 'manual') {
      const now = Date.now();
      if (this._lastKeyframeRequestTime && now - this._lastKeyframeRequestTime < 3000) return false;
      this._lastKeyframeRequestTime = now;
      console.log('[flutter-remote] Requesting keyframe recovery (reason: ' + reason + ')');
      const dc = this.dataChannels.control;
      if (dc && dc.readyState === 'open') {
        dc.send(JSON.stringify({
          v: PROTOCOL_VERSION,
          type: 'request_keyframe',
          reason: reason,
          ts: now,
        }));
        return true;
      }
      return false;
    }

    _startWatchdog() {
      if (this._stallWatchdogTimer) return;
      this._stallWatchdogTimer = setInterval(() => {
        this._checkVideoHealth();
      }, 500);
      this._startHeartbeat();
    }

    _stopWatchdog() {
      if (this._stallWatchdogTimer) {
        clearInterval(this._stallWatchdogTimer);
        this._stallWatchdogTimer = null;
      }
      this._stopHeartbeat();
    }

    _startHeartbeat() {
      if (this._heartbeatTimer) return;
      this._heartbeatTimer = setInterval(() => {
        if (this.connectionState.state === 'CONNECTED') {
          this.requestKeyframe('heartbeat');
        }
      }, 30000);
    }

    _stopHeartbeat() {
      if (this._heartbeatTimer) {
        clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = null;
      }
    }

    _checkVideoHealth() {
      if (this.connectionState.state !== 'CONNECTED' || !this.videoRenderer) return;
      const now = Date.now();
      const lastFrameTime = this.videoRenderer.getLastFramePresentedTime();
      const firstFrameTime = this.videoRenderer.firstFrameTime;

      if (!firstFrameTime) {
        if (now - this.videoRenderer.connectTime > 3000) {
          this.requestKeyframe('initial_track_timeout');
        }
        return;
      }

      if (this.inputController) {
        const lastInteraction = this.inputController.getLastInteractionTime();
        if (lastInteraction > 0 && (now - lastInteraction < 2000)) {
          if (now - lastFrameTime > 1500) {
            this.requestKeyframe('interaction_stall');
            return;
          }
        }
      }

      if (lastFrameTime > 0 && (now - lastFrameTime > 3000)) {
        this.requestKeyframe('video_freeze');
      }
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
      let prevPacketsLost = 0;
      let prevPacketsReceived = 0;
      let prevBytesReceived = 0;
      let prevTimestamp = Date.now();

      setInterval(async () => {
        if (this.peer && typeof this.peer.getStats === 'function') {
          try {
            const stats = await this.peer.getStats();
            const now = Date.now();
            const durationSec = Math.max(0.1, (now - prevTimestamp) / 1000);
            prevTimestamp = now;

            stats.forEach((r) => {
              if (r.type === 'candidate-pair' && (r.state === 'succeeded' || r.nominated || r.selected)) {
                this.metrics.rtt = Math.round((r.currentRoundTripTime || 0) * 1000);
              }
              if (r.type === 'remote-candidate') {
                this.metrics.candidateType = r.candidateType || this.metrics.candidateType;
              }
              if (r.type === 'inbound-rtp' && r.kind === 'video') {
                this.metrics.fps = Math.round(r.framesPerSecond || 0);
                this.metrics.framesDropped = r.framesDropped || 0;
                this.metrics.jitter = Math.round((r.jitter || 0) * 1000);
                this.metrics.codec = (r.codecId || 'H264').includes('VP8') ? 'VP8' : 'H264';

                // Bitrate delta
                const bytesDelta = Math.max(0, (r.bytesReceived || 0) - prevBytesReceived);
                prevBytesReceived = r.bytesReceived || 0;
                this.metrics.bitrate = Math.round((bytesDelta * 8) / (durationSec * 1000));

                // Loss rate delta
                const lostDelta = Math.max(0, (r.packetsLost || 0) - prevPacketsLost);
                const recDelta = Math.max(0, (r.packetsReceived || 0) - prevPacketsReceived);
                prevPacketsLost = r.packetsLost || 0;
                prevPacketsReceived = r.packetsReceived || 0;
                const totalDelta = recDelta + lostDelta;
                const rate = totalDelta > 0 ? (lostDelta / totalDelta) : 0;
                this.metrics.lossRate = rate;
                this.metrics.lossPercentage = (rate * 100).toFixed(2) + '%';
              }
            });

            if (this.videoRenderer) {
              const res = this.videoRenderer.getVideoResolution();
              this.metrics.resolution = res.width + 'x' + res.height;
            }

            // Adaptive quality & degradation check
            const isDegraded = this.metrics.rtt > 200 || this.metrics.lossRate > 0.03 || this.metrics.framesDropped > 5;
            if (isDegraded && this.connectionState.state === 'CONNECTED') {
              this.connectionState.set('DEGRADED');
              const dc = this.dataChannels.control;
              if (dc && dc.readyState === 'open') {
                dc.send(JSON.stringify({
                  v: PROTOCOL_VERSION,
                  type: 'adaptation',
                  rtt: this.metrics.rtt,
                  packetLoss: this.metrics.lossRate,
                  jitter: this.metrics.jitter,
                  fps: this.metrics.fps,
                }));
              }
            } else if (!isDegraded && this.connectionState.state === 'DEGRADED') {
              this.connectionState.set('CONNECTED');
            }
          } catch {}
        }
        this.ui.updateDebug(this.metrics);
      }, 1000);
    }
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    window.__flutterRemoteClient = new FlutterRemoteClient();
  } else {
    window.addEventListener('DOMContentLoaded', () => { window.__flutterRemoteClient = new FlutterRemoteClient(); });
  }
})();
