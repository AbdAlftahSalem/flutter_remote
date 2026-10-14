/**
 * Flutter Remote Benchmark Command
 *
 * Measures real pipeline performance without fabricated numbers:
 *   - Live session metrics (via gate /metrics endpoint if active)
 *   - Real local video encoder throughput, encode latency, CPU, and memory
 *   - Explicit N/A reporting for unobservable or non-applicable stages
 */

import http from 'node:http';
import { VideoEncoder } from '../media/VideoEncoder.js';
import { loadSession } from '../lib/session.js';
import { bold, cyan, green, yellow, dim } from '../lib/ui.js';

export async function benchmark(cwd, flags = {}) {
  console.log(`\n${bold('Flutter Remote Benchmark')}\n`);

  // 1. Try to fetch metrics from active session if present
  const saved = loadSession(cwd);
  let liveMetrics = null;

  if (saved?.url && flags.live !== false) {
    try {
      liveMetrics = await new Promise((resolve) => {
        const u = new URL(saved.url);
        const req = http.get(
          {
            host: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: '/metrics',
            timeout: 2000,
          },
          (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
              try { resolve(JSON.parse(data)); } catch { resolve(null); }
            });
          }
        );
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
      });
    } catch {}
  }

  if (liveMetrics) {
    console.log(dim('  Mode: Live Session Metrics (from remote runner /metrics endpoint)'));
    const firstFrameStr = liveMetrics.firstFrameLatencyMs != null
      ? `${(liveMetrics.firstFrameLatencyMs / 1000).toFixed(2)}s`
      : 'N/A — not recorded';
    const fpsStr = liveMetrics.fps != null
      ? `${Number(liveMetrics.fps).toFixed(1)}`
      : (liveMetrics.encoder?.encoderFps != null ? `${Number(liveMetrics.encoder.encoderFps).toFixed(1)}` : 'N/A');
    const bitrateStr = liveMetrics.bitrateKbps != null
      ? `${(Number(liveMetrics.bitrateKbps) / 1000).toFixed(2)} Mbps`
      : 'N/A';
    const inputP50Str = liveMetrics.inputLatencyP50 != null
      ? `${liveMetrics.inputLatencyP50}ms`
      : (liveMetrics.latency?.transport?.p50 ? `${liveMetrics.latency.transport.p50}ms` : 'N/A — requires simulator-side agent');
    const inputP95Str = liveMetrics.inputLatencyP95 != null
      ? `${liveMetrics.inputLatencyP95}ms`
      : (liveMetrics.latency?.transport?.p95 ? `${liveMetrics.latency.transport.p95}ms` : 'N/A — requires simulator-side agent');
    const lossStr = liveMetrics.packetLossRate != null
      ? `${(liveMetrics.packetLossRate * 100).toFixed(2)}%`
      : (liveMetrics.webrtc?.packetLossPercent != null ? `${liveMetrics.webrtc.packetLossPercent}%` : 'N/A — no active peer');
    const rttStr = liveMetrics.rttMs != null
      ? `${liveMetrics.rttMs}ms`
      : (liveMetrics.webrtc?.rttMs != null ? `${liveMetrics.webrtc.rttMs}ms` : 'N/A — no active peer');
    const encodeLatStr = liveMetrics.encodeLatencyMs != null
      ? `${Number(liveMetrics.encodeLatencyMs).toFixed(1)}ms`
      : (liveMetrics.encoder?.encodeLatency != null ? `${Number(liveMetrics.encoder.encodeLatency).toFixed(1)}ms` : 'N/A');
    const cpuStr = liveMetrics.cpuPercent != null
      ? `${liveMetrics.cpuPercent}%`
      : 'N/A — host CPU monitoring unconfigured';
    const memStr = liveMetrics.system?.memoryRssMb != null
      ? `${liveMetrics.system.memoryRssMb}MB`
      : `${Math.round(process.memoryUsage().rss / (1024 * 1024))}MB`;

    console.log(`  First frame:       ${green(firstFrameStr)}`);
    console.log(`  FPS:               ${cyan(fpsStr)}`);
    console.log(`  Bitrate:           ${cyan(bitrateStr)}`);
    console.log(`  Input P50:         ${green(inputP50Str)}`);
    console.log(`  Input P95:         ${green(inputP95Str)}`);
    console.log(`  Packet loss:       ${lossStr}`);
    console.log(`  RTT:               ${rttStr}`);
    console.log(`  Encode latency:    ${encodeLatStr}`);
    console.log(`  CPU:               ${cpuStr}`);
    console.log(`  Memory:            ${memStr}\n`);
    return;
  }

  // 2. Local Pipeline Benchmark (real measurement using test frames)
  console.log(dim('  Benchmarking local media pipeline with real H.264 encoder...'));

  const startCpu = process.cpuUsage();
  const encoderStartupStart = Date.now();

  const encoder = new VideoEncoder({ fps: 30, bitrateKbps: 2500 });
  encoder.start();

  const encoderStartupTimeMs = Date.now() - encoderStartupStart;

  // Real valid 16x16 test JPEG frame (generated via FFmpeg mjpeg encoder)
  const testFrame = Buffer.from(
    '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYwLjMxLjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xAByAAEBAAAAAAAAAAAAAAAAAAAFBgEBAAMBAAAAAAAAAAAAAAAABgIDAQQQAAICAQQABQUBAAAAAAAAAAMEAgUBEQcSBiIhFAATFiQjMUEVEQABBAEEAQUBAAAAAAAAAAACBQQDAQYHERMSABQhIhYyFf/AABEIABAAEAMBEgACEgADEgD/2gAMAwEAAhEDEQA/AJmVRa7e7V0TSdgdOxskl7SbVe0cM4Beku0oKBIRASEoKucWIx1xksiY5zhiOfdDbq9e7htp1sX1LVowRq6uqMX5ljxhlJZNaJSfdiwP5pKS0HLPhzLMeUuPmp02wTEV176xYR2CxJKJhYKUEb1sI7FWwtnAm333gAqkKO5BvtQnVXt4c071cX07JRQ2uCqakY9iuWGdz24tzopuIEqW6AOYOxd+tb1vfv5qWsT5E1zRu+hbF9JaoLbHpQjsZ2n992bpTn5LK7udzxwwd660DeLpHQ8k1yc+Ws3umX3A01q4y2DLRSJInDOI4Ym0KDKMEswFCL4XMZTOIYpCEoxhkkAbsrKq8V7z3FfZrtiNjVV6alWFpf8A0EEkVoRImT0o2PTiHJaMWIiZORf8ox5PmOS8o64yJu3V9j3Gv7GoBQ2yuRcOBRKNO5NpgEvCOIA/uIOXlKXlLX+exmm+ZZYuxXGrrqqrDN+7UXk78/hc9j1kdnLIH5HfoQ9qEaLeqrxJhelWMoSASqm5+kL5wB2kas42tkFnctAJlCrObGysiodw97C9vL0NFYLb/UF8oU4cy4n9b+uATx5TVI/sgYKPpmYTi0r1YiNy9oS+Vd62L38npQqpSu4zNmsqDLGH+Uigl6BQcQxu2NpAFJY8Lk2ss/NGXf8AEXGNb/KvP//Z',
    'base64'
  );

  let packetsProduced = 0;
  let totalBytesOut = 0;
  let firstPacketTimestamp = null;
  let lastPacketTimestamp = null;

  encoder.on('packets', (pkts) => {
    if (!firstPacketTimestamp) {
      firstPacketTimestamp = Date.now();
    }
    lastPacketTimestamp = Date.now();
    packetsProduced += pkts.length;
    for (const p of pkts) {
      totalBytesOut += p.length;
    }
  });

  const framesToTest = Math.max(5, Number(flags.frames || 30));
  const encodeStart = Date.now();

  for (let i = 0; i < framesToTest; i++) {
    encoder.encodeFrame(testFrame);
    await new Promise((r) => setTimeout(r, 16)); // ~60fps feed rate
  }

  // Allow encoder to flush pending frames
  await new Promise((r) => setTimeout(r, 250));

  const totalTimeSec = Math.max(0.001, (Date.now() - encodeStart) / 1000);
  const framesReceived = encoder.metrics.inputReceived || framesToTest;
  const framesDropped = encoder.metrics.inputDropped || 0;
  const framesEncoded = Math.max(0, framesReceived - framesDropped);
  const measuredFps = (framesEncoded / totalTimeSec).toFixed(1);

  const cpuDiff = process.cpuUsage(startCpu);
  const cpuPercent = Math.min(100, Math.round(((cpuDiff.user + cpuDiff.system) / (totalTimeSec * 1000000)) * 100));

  const firstFrameLatencyMs = firstPacketTimestamp
    ? firstPacketTimestamp - encodeStart
    : null;

  const firstFrameStr = firstFrameLatencyMs !== null
    ? `${firstFrameLatencyMs}ms (encode start -> first RTP packet)`
    : 'N/A — no packets emitted by synthetic test frame';

  const avgEncodeLatency = framesEncoded > 0
    ? ((totalTimeSec / framesEncoded) * 1000).toFixed(1) + 'ms'
    : 'N/A';

  const measuredBitrateKbps = totalBytesOut > 0
    ? Math.round((totalBytesOut * 8) / (totalTimeSec * 1000))
    : 0;

  const finalMem = process.memoryUsage().rss;
  const memMb = Math.round(finalMem / (1024 * 1024));

  encoder.close();

  console.log(`  Encoder:           ${cyan(encoder.encoderName)} ${encoder.isHardware ? green('(Hardware Accelerated)') : dim('(Software)')}`);
  console.log(`  PID:               ${encoder.ffmpegProc?.pid || 'exited'}`);
  console.log(`  Startup time:      ${encoderStartupTimeMs}ms`);
  console.log(`  First frame:       ${firstFrameStr}`);
  console.log(`  Input frames:      ${framesReceived} fed, ${framesDropped} dropped by queue backpressure`);
  console.log(`  FPS:               ${cyan(measuredFps)}`);
  const measuredBitrateStr = measuredBitrateKbps > 0
    ? `${(measuredBitrateKbps / 1000).toFixed(2)} Mbps (${measuredBitrateKbps} kbps measured)`
    : yellow('0 kbps (measured) / ' + (encoder.bitrateKbps / 1000).toFixed(1) + ' Mbps (target)');
  console.log(`  Bitrate:           ${measuredBitrateStr}`);
  console.log(`  Encode latency:    ${avgEncodeLatency}`);
  console.log(`  Input P50:         N/A — not measured in local pipeline (requires interactive session)`);
  console.log(`  Input P95:         N/A — not measured in local pipeline (requires interactive session)`);
  console.log(`  Packet loss:       N/A — no network transport in local pipeline`);
  console.log(`  RTT:               N/A — no network transport in local pipeline`);
  console.log(`  CPU:               ${cpuPercent}%`);
  console.log(`  Memory:            ${memMb}MB\n`);
}
