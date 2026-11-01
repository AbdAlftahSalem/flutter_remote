/**
 * The WebRTC player on a lossy network (opt-in, Linux, needs passwordless sudo):
 *
 *   FLUTTER_REMOTE_LOSSY=1 npm run test:lossy
 *
 * Runs the whole stack and headless Chrome inside a network namespace whose
 * firewall drops 3 % of UDP packets at random (TCP is untouched), then counts
 * the frames Chrome decoded. Up to 0.2.3, a lost video packet was never
 * resent: a keyframe split into ~100 packets almost always lost one, and Chrome
 * decoded 3 frames in 11 s, showing "Connected, waiting for video feed..." (what
 * Abd saw on Nov 1). With NACK retransmission it decodes at the full rate.
 * FLUTTER_REMOTE_RTP_NACK=0 in the probe's peer reproduces the old behaviour.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { userInfo } from 'node:os';

const skip = process.env.FLUTTER_REMOTE_LOSSY === '1' ? false : 'set FLUTTER_REMOTE_LOSSY=1 (Linux, passwordless sudo: creates a network namespace)';
const NS = 'frlossy';
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const sudo = (...a) => spawnSync('sudo', a, { encoding: 'utf8' });

before(() => {
  if (skip) return;
  sudo('ip', 'netns', 'del', NS);
  sudo('ip', 'link', 'del', `${NS}0`);
  for (const cmd of [
    ['ip', 'netns', 'add', NS],
    ['ip', 'netns', 'exec', NS, 'ip', 'link', 'set', 'lo', 'up'],
    // Chrome and libdatachannel skip loopback ICE candidates: give the namespace a real interface.
    ['ip', 'link', 'add', `${NS}0`, 'type', 'veth', 'peer', 'name', `${NS}1`],
    ['ip', 'link', 'set', `${NS}1`, 'netns', NS],
    ['ip', 'netns', 'exec', NS, 'ip', 'addr', 'add', '10.211.0.2/24', 'dev', `${NS}1`],
    ['ip', 'netns', 'exec', NS, 'ip', 'link', 'set', `${NS}1`, 'up'],
    ['ip', 'link', 'set', `${NS}0`, 'up'],
    ['ip', 'netns', 'exec', NS, 'iptables', '-A', 'OUTPUT', '-p', 'udp', '-m', 'statistic', '--mode', 'random', '--probability', '0.03', '-j', 'DROP'],
  ]) {
    const r = sudo(...cmd);
    assert.equal(r.status, 0, `${cmd.join(' ')}: ${r.stderr}`);
  }
});
after(() => {
  if (skip) return;
  sudo('ip', 'netns', 'del', NS);
  sudo('ip', 'link', 'del', `${NS}0`);
});

function probe(peerEnv = {}) {
  const r = spawnSync('sudo', [
    'ip', 'netns', 'exec', NS, 'sudo', '-u', userInfo().username,
    'env', `HOME=${process.env.HOME}`, `PATH=${process.env.PATH}`, `PEER_ENV=${JSON.stringify(peerEnv)}`,
    process.execPath, join(ROOT, 'test', 'support', 'webrtc-probe.mjs'), '--size', '1206x2622', '--seconds', '10',
  ], { encoding: 'utf8', cwd: ROOT, timeout: 90000 });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('PROBE '));
  assert.ok(line, `probe printed nothing: ${r.stderr}`);
  return JSON.parse(line.slice(6));
}

test('with 3 % UDP loss the WebRTC player still shows video at the full frame rate', { skip, timeout: 120000 }, () => {
  // FLUTTER_REMOTE_LOSSY_PEER_ENV='{"FLUTTER_REMOTE_RTP_NACK":"0"}' shows the test failing without retransmission.
  const r = probe(JSON.parse(process.env.FLUTTER_REMOTE_LOSSY_PEER_ENV || '{}'));
  assert.ok(r.inbound, `no video stats: ${JSON.stringify(r)}`);
  // serve-sim (synthetic) sends 15 frames/s; 10 s => ~150. Allow start-up time.
  assert.ok(r.inbound.decoded >= 100, `Chrome decoded ${r.inbound.decoded} frames in 10 s at 3 % loss: ${JSON.stringify(r.inbound)}`);
  assert.equal(r.videoHeight, 960, 'the picture is scaled to 960 px');
});
