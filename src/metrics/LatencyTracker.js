/**
 * Flutter Remote WebRTC V2 Latency Tracker
 *
 * Measures the complete input path:
 *   T0 = Browser event capture
 *   T1 = Browser DataChannel send
 *   T2 = Server DataChannel receive
 *   T3 = InputRouter dispatch
 *   T4 = ServeSimAdapter send
 *   T5 = Simulator event / visual response
 *
 * Calculates:
 *   - Transport / Browser -> Server latency: T1 - T0 (or T2 - T0)
 *   - Server dispatch / processing latency: T3 - T1 (or T3 - T2)
 *   - End-to-end input latency: T5 - T0
 *
 * Reports windowed P50, P95, and P99 percentiles.
 */

function calculatePercentile(sortedValues, percentile) {
  if (sortedValues.length === 0) return 0;
  const index = Math.ceil((percentile / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
}

export class LatencyTracker {
  constructor(options = {}) {
    this.maxSamples = options.maxSamples || 500;
    this._pendingBySeq = new Map(); // seq -> { t0, t1, t2, t3, t4 }

    this._transportSamples = [];
    this._serverSamples = [];
    this._e2eSamples = [];
    this._totalInputSamples = [];
  }

  recordServerReceive(seq, t0, t1 = null) {
    const t2 = Date.now();
    this._pendingBySeq.set(seq, { t0, t1: t1 || t2, t2 });
    this._pruneStalePending();
    return t2;
  }

  recordSimulatorDispatch(seq) {
    const t3 = Date.now();
    const entry = this._pendingBySeq.get(seq);
    if (entry) {
      entry.t3 = t3;
      entry.t4 = t3;
      const transportDelta = Math.max(0, (entry.t1 !== undefined ? entry.t1 : t3) - entry.t0);
      const serverDelta = Math.max(0, t3 - (entry.t1 !== undefined ? entry.t1 : entry.t0));

      this._pushSample(this._transportSamples, transportDelta);
      this._pushSample(this._serverSamples, serverDelta);
    }
    return t3;
  }

  recordSimulatorResponse(seq = null) {
    const t5 = Date.now();
    let entry = null;
    let targetSeq = seq;

    if (seq !== null && this._pendingBySeq.has(seq)) {
      entry = this._pendingBySeq.get(seq);
      this._pendingBySeq.delete(seq);
    } else if (this._pendingBySeq.size > 0) {
      targetSeq = this._pendingBySeq.keys().next().value;
      entry = this._pendingBySeq.get(targetSeq);
      this._pendingBySeq.delete(targetSeq);
    }

    if (entry) {
      const totalDelta = Math.max(0, t5 - entry.t0);
      this._pushSample(this._totalInputSamples, totalDelta);
      this._pushSample(this._e2eSamples, totalDelta);
    }
    return t5;
  }

  recordFrameResponse(seq = null) {
    return this.recordSimulatorResponse(seq);
  }

  _pruneStalePending() {
    if (this._pendingBySeq.size > 1000) {
      const now = Date.now();
      for (const [s, entry] of this._pendingBySeq) {
        if (now - (entry.t2 || entry.t0) > 10000) {
          this._pendingBySeq.delete(s);
        }
      }
    }
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
    const transport = this._getPercentiles(this._transportSamples);
    const server = this._getPercentiles(this._serverSamples);
    const e2e = this._getPercentiles(this._e2eSamples);
    const totalInput = this._getPercentiles(this._totalInputSamples);

    return {
      transport,
      server,
      e2e,
      browserToServer: transport,
      serverProcessing: server,
      totalInput,
      pendingCount: this._pendingBySeq.size,
    };
  }

  clear() {
    this._pendingBySeq.clear();
    this._transportSamples = [];
    this._serverSamples = [];
    this._e2eSamples = [];
    this._totalInputSamples = [];
  }
}
