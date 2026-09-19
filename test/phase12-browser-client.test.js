import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('Phase 12: Browser client contains ZERO WebSocket monkey-patching', () => {
  const clientPath = join(process.cwd(), 'client', 'flutter-remote-client.js');
  const clientCode = readFileSync(clientPath, 'utf8');

  // Must NOT monkey-patch window.WebSocket or ws.send
  assert.ok(!clientCode.includes('window.WebSocket ='), 'Must NOT assign window.WebSocket');
  assert.ok(!clientCode.includes('WebSocket.prototype'), 'Must NOT override WebSocket.prototype');
  assert.ok(!clientCode.includes('origSend ='), 'Must NOT hijack send method');

  // Must contain discrete DataChannels
  assert.ok(clientCode.includes("createDataChannel('input'"), 'Must create input DataChannel');
  assert.ok(clientCode.includes("createDataChannel('keyboard'"), 'Must create keyboard DataChannel');
  assert.ok(clientCode.includes("createDataChannel('control'"), 'Must create control DataChannel');
  assert.ok(clientCode.includes("createDataChannel('telemetry'"), 'Must create telemetry DataChannel');

  // Must contain pointer capture and requestAnimationFrame coalescing
  assert.ok(clientCode.includes('setPointerCapture'), 'Must use setPointerCapture');
  assert.ok(clientCode.includes('requestAnimationFrame'), 'Must use requestAnimationFrame coalescing');

  // Must contain video element handling
  assert.ok(clientCode.includes("<video") || clientCode.includes("createElement('video')"), 'Must use video element');
  assert.ok(clientCode.includes('ontrack'), 'Must set ontrack for WebRTC video stream');

  // Must contain debug diagnostics overlay
  assert.ok(clientCode.includes('flutter-remote-debug-panel'), 'Must support debug diagnostics panel');
});
