import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VideoEncoder as PeerVideoEncoder } from '../templates/peer/VideoEncoder.cjs';
import { VideoEncoder as MediaVideoEncoder } from '../src/media/VideoEncoder.js';
import { PeerSession } from '../templates/peer/PeerSession.cjs';
import { DataChannelManager } from '../client/webrtc/DataChannelManager.js';
import { VideoRenderer } from '../client/video/VideoRenderer.js';
import { InputController } from '../client/input/InputController.js';
import { FlutterRemoteClient } from '../client/flutter-remote-client.js';

test('Phase 21: PeerVideoEncoder.requestKeyframe emits cached IDR packets immediately', () => {
  const encoder = new PeerVideoEncoder();
  const cachedPackets = [Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65])];

  // Mock hasKeyframe and getKeyframePackets
  encoder.hasKeyframe = () => true;
  encoder.getKeyframePackets = () => cachedPackets;

  let emitted = null;
  encoder.once('packets', (packets) => {
    emitted = packets;
  });

  encoder.requestKeyframe('test_cached');
  assert.equal(emitted, cachedPackets, 'Must emit cached IDR packets immediately upon request');
});

test('Phase 21: PeerVideoEncoder.requestKeyframe emits fresh packets when keyframeController resolves', async () => {
  const encoder = new PeerVideoEncoder();
  const freshPackets = [Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67]), Buffer.from([0x00, 0x00, 0x00, 0x01, 0x68])];

  // Mock hasKeyframe to false so cached path is skipped
  encoder.hasKeyframe = () => false;

  // Mock keyframeController
  encoder.keyframeController = {
    requestKeyframe: async () => freshPackets,
  };

  const emitted = [];
  encoder.on('packets', (packets) => {
    emitted.push(packets);
  });

  const p = encoder.requestKeyframe('fast_swipe_recovery');
  assert.ok(p instanceof Promise, 'requestKeyframe must return a Promise');
  await p;

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0], freshPackets, 'Must emit fresh IDR packets through "packets" event');
});

test('Phase 21: MediaVideoEncoder (src/media) also emits cached and fresh keyframe packets', async () => {
  const encoder = new MediaVideoEncoder();
  const cachedPackets = [Buffer.from([0x01, 0x02, 0x03])];

  encoder.hasKeyframe = () => true;
  encoder.getKeyframePackets = () => cachedPackets;

  let cachedEmitted = null;
  encoder.once('packets', (packets) => {
    cachedEmitted = packets;
  });

  encoder.requestKeyframe('test_src_cached');
  assert.equal(cachedEmitted, cachedPackets);

  const freshPackets = [Buffer.from([0x04, 0x05, 0x06])];
  encoder.hasKeyframe = () => false;
  encoder.keyframeController = {
    requestKeyframe: async () => freshPackets,
  };

  let freshEmitted = null;
  encoder.on('packets', (packets) => {
    freshEmitted = packets;
  });

  await encoder.requestKeyframe('test_src_fresh');
  assert.equal(freshEmitted, freshPackets);
});

test('Phase 21: PeerSession forwards request_keyframe control message to videoEncoder with reason', () => {
  let requestedReason = null;
  const mockEncoder = {
    requestKeyframe: (reason) => {
      requestedReason = reason;
    },
  };

  const mockTrack = {
    addH264Codec: () => {},
    addVP8Codec: () => {},
  };

  let registeredChannelHandler = null;
  const mockPeer = {
    addTrack: () => {},
    onLocalDescription: () => {},
    onLocalCandidate: () => {},
    onDataChannel: (cb) => {
      registeredChannelHandler = cb;
    },
    setRemoteDescription: () => {},
  };

  const mockNdc = {
    PeerConnection: function () {
      return mockPeer;
    },
    Video: function () {
      return mockTrack;
    },
  };

  const session = new PeerSession({
    ws: { readyState: 1, send: () => {} },
    ndc: mockNdc,
    videoEncoder: mockEncoder,
    serveSimConsumer: {
      initServeSimWs: () => {},
      sendToServeSim: () => {},
    },
    activeVideoTracks: new Set(),
  });

  session.handleOffer({ sdp: 'dummy-offer' });
  assert.ok(registeredChannelHandler, 'Must register onDataChannel handler');

  let messageCallback = null;
  const mockDc = {
    getLabel: () => 'control',
    onMessage: (cb) => {
      messageCallback = cb;
    },
  };

  registeredChannelHandler(mockDc);
  assert.ok(messageCallback, 'Must set message callback on control data channel');

  // Send request_keyframe with reason
  messageCallback(Buffer.from(JSON.stringify({
    type: 'request_keyframe',
    reason: 'client_freeze_watchdog',
  })));

  assert.equal(requestedReason, 'client_freeze_watchdog', 'PeerSession must pass reason to videoEncoder.requestKeyframe');
});

