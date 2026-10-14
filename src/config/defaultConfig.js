/**
 * Flutter Remote WebRTC V2 Default Configuration
 */

import { PORTS, CODECS } from '../shared/constants.js';

export const DEFAULT_CONFIG = {
  transport: 'webrtc',
  codec: CODECS.MJPEG,
  fps: 30,
  maxDimension: 720,
  adaptiveQuality: true,
  reconnect: true,
  turn: true,
  debug: false,
  minutes: 10,
  device: 'iPhone 17 Pro',
  runner: 'macos-26',
  flutterVersion: 'stable',
  buildMode: 'debug',
  tunnelProtocol: 'quic',
  ports: {
    gateway: PORTS.GATEWAY,
    preview: PORTS.PREVIEW,
    signaling: PORTS.SIGNALING,
    agent: PORTS.AGENT,
  },
};
