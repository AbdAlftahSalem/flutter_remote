/**
 * Flutter Remote WebRTC V2 Configuration Resolver
 *
 * Precedence: CLI flags > Environment variables > Config file > Defaults
 */

import { DEFAULT_CONFIG } from './defaultConfig.js';

export function resolveConfig(flags = {}, env = process.env) {
  const envConfig = {
    transport: env.FLUTTER_REMOTE_TRANSPORT || undefined,
    codec: env.FLUTTER_REMOTE_CODEC || undefined,
    fps: env.FLUTTER_REMOTE_FPS ? Number(env.FLUTTER_REMOTE_FPS) : undefined,
    maxDimension: env.FLUTTER_REMOTE_MAX_DIMENSION ? Number(env.FLUTTER_REMOTE_MAX_DIMENSION) : undefined,
    adaptiveQuality: env.FLUTTER_REMOTE_ADAPTIVE_QUALITY !== undefined ? env.FLUTTER_REMOTE_ADAPTIVE_QUALITY === 'true' : undefined,
    reconnect: env.FLUTTER_REMOTE_RECONNECT !== undefined ? env.FLUTTER_REMOTE_RECONNECT === 'true' : undefined,
    turn: env.FLUTTER_REMOTE_TURN !== undefined ? env.FLUTTER_REMOTE_TURN === 'true' : undefined,
    debug: env.FLUTTER_REMOTE_DEBUG !== undefined ? env.FLUTTER_REMOTE_DEBUG === 'true' : undefined,
    ports: {
      gateway: env.FLUTTER_REMOTE_GATE_PORT ? Number(env.FLUTTER_REMOTE_GATE_PORT) : undefined,
      preview: env.FLUTTER_REMOTE_TARGET_PORT ? Number(env.FLUTTER_REMOTE_TARGET_PORT) : undefined,
      signaling: env.FLUTTER_REMOTE_WEBRTC_SIGNAL_PORT ? Number(env.FLUTTER_REMOTE_WEBRTC_SIGNAL_PORT) : undefined,
      agent: env.FLUTTER_REMOTE_AGENT_PORT ? Number(env.FLUTTER_REMOTE_AGENT_PORT) : undefined,
    },
  };

  const cliConfig = {
    transport: flags.transport || undefined,
    codec: flags.codec || undefined,
    fps: flags.fps !== undefined ? Number(flags.fps) : undefined,
    maxDimension: flags['max-dimension'] !== undefined ? Number(flags['max-dimension']) : undefined,
    adaptiveQuality: flags['adaptive-quality'] !== undefined ? Boolean(flags['adaptive-quality']) : undefined,
    reconnect: flags.reconnect !== undefined ? Boolean(flags.reconnect) : undefined,
    turn: flags.turn !== undefined ? Boolean(flags.turn) : undefined,
    debug: flags.debug !== undefined ? Boolean(flags.debug) : undefined,
    minutes: flags.minutes !== undefined ? Number(flags.minutes) : undefined,
    device: flags.device || undefined,
    runner: flags.runner || undefined,
    flutterVersion: flags['flutter-version'] || undefined,
    buildMode: flags['build-mode'] || undefined,
    tunnelProtocol: flags['tunnel-protocol'] || undefined,
  };

  const clean = (obj) => {
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v !== undefined) {
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
          result[k] = clean(v);
        } else {
          result[k] = v;
        }
      }
    }
    return result;
  };

  const cleanEnv = clean(envConfig);
  const cleanCli = clean(cliConfig);

  return {
    ...DEFAULT_CONFIG,
    ...cleanEnv,
    ...cleanCli,
    ports: {
      ...DEFAULT_CONFIG.ports,
      ...(cleanEnv.ports || {}),
      ...(cleanCli.ports || {}),
    },
  };
}
