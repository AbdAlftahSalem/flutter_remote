/**
 * Flutter Remote WebRTC V3 WebRTCStatsCollector
 *
 * Collects, normalizes, and samples WebRTC statistics at ~1000ms intervals.
 * Correctly computes packet loss over the latest sampling interval using sample deltas
 * instead of cumulative counts.
 *
 * Prioritizes candidate-pair selection:
 *   1. Selected candidate pair (via transport.selectedCandidatePairId or pair.selected)
 *   2. Active candidate pair (pair.active or pair.nominated && pair.state === 'succeeded')
 *   3. Succeeded candidate pair (pair.state === 'succeeded')
 *   4. null (safe fallback without throwing)
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
        lossRate: 0, // 0.0 to 1.0 (packet loss over the latest sampling interval)
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

  /**
   * Resolves the active/selected candidate pair with graceful fallbacks:
   * 1. Selected candidate pair (transport.selectedCandidatePairId or pair.selected === true)
   * 2. Active candidate pair (pair.active === true or pair.nominated === true && pair.state === 'succeeded')
   * 3. Succeeded candidate pair (pair.state === 'succeeded')
   * 4. null
   */
  getSelectedCandidatePair(stats) {
    if (!stats) return null;

    const reports = [];
    const reportsById = new Map();

    if (typeof stats.forEach === 'function') {
      stats.forEach((report, key) => {
        if (!report) return;
        reports.push(report);
        if (report.id) {
          reportsById.set(report.id, report);
        } else if (key) {
          reportsById.set(key, report);
        }
      });
    } else if (Array.isArray(stats)) {
      for (const report of stats) {
        if (!report) return;
        reports.push(report);
        if (report.id) reportsById.set(report.id, report);
      }
    }

    // 1. Check transport report for selectedCandidatePairId
    for (const report of reports) {
      if (report && report.type === 'transport' && report.selectedCandidatePairId) {
        const pair = reportsById.get(report.selectedCandidatePairId);
        if (pair) return pair;
      }
    }

    // Check if any candidate pair has selected === true
    for (const report of reports) {
      if (report && report.type === 'candidate-pair' && report.selected === true) {
        return report;
      }
    }

    // 2. Check for active/nominated candidate pair
    for (const report of reports) {
      if (report && report.type === 'candidate-pair') {
        if (report.active === true || (report.nominated === true && report.state === 'succeeded')) {
          return report;
        }
      }
    }

    // 3. Fallback to any succeeded candidate pair
    for (const report of reports) {
      if (report && report.type === 'candidate-pair' && report.state === 'succeeded') {
        return report;
      }
    }

    // 4. No candidate pair available
    return null;
  }

  async sample() {
    let rawStats = null;
    try {
      if (this.peerConnectionManager) {
        if (typeof this.peerConnectionManager.getStats === 'function') {
          rawStats = await this.peerConnectionManager.getStats();
        } else if (this.peerConnectionManager.peer && typeof this.peerConnectionManager.peer.getStats === 'function') {
          rawStats = await this.peerConnectionManager.peer.getStats();
        }
      }
    } catch {
      return this.metrics;
    }

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

    // Index reports by id for relation lookups
    const reportsById = new Map();
    const reports = [];
    if (typeof rawStats.forEach === 'function') {
      rawStats.forEach((report, key) => {
        if (!report) return;
        reports.push(report);
        if (report.id) reportsById.set(report.id, report);
        else if (key) reportsById.set(key, report);
      });
    } else if (Array.isArray(rawStats)) {
      for (const report of rawStats) {
        if (!report) continue;
        reports.push(report);
        if (report.id) reportsById.set(report.id, report);
      }
    }

    // Hierarchical candidate pair selection
    const candidatePair = this.getSelectedCandidatePair(rawStats);
    if (candidatePair) {
      rtt = Math.round((candidatePair.currentRoundTripTime || 0) * 1000);
      if (candidatePair.remoteCandidateId) {
        const remoteReport = reportsById.get(candidatePair.remoteCandidateId);
        if (remoteReport && remoteReport.candidateType) {
          candidateType = remoteReport.candidateType;
        }
      }
    }

    // Process reports
    for (const report of reports) {
      // Fallback candidate type if not resolved via candidate-pair relation
      if (candidateType === 'unknown' && report.type === 'remote-candidate') {
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
    }

    // Delta-based packet loss calculation over the latest sampling interval
    let bitrate = 0;
    let lossRate = 0;

    if (this.prevStats.timestamp > 0) {
      const timeDeltaSec = (now - this.prevStats.timestamp) / 1000;
      if (timeDeltaSec > 0) {
        const bytesDelta = Math.max(0, bytesReceived - this.prevStats.bytesReceived);
        bitrate = Math.round((bytesDelta * 8) / (timeDeltaSec * 1000)); // kbps
      }

      const lostDelta = Math.max(0, packetsLost - this.prevStats.packetsLost);
      const receivedDelta = Math.max(0, packetsReceived - this.prevStats.packetsReceived);
      const totalDelta = lostDelta + receivedDelta;

      lossRate = totalDelta > 0 ? (lostDelta / totalDelta) : 0;
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

    const iceState = (this.peerConnectionManager && (this.peerConnectionManager.iceConnectionState || this.peerConnectionManager.iceState)) || 'new';
    const connectionState = (this.peerConnectionManager && this.peerConnectionManager.connectionState) || 'new';

    // Update normalized metrics
    this.metrics = {
      timestamp: now,
      connection: {
        rtt,
        iceState,
        connectionState,
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
