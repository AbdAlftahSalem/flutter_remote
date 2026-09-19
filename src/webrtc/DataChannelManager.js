/**
 * Flutter Remote WebRTC V2 DataChannel Manager with Backpressure Control
 */

import { EventEmitter } from 'node:events';
import { CHANNELS, CHANNEL_CONFIGS, LIMITS } from '../shared/constants.js';
import { logger } from '../shared/logger.js';

export class DataChannelManager extends EventEmitter {
  constructor(peerConnectionWrapper, options = {}) {
    super();
    this.peer = peerConnectionWrapper;
    this.channels = new Map(); // name -> DataChannel
    this.bufferedAmountThreshold = options.bufferedAmountThreshold || LIMITS.BUFFERED_AMOUNT_LOW_THRESHOLD;
    this.droppedInputEvents = 0;
    this.totalInputEvents = 0;
  }

  setupDefaultChannels() {
    for (const name of Object.values(CHANNELS)) {
      const config = CHANNEL_CONFIGS[name];
      const dc = this.peer.createDataChannel(name, config);
      this.attachChannel(name, dc);
    }
  }

  attachChannel(name, dc) {
    this.channels.set(name, dc);

    if (typeof dc.setBufferedAmountLowThreshold === 'function') {
      dc.setBufferedAmountLowThreshold(this.bufferedAmountThreshold);
    }

    if (typeof dc.onBufferedAmountLow === 'function') {
      dc.onBufferedAmountLow(() => {
        this.emit('buffered_amount_low', { name });
      });
    }

    if (typeof dc.onMessage === 'function') {
      dc.onMessage((rawMsg) => {
        this._handleIncomingMessage(name, rawMsg);
      });
    }

    logger.debug('datachannel.attached', { name, sessionId: this.peer.sessionId });
  }

  _handleIncomingMessage(channelName, rawMsg) {
    try {
      const text = rawMsg.toString();
      const parsed = JSON.parse(text);
      this.emit('message', { channel: channelName, data: parsed, raw: text });
      this.emit(channelName, parsed);
    } catch (err) {
      // If binary or non-JSON, emit as raw
      this.emit('message', { channel: channelName, data: rawMsg, raw: rawMsg });
      this.emit(channelName, rawMsg);
    }
  }

  sendInput(event) {
    const dc = this.channels.get(CHANNELS.INPUT);
    if (!dc) return false;

    this.totalInputEvents++;

    // Backpressure check: if buffer is congested and this is a pointermove, DROP it
    const buffered = typeof dc.bufferedAmount === 'function' ? dc.bufferedAmount() : (dc.bufferedAmount || 0);
    if (buffered > this.bufferedAmountThreshold && event.event === 'move') {
      this.droppedInputEvents++;
      logger.debug('datachannel.input_backpressure_drop', {
        buffered,
        threshold: this.bufferedAmountThreshold,
        totalDropped: this.droppedInputEvents,
      });
      return false;
    }

    const payload = typeof event === 'string' ? event : JSON.stringify(event);
    return this._sendDirect(dc, payload);
  }

  sendKeyboard(event) {
    const dc = this.channels.get(CHANNELS.KEYBOARD);
    if (!dc) return false;
    // Keyboard events are NEVER dropped for backpressure (must preserve typing/IME integrity)
    const payload = typeof event === 'string' ? event : JSON.stringify(event);
    return this._sendDirect(dc, payload);
  }

  sendControl(command) {
    const dc = this.channels.get(CHANNELS.CONTROL);
    if (!dc) return false;
    const payload = typeof command === 'string' ? command : JSON.stringify(command);
    return this._sendDirect(dc, payload);
  }

  sendTelemetry(data) {
    const dc = this.channels.get(CHANNELS.TELEMETRY);
    if (!dc) return false;
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    return this._sendDirect(dc, payload);
  }

  _sendDirect(dc, payload) {
    try {
      if (typeof dc.sendMessage === 'function') {
        dc.sendMessage(payload);
        return true;
      }
      if (typeof dc.send === 'function') {
        dc.send(payload);
        return true;
      }
    } catch (err) {
      logger.warn('datachannel.send_error', { error: err.message });
    }
    return false;
  }

  getChannel(name) {
    return this.channels.get(name) || null;
  }

  isChannelOpen(name) {
    const dc = this.getChannel(name);
    if (!dc) return false;
    if (typeof dc.isOpen === 'function') return dc.isOpen();
    return dc.readyState === 'open';
  }
}
