/**
 * `flutter-remote benchmark`
 *
 *  - With a live session: reads the runner's real pipeline metrics through the
 *    gate (/__flutter-remote/metrics, token-protected).
 *  - Without one (or with --local): runs the SAME H.264 encoder the runner uses
 *    (src/runner/flutter-remote/peer) on real FFmpeg test frames, and measures it.
 *    Nothing is estimated; what cannot be measured locally is shown as N/A.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as gh from '../../core/gh.js';
import { loadSession } from '../../core/session.js';
import { FlutterRemoteError } from '../../core/errors.js';
import { bold, cyan, green, dim, info, warn } from '../../core/ui.js';

const require = createRequire(import.meta.url);
const { VideoEncoder } = require('../../runner/flutter-remote/peer/VideoEncoder.cjs');
const { createJpegSplitter } = require('../../runner/flutter-remote/peer/mjpeg.cjs');

function ffmpegBinary() {
  try { return require('ffmpeg-static') || 'ffmpeg'; } catch { return 'ffmpeg'; }
}

/** Real JPEG frames from FFmpeg's test source (phone-sized, like the simulator). */
export function makeTestFrames(count, size = '390x844') {
  const r = spawnSync(ffmpegBinary(), [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30`,
    '-frames:v', String(count), '-q:v', '5', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1',
  ], { maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    throw new FlutterRemoteError('FFmpeg is needed for the local benchmark and was not found', {
      hint: 'install FFmpeg (winget install ffmpeg / brew install ffmpeg / apt install ffmpeg), or run a live session first',
    });
  }
  const frames = [];
  createJpegSplitter((jpeg) => frames.push(jpeg)).push(r.stdout);
  return frames;
}

async function liveMetrics(cwd, session) {
  const status = gh.readStatus(cwd, session.repo, session.sha, session.context);
  if (status?.state !== 'success' || !status.target_url) return null;
  const url = `${status.target_url.replace(/\/$/, '')}/__flutter-remote/metrics`;
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${session.gateToken}` }, signal: AbortSignal.timeout(5000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

const row = (label, value) => console.log(`  ${label.padEnd(18)} ${value}`);

export async function benchmark(cwd, flags = {}) {
  console.log(`\n${bold('flutter-remote benchmark')}\n`);

  const session = flags.local ? null : loadSession(cwd);
  if (session) {
    const m = await liveMetrics(cwd, session);
    if (m) {
      console.log(dim('  Live session: metrics from the macOS runner\n'));
      row('Frames received', cyan(m.framePipeline?.framesReceived ?? 'N/A'));
      row('RTP packets sent', cyan(m.rtp?.packetsSent ?? 'N/A'));
      row('Frames packetized', cyan(m.rtp?.framesPacketized ?? 'N/A'));
      row('Sessions', `${m.connectedSessions ?? 0} connected / ${m.sessions ?? 0} total`);
      console.log(dim(`\n  Raw: ${JSON.stringify(m)}\n`));
      return;
    }
    warn('A session is recorded but its runner is not reachable; measuring the local encoder instead');
  }

  const count = Math.max(5, Number(flags.frames || 60));
  info(`Encoding ${count} real test frames (390×844) with the runner's H.264 encoder…`);
  const frames = makeTestFrames(count);

  const encoder = new VideoEncoder({ fps: 30, bitrateKbps: 2500 });
  const startedAt = Date.now();
  encoder.start();
  let firstPacketAt = null;
  let packets = 0;
  let bytes = 0;
  encoder.on('packets', (pkts) => {
    firstPacketAt ??= Date.now();
    packets += pkts.length;
    for (const p of pkts) bytes += p.length;
  });

  const cpuBefore = process.cpuUsage();
  for (const frame of frames) {
    encoder.encodeFrame(frame);
    await new Promise((r) => setTimeout(r, 1000 / 30));
  }
  await new Promise((r) => setTimeout(r, 500));
  const seconds = (Date.now() - startedAt) / 1000;
  const cpu = process.cpuUsage(cpuBefore);
  const received = encoder.metrics.inputReceived;
  const dropped = encoder.metrics.inputDropped;
  const name = encoder.encoderName;
  encoder.close();

  if (!packets) {
    throw new FlutterRemoteError('The encoder produced no video', { hint: 'run flutter-remote doctor, and check that FFmpeg supports libx264' });
  }
  console.log('');
  row('Encoder', `${cyan(name)} ${encoder.isHardware ? green('(hardware)') : dim('(software; the runner uses VideoToolbox when available)')}`);
  row('First packet', `${firstPacketAt - startedAt} ms after start`);
  row('Frames', `${received} fed, ${dropped} dropped`);
  row('Throughput', `${((received - dropped) / seconds).toFixed(1)} fps`);
  row('Bitrate', `${Math.round((bytes * 8) / seconds / 1000)} kbps (target 2500)`);
  row('RTP packets', String(packets));
  row('CPU (this process)', `${Math.round(((cpu.user + cpu.system) / 1e6 / seconds) * 100)}%`);
  row('Network / input', dim('N/A locally: run during a live session'));
  console.log('');
}
