/**
 * Shared by gate.cjs and webrtc-peer.cjs on the runner: one reading of the
 * environment (ports, token, modes) and one set of crash guards.
 */
const env = process.env;

const config = Object.freeze({
  host: '127.0.0.1',
  /** serve-sim (the Simulator stream + input socket) */
  targetPort: Number(env.FLUTTER_REMOTE_TARGET_PORT || env.PREVIEW_PORT || 3200),
  /** webrtc-peer.cjs: signaling WebSocket + /healthz + /metrics */
  signalPort: Number(env.FLUTTER_REMOTE_WEBRTC_SIGNAL_PORT || 3201),
  /** gate.cjs: the public entry behind the tunnel */
  gatePort: Number(env.FLUTTER_REMOTE_GATE_PORT || 3199),
  /** agent-device proxy (0 = disabled) */
  agentPort: Number(env.FLUTTER_REMOTE_AGENT_PORT || 0),
  gateToken: env.FLUTTER_REMOTE_GATE_TOKEN || '',
  transport: env.FLUTTER_REMOTE_TRANSPORT || 'webrtc',
  streamPath: env.FLUTTER_REMOTE_STREAM_PATH || '/stream.mjpeg?raw=1',
  adaptiveQuality: env.FLUTTER_REMOTE_ADAPTIVE_QUALITY === 'true',
  turnKeyId: env.FLUTTER_REMOTE_TURN_KEY_ID || '',
  turnKeyToken: env.FLUTTER_REMOTE_TURN_KEY_TOKEN || '',
});

/** Log instead of dying on a stray socket error: the session must stay up. */
function installCrashGuards(name) {
  process.on('uncaughtException', (err) => console.error(`[${name} uncaughtException]`, err.message));
  process.on('unhandledRejection', (reason) => console.error(`[${name} unhandledRejection]`, reason));
}

module.exports = { config, installCrashGuards };
