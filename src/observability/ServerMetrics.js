/**
 * Flutter Remote WebRTC V3 ServerMetrics
 *
 * Tracks server-wide health and performance:
 *   - Encoder: FPS, latency, encoded frames, restarts
 *   - Frame pipeline: received, dropped, queue depth
 *   - RTP: packets sent, frames packetized, IDR frames
 *   - WebRTC: sessions, reconnects, ICE restarts
 *   - System: CPU, memory, uptime
 */

export class ServerMetrics {
  constructor() {
    this.startedAt = Date.now();
    this.sessions = 0;
    this.connectedSessions = 0;
    this.reconnects = 0;
    this.iceRestarts = 0;

    this.encoder = {
      encoderFps: 0,
      encodeLatency: 0,
      encodedFrames: 0,
      encoderRestarts: 0,
    };

    this.framePipeline = {
      framesReceived: 0,
      framesDropped: 0,
      queueDepth: 0,
      maxQueueDepth: 2,
    };

    this.rtp = {
      packetsSent: 0,
      framesPacketized: 0,
      idrFrames: 0,
      spsPpsFrames: 0,
    };
  }

  updateEncoder({ fps, latencyMs, encodedFrames, restarts }) {
    if (fps !== undefined) this.encoder.encoderFps = fps;
    if (latencyMs !== undefined) this.encoder.encodeLatency = latencyMs;
    if (encodedFrames !== undefined) this.encoder.encodedFrames = encodedFrames;
    if (restarts !== undefined) this.encoder.encoderRestarts = restarts;
  }

  updateFramePipeline({ received, dropped, queueDepth, maxQueueDepth }) {
    if (received !== undefined) this.framePipeline.framesReceived = received;
    if (dropped !== undefined) this.framePipeline.framesDropped = dropped;
    if (queueDepth !== undefined) this.framePipeline.queueDepth = queueDepth;
    if (maxQueueDepth !== undefined) this.framePipeline.maxQueueDepth = maxQueueDepth;
  }

  updateRtp({ packetsSent, framesPacketized, idrFrames, spsPpsFrames }) {
    if (packetsSent !== undefined) this.rtp.packetsSent = packetsSent;
    if (framesPacketized !== undefined) this.rtp.framesPacketized = framesPacketized;
    if (idrFrames !== undefined) this.rtp.idrFrames = idrFrames;
    if (spsPpsFrames !== undefined) this.rtp.spsPpsFrames = spsPpsFrames;
  }

  getSnapshot() {
    const mem = process.memoryUsage();
    return {
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      sessions: {
        total: this.sessions,
        active: this.connectedSessions,
        reconnects: this.reconnects,
        iceRestarts: this.iceRestarts,
      },
      encoder: { ...this.encoder },
      framePipeline: { ...this.framePipeline },
      rtp: { ...this.rtp },
      system: {
        memoryRssMb: Math.round(mem.rss / 1048576),
        heapUsedMb: Math.round(mem.heapUsed / 1048576),
      },
    };
  }
}