test('Phase 21: DataChannelManager formats and sends request_keyframe over control channel', () => {
  const dcm = new DataChannelManager();
  const sentMessages = [];

  const mockControlDc = {
    readyState: 'open',
    send: (msg) => sentMessages.push(msg),
  };

  dcm.channels.control = mockControlDc;

  const sent = dcm.requestKeyframe('interaction_stall');
  assert.equal(sent, true, 'requestKeyframe must return true when control channel is open');
  assert.equal(sentMessages.length, 1);

  const parsed = JSON.parse(sentMessages[0]);
  assert.equal(parsed.v, 2);
  assert.equal(parsed.type, 'request_keyframe');
  assert.equal(parsed.reason, 'interaction_stall');
  assert.ok(typeof parsed.ts === 'number');

  // Test when channel is closed
  mockControlDc.readyState = 'closed';
  const sentClosed = dcm.requestKeyframe('closed_test');
  assert.equal(sentClosed, false, 'requestKeyframe must return false when control channel is not open');
  assert.equal(sentMessages.length, 1);
});

test('Phase 21: VideoRenderer tracks lastFramePresentedTime', () => {
  const renderer = new VideoRenderer();
  assert.equal(renderer.getLastFramePresentedTime(), 0);

  renderer.lastFramePresentedTime = 12345;
  assert.equal(renderer.getLastFramePresentedTime(), 12345);
});

test('Phase 21: InputController tracks lastInteractionTime', () => {
  const mockRenderer = {
    getBounds: () => ({ left: 0, top: 0, width: 100, height: 200 }),
    getVideoResolution: () => ({ width: 100, height: 200 }),
  };
  const mockDcm = { send: () => {}, sendInput: () => {} };
  const controller = new InputController(null, mockRenderer, mockDcm);

  assert.equal(controller.getLastInteractionTime(), 0);

  // Simulate pointer down event
  controller._handlePointer({
    pointerId: 1,
    clientX: 100,
    clientY: 200,
    buttons: 1,
    pointerType: 'mouse',
    preventDefault: () => {},
  }, 'down');

  assert.ok(controller.getLastInteractionTime() > 0, 'Interaction time must be recorded on pointer event');
});

test('Phase 21: FlutterRemoteClient coalesces keyframe requests within 1000ms', () => {
  const client = new FlutterRemoteClient({ autoConnect: false });
  const requests = [];

  client.dataChannelManager = {
    requestKeyframe: (reason) => {
      requests.push(reason);
      return true;
    },
  };

  // First request succeeds
  const r1 = client.requestKeyframe('swipe_stall');
  assert.equal(r1, true);
  assert.equal(requests.length, 1);

  // Immediate subsequent request within 1000ms is coalesced/ignored
  const r2 = client.requestKeyframe('swipe_stall_2');
  assert.equal(r2, false);
  assert.equal(requests.length, 1);

  // Fast-forward lastKeyframeRequestTime
  client._lastKeyframeRequestTime = Date.now() - 1100;
  const r3 = client.requestKeyframe('swipe_stall_3');
  assert.equal(r3, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[1], 'swipe_stall_3');
});

test('Phase 21: Gate template and embedded client script include keyframe recovery watchdog', () => {
  const gatePath = join(process.cwd(), 'templates', 'gate.cjs');
  const gateCode = readFileSync(gatePath, 'utf8');

  assert.ok(gateCode.includes('request_keyframe'), 'Gate client script must support request_keyframe');
  assert.ok(gateCode.includes('_checkVideoHealth'), 'Gate client script must implement _checkVideoHealth watchdog');
  assert.ok(gateCode.includes('lastFramePresentedTime'), 'Gate VideoRenderer must track lastFramePresentedTime');
  assert.ok(gateCode.includes('lastInteractionTime'), 'Gate InputController must track lastInteractionTime');
});
