import test from 'node:test';
import assert from 'node:assert/strict';
import { MetricsCollector } from '../src/metrics/MetricsCollector.js';
import { LatencyTracker } from '../src/metrics/LatencyTracker.js';

test('Phase 11: MetricsCollector snapshot and Prometheus formatting', () => {
  const tracker = new LatencyTracker();
  tracker._pendingBySeq.set(1, { t0: 1000, t1: 1030 }); // 30ms transport latency
  tracker.recordSimulatorDispatch(1);

  const collector = new MetricsCollector({ latencyTracker: tracker });
  collector.updateWebRTC({
    rtt: 45,
    fps: 29.5,
    bitrateKbps: 2200,
    packetLoss: 0.01,
    framesDropped: 2,
    reconnectCount: 1,
  });

  const snapshot = collector.getSnapshot();
  assert.equal(snapshot.webrtc.rttMs, 45);
  assert.equal(snapshot.webrtc.fps, 29.5);
  assert.equal(snapshot.webrtc.bitrateKbps, 2200);
  assert.equal(snapshot.webrtc.packetLossPercent, 1.0);
  assert.equal(snapshot.webrtc.framesDropped, 2);
  assert.equal(snapshot.webrtc.reconnectCount, 1);
  assert.equal(snapshot.latency.transport.p50, 30);
  assert.ok(snapshot.system.memoryRssMb > 0);

  const prom = collector.toPrometheusText();
  assert.ok(prom.includes('flutter_remote_rtt_ms 45'));
  assert.ok(prom.includes('flutter_remote_fps 29.5'));
  assert.ok(prom.includes('flutter_remote_bitrate_kbps 2200'));
  assert.ok(prom.includes('flutter_remote_input_latency_p50_ms 30'));
  assert.ok(prom.includes('flutter_remote_reconnect_total 1'));
});
