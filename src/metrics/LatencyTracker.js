/**
 * Flutter Remote WebRTC V2 Latency Tracker
 *
 * Tracks per-stage timestamps:
 *   t0: Client input capture timestamp
 *   t1: Server DataChannel receive timestamp
 *   t2: Simulator dispatch timestamp
 *   t3: Visual frame response timestamp
 *
 * Computes real-time windowed P50, P95, and P99 percentiles for:
 *   - Transport latency: t1 - t0
 *   - Server dispatch latency: t2 - t1
 *   - End-to-end visual latency: t3 - t0
 */

function calculatePercentile(sortedValues, percentile) {
  if (sortedValues.length === 0) return 0;
  const index = Math.ceil((percentile / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
}

export class LatencyTracker {
  constructor(options = {}) {
    this.maxSamples = options.maxSamples || 500;
    this._pendingBySeq = new Map(); // seq -> { t0, t1, t2 }

    this._transportSamples = [];
    this._serverSamples = [];
    this._e2eSamples = [];
  }

  recordServerReceive(seq, t0) {
    const t1 = Date.now();
    this._pendingBySeq.set(seq, { t0, t1 });
    return t1;
  }

  recordSimulatorDispatch(seq) {
    const t2 = Date.now();
    const entry = this._pendingBySeq.get(seq);
    if (entry) {
      entry.t2 = t2;
      const transportDelta = Math.max(0, entry.t1 - entry.t0);
      const serverDelta = Math.max(0, t2 - entry.t1);

      this._pushSample(this._transportSamples, transportDelta);
      this._pushSample(this._serverSamples, serverDelta);
    }
    return t2;
  }

  recordFrameResponse(seq = null) {
    const t3 = Date.now();
    if (seq !== null && this._pendingBySeq.has(seq)) {
      const entry = this._pendingBySeq.get(seq);
      const e2eDelta = Math.max(0, t3 - entry.t0);
      this._pushSample(this._e2eSamples, e2eDelta);
      this._pendingBySeq.delete(seq);
    } else if (this._pendingBySeq.size > 0) {
      // Attribute to oldest pending input event
      const oldestSeq = this._pendingBySeq.keys().next().value;
      const entry = this._pendingBySeq.get(oldestSeq);
      const e2eDelta = Math.max(0, t3 - entry.t0);
      this._pushSample(this._e2eSamples, e2eDelta);
      this._pendingBySeq.delete(oldestSeq);
    }
    return t3;
  }

  _pushSample(array, value) {
    array.push(value);
    if (array.length > this.maxSamples) {
      array.shift();
    }
  }

  _getPercentiles(samples) {
    if (samples.length === 0) {
      return { p50: 0, p95: 0, p99: 0, count: 0 };
    }
    const sorted = [...samples].sort((a, b) => a - b);
    return {
      p50: calculatePercentile(sorted, 50),
      p95: calculatePercentile(sorted, 95),
      p99: calculatePercentile(sorted, 99),
      count: samples.length,
    };
  }

  getMetrics() {
    return {
      transport: this._getPercentiles(this._transportSamples),
      server: this._getPercentiles(this._serverSamples),
      e2e: this._getPercentiles(this._e2eSamples),
      pendingCount: this._pendingBySeq.size,
    };
  }

  clear() {
    this._pendingBySeq.clear();
    this._transportSamples = [];
    this._serverSamples = [];
    this._e2eSamples = [];
  }
}
