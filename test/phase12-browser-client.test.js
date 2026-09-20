import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('Phase 12: Browser client contains ZERO WebSocket monkey-patching and is fully modular', () => {
  const clientDir = join(process.cwd(), 'client');
  const clientPath = join(clientDir, 'flutter-remote-client.js');
  const clientCode = readFileSync(clientPath, 'utf8');

  // 1. Must NOT monkey-patch window.WebSocket or ws.send
  assert.ok(!clientCode.includes('window.WebSocket ='), 'Must NOT assign window.WebSocket');
  assert.ok(!clientCode.includes('WebSocket.prototype'), 'Must NOT override WebSocket.prototype');
  assert.ok(!clientCode.includes('origSend ='), 'Must NOT hijack send method');

  // 2. Orchestrator must import modules and NOT contain duplicate class definitions
  assert.ok(clientCode.includes("from './connection/ConnectionState.js'"), 'Must import ConnectionState');
  assert.ok(clientCode.includes("from './connection/ReconnectController.js'"), 'Must import ReconnectController');
  assert.ok(clientCode.includes("from './connection/SignalingClient.js'"), 'Must import SignalingClient');
  assert.ok(clientCode.includes("from './webrtc/PeerConnectionManager.js'"), 'Must import PeerConnectionManager');
  assert.ok(clientCode.includes("from './webrtc/DataChannelManager.js'"), 'Must import DataChannelManager');
  assert.ok(clientCode.includes("from './webrtc/WebRTCStatsCollector.js'"), 'Must import WebRTCStatsCollector');
  assert.ok(clientCode.includes("from './input/InputController.js'"), 'Must import InputController');
  assert.ok(clientCode.includes("from './input/KeyboardController.js'"), 'Must import KeyboardController');
  assert.ok(clientCode.includes("from './input/ClipboardController.js'"), 'Must import ClipboardController');
  assert.ok(clientCode.includes("from './video/VideoRenderer.js'"), 'Must import VideoRenderer');
  assert.ok(clientCode.includes("from './ui/SessionUI.js'"), 'Must import SessionUI');
  assert.ok(clientCode.includes("from './ui/DebugOverlay.js'"), 'Must import DebugOverlay');

  const duplicateClasses = [
    'class ConnectionState',
    'class ReconnectController',
    'class SignalingClient',
    'class PeerConnectionManager',
    'class DataChannelManager',
    'class WebRTCStatsCollector',
    'class InputController',
    'class KeyboardController',
    'class ClipboardController',
    'class VideoRenderer',
    'class SessionUI',
    'class DebugOverlay',
  ];
  for (const cls of duplicateClasses) {
    assert.ok(!clientCode.includes(cls), `Orchestrator must NOT contain duplicate ${cls}`);
  }

  // 3. Modular files must contain discrete DataChannels
  const dcCode = readFileSync(join(clientDir, 'webrtc', 'DataChannelManager.js'), 'utf8');
  assert.ok(dcCode.includes('input:'), 'Must configure input DataChannel');
  assert.ok(dcCode.includes('keyboard:'), 'Must configure keyboard DataChannel');
  assert.ok(dcCode.includes('control:'), 'Must configure control DataChannel');
  assert.ok(dcCode.includes('telemetry:'), 'Must configure telemetry DataChannel');

  // 4. Must contain pointer capture and requestAnimationFrame coalescing in InputController
  const inputCode = readFileSync(join(clientDir, 'input', 'InputController.js'), 'utf8');
  assert.ok(inputCode.includes('setPointerCapture'), 'Must use setPointerCapture');
  assert.ok(inputCode.includes('requestAnimationFrame'), 'Must use requestAnimationFrame coalescing');

  // 5. Must contain video element handling in VideoRenderer
  const videoCode = readFileSync(join(clientDir, 'video', 'VideoRenderer.js'), 'utf8');
  assert.ok(videoCode.includes("<video") || videoCode.includes("createElement('video')"), 'Must use video element');

  // 6. Must contain debug diagnostics overlay in DebugOverlay
  const debugCode = readFileSync(join(clientDir, 'ui', 'DebugOverlay.js'), 'utf8');
  assert.ok(debugCode.includes('flutter-remote-debug-panel'), 'Must support debug diagnostics panel');
});
