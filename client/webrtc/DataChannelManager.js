/**
 * Flutter Remote WebRTC V3 DataChannelManager
 *
 * Owns discrete WebRTC DataChannels:
 *   - input: unreliable & unordered ({ ordered: false, maxRetransmits: 0 })
 *   - keyboard: reliable & ordered ({ ordered: true })
 *   - control: reliable & ordered ({ ordered: true })
 *   - telemetry: unreliable & unordered ({ ordered: false, maxRetransmits: 0 })
 */

export const DATA_CHANNEL_SPECS = {
  input: { ordered: false, maxRetransmits: 0 },
  keyboard: { ordered: true },
  control: { ordered: true },
  telemetry: { ordered: false, maxRetransmits: 0 },
};

export class DataChannelManager {
  constructor(peerConnectionManager, { onOpen, onClose, onMessage } = {}) {
    this.peerConnectionManager = peerConnectionManager;
    this.onOpen = onOpen || (() => {});
    this.onClose = onClose || (() => {});
    this.onMessage = onMessage || (() => {});
    this.channels = {};
  }

  setupChannels() {
    this.close();

    for (const [name, config] of Object.entries(DATA_CHANNEL_SPECS)) {
      const dc = this.peerConnectionManager.createDataChannel(name, config);
      this.channels[name] = dc;

      dc.onopen = () => {
        this.onOpen(name, dc);
      };

      dc.onclose = () => {
        this.onClose(name, dc);
      };

      dc.onmessage = (event) => {
        this.onMessage(name, event.data);
      };
    }

    return this.channels;
  }

  getChannel(name) {
    return this.channels[name] || null;
  }

  isOpen(name) {
    const dc = this.channels[name];
    return Boolean(dc && dc.readyState === 'open');
  }

  getBufferedAmount(name) {
    const dc = this.channels[name];
    return dc ? dc.bufferedAmount : 0;
  }

  send(name, message) {
    const dc = this.channels[name];
    if (dc && dc.readyState === 'open') {
      const payload = typeof message === 'string' ? message : JSON.stringify(message);
      dc.send(payload);
      return true;
    }
    return false;
  }

  sendInput(message, backpressureThreshold = 65536) {
    const dc = this.channels.input;
    if (dc && dc.readyState === 'open') {
      if (dc.bufferedAmount > backpressureThreshold && message.event === 'move') {
        return false; // Drop move under backpressure
      }
      const payload = typeof message === 'string' ? message : JSON.stringify(message);
      dc.send(payload);
      return true;
    }
    return false;
  }

  sendKeyboard(message) {
    return this.send('keyboard', message);
  }

  sendControl(message) {
    return this.send('control', message);
  }

  sendTelemetry(message) {
    return this.send('telemetry', message);
  }

  close() {
    for (const [name, dc] of Object.entries(this.channels)) {
      if (dc) {
        dc.onopen = null;
        dc.onclose = null;
        dc.onmessage = null;
        try {
          dc.close();
        } catch {}
      }
    }
    this.channels = {};
  }
}
