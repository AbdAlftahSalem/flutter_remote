/**
 * Flutter Remote WebRTC V3 SessionUI
 *
 * Renders status pill notifications (connecting, connected, reconnecting).
 */

export class SessionUI {
  constructor(container) {
    this.container = container;
    this.statusEl = null;
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

  destroy() {
    if (this.statusEl && this.statusEl.parentNode) {
      this.statusEl.parentNode.removeChild(this.statusEl);
      this.statusEl = null;
    }
  }
}
