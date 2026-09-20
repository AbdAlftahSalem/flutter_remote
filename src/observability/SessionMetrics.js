/**
 * Flutter Remote WebRTC V3 SessionMetrics
 *
 * Lightweight per-session metrics tracking connection health,
 * media delivery, and input responsiveness.
 */

export class SessionMetrics {
  constructor(sessionId = 'default') {
    this.sessionId = sessionId;
    this.startedAt = Date.now();

    this.connection = {
      reconnects: 0,
      iceRestarts: 0,
    };

    this.media = {
      framesReceived: 0,
      framesDropped: 0,
      packetsSent: 0,
      idrCount: 0,
    };

    this.input = {
      eventsReceived: 0,
      eventsDropped: 0,
    };
  }

  recordReconnect() {
    this.connection.reconnects++;
  }

  recordIceRestart() {
    this.connection.iceRestarts++;
  }

  recordFrameReceived() {
    this.media.framesReceived++;
  }

  recordFrameDropped() {
    this.media.framesDropped++;
  }

  recordPacketsSent(count = 1) {
    this.media.packetsSent += count;
  }

  recordIdr() {
    this.media.idrCount++;
  }

  recordInputReceived() {
    this.input.eventsReceived++;
  }

  recordInputDropped() {
    this.input.eventsDropped++;
  }

  getSnapshot() {
    const elapsedSeconds = Math.max(1, Math.round((Date.now() - this.startedAt) / 1000));
    return {
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      durationSeconds: elapsedSeconds,
      connection: { ...this.connection },
      media: {
        ...this.media,
        dropRate: this.media.framesReceived > 0
          ? Number((this.media.framesDropped / this.media.framesReceived).toFixed(4))
          : 0,
        fpsAverage: Number((this.media.framesReceived / elapsedSeconds).toFixed(1)),
      },
      input: {
        ...this.input,
        dropRate: this.input.eventsReceived > 0
          ? Number((this.input.eventsDropped / this.input.eventsReceived).toFixed(4))
          : 0,
      },
    };
  }

  reset() {
    this.startedAt = Date.now();
    this.connection = { reconnects: 0, iceRestarts: 0 };
    this.media = { framesReceived: 0, framesDropped: 0, packetsSent: 0, idrCount: 0 };
    this.input = { eventsReceived: 0, eventsDropped: 0 };
  }
}
