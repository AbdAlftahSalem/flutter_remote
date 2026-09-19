/**
 * Flutter Remote WebRTC V2 Metrics Collector & Prometheus Exporter
 */

export class MetricsCollector {
  constructor(options = {}) {
    this.latencyTracker = options.latencyTracker || null;
    this.rtt = 0;
    this.fps = 30;
    this.bitrateKbps = 1500;
    this.packetLoss = 0;
    this.framesDropped = 0;
    this.reconnectCount = 0;
    this.activeConnections = 0;
  }

  updateWebRTC({ rtt, fps, bitrateKbps, packetLoss, framesDropped, reconnectCount }) {
    if (rtt !== undefined) this.rtt = rtt;
    if (fps !== undefined) this.fps = fps;
    if (bitrateKbps !== undefined) this.bitrateKbps = bitrateKbps;
    if (packetLoss !== undefined) this.packetLoss = packetLoss;
    if (framesDropped !== undefined) this.framesDropped = framesDropped;
    if (reconnectCount !== undefined) this.reconnectCount = reconnectCount;
  }

  getSnapshot() {
    const mem = process.memoryUsage();
    const latencies = this.latencyTracker ? this.latencyTracker.getMetrics() : {
      transport: { p50: 0, p95: 0, p99: 0 },
      server: { p50: 0, p95: 0, p99: 0 },
      e2e: { p50: 0, p95: 0, p99: 0 },
    };

    return {
      timestamp: Date.now(),
      webrtc: {
        rttMs: this.rtt,
        fps: this.fps,
        bitrateKbps: this.bitrateKbps,
        packetLossPercent: Number((this.packetLoss * 100).toFixed(2)),
        framesDropped: this.framesDropped,
        reconnectCount: this.reconnectCount,
      },
      latency: latencies,
      system: {
        memoryRssMb: Math.round(mem.rss / 1048576),
        heapUsedMb: Math.round(mem.heapUsed / 1048576),
        uptimeSeconds: Math.round(process.uptime()),
      },
    };
  }

  toPrometheusText() {
    const s = this.getSnapshot();
    const lines = [
      '# HELP flutter_remote_rtt_ms Current WebRTC round trip time in ms',
      '# TYPE flutter_remote_rtt_ms gauge',
      `flutter_remote_rtt_ms ${s.webrtc.rttMs}`,
      '',
      '# HELP flutter_remote_fps Video stream frame rate',
      '# TYPE flutter_remote_fps gauge',
      `flutter_remote_fps ${s.webrtc.fps}`,
      '',
      '# HELP flutter_remote_bitrate_kbps Video stream bitrate in kbps',
      '# TYPE flutter_remote_bitrate_kbps gauge',
      `flutter_remote_bitrate_kbps ${s.webrtc.bitrateKbps}`,
      '',
      '# HELP flutter_remote_packet_loss_ratio Video stream packet loss ratio',
      '# TYPE flutter_remote_packet_loss_ratio gauge',
      `flutter_remote_packet_loss_ratio ${this.packetLoss}`,
      '',
      '# HELP flutter_remote_input_latency_p50_ms Input transport P50 latency in ms',
      '# TYPE flutter_remote_input_latency_p50_ms gauge',
      `flutter_remote_input_latency_p50_ms ${s.latency.transport.p50}`,
      '',
      '# HELP flutter_remote_input_latency_p95_ms Input transport P95 latency in ms',
      '# TYPE flutter_remote_input_latency_p95_ms gauge',
      `flutter_remote_input_latency_p95_ms ${s.latency.transport.p95}`,
      '',
      '# HELP flutter_remote_input_latency_p99_ms Input transport P99 latency in ms',
      '# TYPE flutter_remote_input_latency_p99_ms gauge',
      `flutter_remote_input_latency_p99_ms ${s.latency.transport.p99}`,
      '',
      '# HELP flutter_remote_reconnect_total Total WebRTC reconnect attempts',
      '# TYPE flutter_remote_reconnect_total counter',
      `flutter_remote_reconnect_total ${s.webrtc.reconnectCount}`,
      '',
      '# HELP flutter_remote_memory_rss_bytes Resident set size memory in bytes',
      '# TYPE flutter_remote_memory_rss_bytes gauge',
      `flutter_remote_memory_rss_bytes ${process.memoryUsage().rss}`,
      '',
    ];

    return lines.join('\n');
  }
}
