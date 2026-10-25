/**
 * Boots the real streaming stack exactly as the macOS runner does, minus the
 * iOS Simulator: synthetic serve-sim -> webrtc-peer.cjs -> gate.cjs.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { freePort, startProcess, waitForHttp } from './processes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, '..', '..');
export const RUNNER_DIR = join(ROOT, 'src', 'runner', 'flutter-remote');
export const GATE = join(RUNNER_DIR, 'gate.cjs');
export const PEER = join(RUNNER_DIR, 'webrtc-peer.cjs');
export const SYNTHETIC_SERVE_SIM = join(here, 'synthetic-serve-sim.mjs');
export const NODE_MODULES = join(ROOT, 'node_modules');

export async function startServeSim({ size = '390x844', fps = 15 } = {}) {
  const port = await freePort();
  const proc = startProcess('serve-sim', process.execPath, [SYNTHETIC_SERVE_SIM, '--port', String(port), '--size', size, '--fps', String(fps)]);
  await waitForHttp(`http://127.0.0.1:${port}/__synthetic/stats`);
  return { port, proc, url: `http://127.0.0.1:${port}` };
}

export async function startPeer({ serveSimPort, env = {} }) {
  const port = await freePort();
  const proc = startProcess('webrtc-peer', process.execPath, [PEER], {
    env: {
      NODE_PATH: NODE_MODULES,
      FLUTTER_REMOTE_TARGET_PORT: String(serveSimPort),
      FLUTTER_REMOTE_WEBRTC_SIGNAL_PORT: String(port),
      FLUTTER_REMOTE_STREAM_PATH: '/stream.mjpeg?raw=1',
      ...env,
    },
  });
  await waitForHttp(`http://127.0.0.1:${port}/healthz`);
  return { port, proc };
}

export async function startGate({ serveSimPort, peerPort, token = 'e2e-token', env = {} }) {
  const port = await freePort();
  const proc = startProcess('gate', process.execPath, [GATE], {
    env: {
      FLUTTER_REMOTE_GATE_TOKEN: token,
      FLUTTER_REMOTE_GATE_PORT: String(port),
      FLUTTER_REMOTE_TARGET_PORT: String(serveSimPort),
      FLUTTER_REMOTE_WEBRTC_SIGNAL_PORT: String(peerPort),
      ...env,
    },
  });
  await waitForHttp(`http://127.0.0.1:${port}/healthz`);
  return { port, proc, token, url: `http://127.0.0.1:${port}` };
}

/** The whole stack, in boot order. */
export async function startStack(opts = {}) {
  const serveSim = await startServeSim(opts);
  const peer = await startPeer({ serveSimPort: serveSim.port, env: opts.peerEnv });
  const gate = await startGate({ serveSimPort: serveSim.port, peerPort: peer.port, env: opts.gateEnv });
  return { serveSim, peer, gate };
}
