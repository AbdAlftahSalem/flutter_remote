/**
 * Flutter Remote WebRTC V3 ClipboardController
 *
 * Intercepts user-gesture paste events and sends text over the reliable 'control' DataChannel.
 */

export class ClipboardController {
  constructor(dataChannelManager, options = {}) {
    this.dataChannelManager = dataChannelManager;
    this.protocolVersion = options.protocolVersion || 2;
    this.nextSeq = 1;
    this._onPaste = null;
    this._init();
  }

  _init() {
    this._onPaste = async (e) => {
      let text = '';
      if (e.clipboardData) {
        text = e.clipboardData.getData('text/plain');
      } else if (navigator.clipboard && navigator.clipboard.readText) {
        try {
          text = await navigator.clipboard.readText();
        } catch {}
      }

      if (text) {
        this.sendClipboard(text);
      }
    };

    window.addEventListener('paste', this._onPaste);
  }

  sendClipboard(text) {
    this.dataChannelManager.sendControl({
      v: this.protocolVersion,
      type: 'clipboard',
      seq: this.nextSeq++,
      ts: Date.now(),
      text: String(text),
    });
  }

  destroy() {
    if (this._onPaste) {
      window.removeEventListener('paste', this._onPaste);
      this._onPaste = null;
    }
  }
}
