/**
 * Flutter Remote WebRTC V3 InputController
 *
 * Captures pointer, touch, and wheel/scroll events on an overlay element.
 * Applies:
 *   1. Aspect-ratio letterbox/pillarbox coordinate mapping
 *   2. requestAnimationFrame coalescing for high-frequency pointermove
 *   3. requestAnimationFrame coalescing and delta accumulation for wheel/scroll events
 *   4. Backpressure drop policy for move events when DataChannel buffer is congested
 */

export class InputController {
  constructor(container, videoRenderer, dataChannelManager, options = {}) {
    this.container = container;
    this.videoRenderer = videoRenderer;
    this.dataChannelManager = dataChannelManager;
    this.protocolVersion = options.protocolVersion || 2;
    this.overlay = null;
    this.nextSeq = 1;
    this.lastInteractionTime = 0;

    // Pointer move coalescing
    this.pendingMove = null;
    this.pointerRafId = null;

    // Wheel coalescing
    this.pendingWheelDeltaX = 0;
    this.pendingWheelDeltaY = 0;
    this.wheelRafId = null;

    if (typeof document !== 'undefined') {
      this._initOverlay();
    }
  }

  getLastInteractionTime() {
    return this.lastInteractionTime;
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

    // Pointer event listeners
    this.overlay.addEventListener('pointerdown', (e) => this._handlePointer(e, 'down'));
    this.overlay.addEventListener('pointermove', (e) => this._handlePointer(e, 'move'));
    this.overlay.addEventListener('pointerup', (e) => this._handlePointer(e, 'up'));
    this.overlay.addEventListener('pointercancel', (e) => this._handlePointer(e, 'cancel'));

    // Wheel / Scroll event listener with RAF coalescing
    this.overlay.addEventListener('wheel', (e) => this._handleWheel(e), { passive: false });
  }

  _handlePointer(e, type) {
    this.lastInteractionTime = Date.now();
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
      v: this.protocolVersion,
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
      this._flushPointerMove();
      this.dataChannelManager.sendInput(evt);
    } else if (type === 'up' || type === 'cancel') {
      try { this.overlay.releasePointerCapture(e.pointerId); } catch {}
      this._flushPointerMove();
      this.dataChannelManager.sendInput(evt);
    } else if (type === 'move') {
      this.pendingMove = evt;
      if (!this.pointerRafId) {
        this.pointerRafId = requestAnimationFrame(() => this._flushPointerMove());
      }
    }
  }

  _flushPointerMove() {
    if (this.pointerRafId) {
      cancelAnimationFrame(this.pointerRafId);
      this.pointerRafId = null;
    }
    if (this.pendingMove) {
      this.dataChannelManager.sendInput(this.pendingMove);
      this.pendingMove = null;
    }
  }

  _handleWheel(e) {
    e.preventDefault();
    this.lastInteractionTime = Date.now();

    // Accumulate wheel delta
    this.pendingWheelDeltaX += e.deltaX;
    this.pendingWheelDeltaY += e.deltaY;

    if (!this.wheelRafId) {
      this.wheelRafId = requestAnimationFrame(() => this._flushWheel());
    }
  }

  _flushWheel() {
    if (this.wheelRafId) {
      cancelAnimationFrame(this.wheelRafId);
      this.wheelRafId = null;
    }

    if (this.pendingWheelDeltaX !== 0 || this.pendingWheelDeltaY !== 0) {
      const scrollEvt = {
        v: this.protocolVersion,
        type: 'scroll',
        seq: this.nextSeq++,
        ts: Date.now(),
        deltaX: this.pendingWheelDeltaX,
        deltaY: this.pendingWheelDeltaY,
      };

      this.dataChannelManager.sendInput(scrollEvt);

      // Reset accumulated deltas
      this.pendingWheelDeltaX = 0;
      this.pendingWheelDeltaY = 0;
    }
  }

  destroy() {
    this._flushPointerMove();
    this._flushWheel();
    if (this.overlay && this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay);
      this.overlay = null;
    }
  }
}
