/**
 * Flutter Remote WebRTC V2 Input Protocol
 */

import { PROTOCOL_VERSION } from '../shared/constants.js';
import { SessionError } from '../shared/errors.js';

let nextSeq = 1;

export class InputProtocol {
  static createPointerEvent({
    event, // 'down' | 'move' | 'up' | 'cancel'
    pointerId = 1,
    x, // normalized 0.0 - 1.0
    y, // normalized 0.0 - 1.0
    button = 0,
    buttons = 1,
    ts = Date.now(),
    seq = nextSeq++,
  }) {
    if (x === undefined || y === undefined) {
      throw new SessionError('Pointer event requires normalized x and y coordinates');
    }
    if (typeof x !== 'number' || x < 0 || x > 1) {
      throw new SessionError(`Normalized x must be between 0.0 and 1.0, got ${x}`);
    }
    if (typeof y !== 'number' || y < 0 || y > 1) {
      throw new SessionError(`Normalized y must be between 0.0 and 1.0, got ${y}`);
    }

    return {
      v: PROTOCOL_VERSION,
      type: 'pointer',
      seq,
      ts, // t0: client capture timestamp
      event,
      pointerId,
      x: Number(x.toFixed(5)),
      y: Number(y.toFixed(5)),
      button,
      buttons,
    };
  }

  static createKeyboardEvent({
    event, // 'keydown' | 'keyup' | 'input' | 'compositionstart' | 'compositionupdate' | 'compositionend'
    key = '',
    code = '',
    text = '',
    isComposing = false,
    ts = Date.now(),
    seq = nextSeq++,
  }) {
    return {
      v: PROTOCOL_VERSION,
      type: 'keyboard',
      seq,
      ts, // t0: client capture timestamp
      event,
      key,
      code,
      text,
      isComposing,
    };
  }

  static createScrollEvent({
    deltaX = 0,
    deltaY = 0,
    x = 0.5,
    y = 0.5,
    ts = Date.now(),
    seq = nextSeq++,
  }) {
    return {
      v: PROTOCOL_VERSION,
      type: 'scroll',
      seq,
      ts, // t0: client capture timestamp
      deltaX,
      deltaY,
      x,
      y,
    };
  }

  static createClipboardEvent({
    text = '',
    ts = Date.now(),
    seq = nextSeq++,
  }) {
    return {
      v: PROTOCOL_VERSION,
      type: 'clipboard',
      seq,
      ts,
      text,
    };
  }
}
