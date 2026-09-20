/**
 * Flutter Remote WebRTC V3 WebRTCStatsCollector
 *
 * Collects, normalizes, and samples WebRTC statistics at ~1000ms intervals.
 * Correctly computes packet loss rate using sample deltas instead of cumulative counts.
 */

export class WebRTCStatsCollector {
  constructor(peerConnectionManager, { intervalMs = 1000, onMetrics } = {}) {
    this.peerConnectionManager = peerConnectionManager;
    this.intervalMs = intervalMs;
    this.onMetrics = onMetrics || (() => {});
    this.timer = null;

    // Previous sample for delta calculations
    this.prevStats = {
      timestamp: 0,
      bytesReceived: 0,
      packetsReceived: 0,
      packetsLost: 0,
      framesReceived: 0,
      framesDecoded: 0,
    };

    // Current normalized metrics
    this.metrics = {
      timestamp: Date.now(),
      connection: {
        rtt: 0,
        iceState: 'new',
        connectionState: 'new',
        candidateType: 'unknown',
      },
      video: {
        fps: 0,
        bitrate: 0, // kbps
        framesReceived: 0,
        framesDecoded: 0,
        framesDropped: 0,
        jitter: 0, // ms
      },
      packets: {
        received: 0,
        lost: 0,
        lossRate: 0, // 0.0 to 1.0
        lossPercentage: '0.00%',
      },
    };
  }

  start() {
    this.stop();
    this.timer = setInterval(() => {
      this.sample();
    }, this.intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async sample() {
    const rawStats = await this.peerConnectionManager.getStats();
    if (!rawStats) return this.metrics;

    const now = Date.now();
    let rtt = 0;
    let candidateType = 'unknown';
    let fps = 0;
    let bytesReceived = 0;
    let packetsReceived = 0;
    let packetsLost = 0;
    let framesReceived = 0;
    let framesDecoded = 0;
    let framesDropped = 0;
    let jitter = 0;

    rawStats.forEach((report) => {
      // Candidate pair for RTT & candidate type
      if (report.type === 'candidate-pair' && report.state === 'succeeded') {
        rtt = Math.round((report.currentRoundTripTime || 0) * 1000);
      }

      // Local / remote candidates
      if (report.type === 'remote-candidate') {
        candidateType = report.candidateType || candidateType;
      }

      // Inbound video RTP report
      if (report.type === 'inbound-rtp' && report.kind === 'video') {
        fps = Math.round(report.framesPerSecond || 0);
        bytesReceived = report.bytesReceived || 0;
        packetsReceived = report.packetsReceived || 0;
        packetsLost = report.packetsLost || 0;
        framesReceived = report.framesReceived || 0;
        framesDecoded = report.framesDecoded || 0;
        framesDropped = report.framesDropped || 0;
        jitter = Math.round((report.jitter || 0) * 1000);
      }
    });

    // Delta calculations
    let bitrate = 0;
    let lossRate = 0;

    if (this.prevStats.timestamp > 0) {
      const timeDeltaSec = (now - this.prevStats.timestamp) / 1000;
      if (timeDeltaSec > 0) {
        const bytesDelta = Math.max(0, bytesReceived - this.prevStats.bytesReceived);
        bitrate = Math.round((bytesDelta * 8) / (timeDeltaSec * 1000)); // kbps

        // Delta-based packet loss calculation:
        // lostDelta = currentLost - previousLost
        // receivedDelta = currentReceived - previousReceived
        // totalDelta = lostDelta + receivedDelta
        // lossRate = totalDelta > 0 ? lostDelta / totalDelta : 0
        const lostDelta = Math.max(0, packetsLost - this.prevStats.packetsLost);
        const receivedDelta = Math.max(0, packetsReceived - this.prevStats.packetsReceived);
        const totalDelta = lostDelta + receivedDelta;

        lossRate = totalDelta > 0 ? (lostDelta / totalDelta) : 0;
      }
    }

    // Update previous stats
    this.prevStats = {
      timestamp: now,
      bytesReceived,
      packetsReceived,
      packetsLost,
      framesReceived,
      framesDecoded,
    };

    // Update normalized metrics
    this.metrics = {
      timestamp: now,
      connection: {
        rtt,
        iceState: this.peerConnectionManager.iceConnectionState,
        connectionState: this.peerConnectionManager.connectionState,
        candidateType,
      },
      video: {
        fps,
        bitrate,
        framesReceived,
        framesDecoded,
        framesDropped,
        jitter,
      },
      packets: {
        received: packetsReceived,
        lost: packetsLost,
        lossRate,
        lossPercentage: `${(lossRate * 100).toFixed(2)}%`,
      },
    };

    this.onMetrics(this.metrics);
    return this.metrics;
  }
}
