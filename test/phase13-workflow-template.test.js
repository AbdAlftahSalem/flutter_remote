import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('Phase 13: templates/flutter-remote.yml pinned dependencies and version 14', () => {
  const ymlPath = join(process.cwd(), 'templates', 'flutter-remote.yml');
  const ymlContent = readFileSync(ymlPath, 'utf8');

  assert.ok(ymlContent.includes('flutter-remote-template-version: 14'), 'Template version must be 14');
  assert.ok(ymlContent.includes('node-datachannel@0.33.4'), 'node-datachannel must be pinned to 0.33.4');
  assert.ok(ymlContent.includes('ws@8.18.0'), 'ws must be pinned to 8.18.0');
  assert.ok(ymlContent.includes('FLUTTER_REMOTE_TRANSPORT'), 'Must pass FLUTTER_REMOTE_TRANSPORT env');
});

test('Phase 13: templates/gate.cjs version 9 and V2 client serving', () => {
  const gatePath = join(process.cwd(), 'templates', 'gate.cjs');
  const gateContent = readFileSync(gatePath, 'utf8');

  assert.ok(gateContent.includes('flutter-remote-template-version: 9'), 'Gate template version must be 9');
  assert.ok(gateContent.includes('/__flutter-remote/client.js'), 'Must serve V2 client at /__flutter-remote/client.js');
  assert.ok(gateContent.includes('/readyz'), 'Must implement /readyz health check');
});

test('Phase 13: templates/webrtc-peer.cjs version 4 and Video track streaming', () => {
  const peerPath = join(process.cwd(), 'templates', 'webrtc-peer.cjs');
  const peerContent = readFileSync(peerPath, 'utf8');

  assert.ok(peerContent.includes('flutter-remote-template-version: 4'), 'Peer template version must be 4');
  assert.ok(peerContent.includes("new Video('video', 'SendOnly')"), 'Must configure Video SendOnly track');
  assert.ok(peerContent.includes('addH264Codec(98)'), 'Must configure H.264 codec');
  assert.ok(peerContent.includes('addVP8Codec(97)'), 'Must configure VP8 codec');
});
