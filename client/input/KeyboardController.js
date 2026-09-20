/**
 * Flutter Remote WebRTC V3 KeyboardController
 *
 * Captures keydown, keyup, and IME composition events.
 * Dispatches discrete, ordered events over the reliable 'keyboard' DataChannel.
 */

export class KeyboardController {
  constructor(dataChannelManager, options = {}) {
    this.dataChannelManager = dataChannelManager;
    this.protocolVersion = options.protocolVersion || 2;
    this.nextSeq = 1;
    this._onKeyDown = null;
    this._onKeyUp = null;
    this._init();
  }

  _init() {
    const sendKey = (e, eventType) => {
      const msg = {
        v: this.protocolVersion,
        type: 'keyboard',
        seq: this.nextSeq++,
        ts: Date.now(),
        event: eventType,
        key: e.key,
        code: e.code,
        isComposing: Boolean(e.isComposing),
      };
      this.dataChannelManager.sendKeyboard(msg);
    };

    this._onKeyDown = (e) => sendKey(e, 'keydown');
    this._onKeyUp = (e) => sendKey(e, 'keyup');

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  }

  destroy() {
    if (this._onKeyDown) {
      window.removeEventListener('keydown', this._onKeyDown);
      this._onKeyDown = null;
    }
    if (this._onKeyUp) {
      window.removeEventListener('keyup', this._onKeyUp);
      this._onKeyUp = null;
    }
  }
}
