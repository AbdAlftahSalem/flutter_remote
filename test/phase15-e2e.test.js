import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../src/session/SessionManager.js';
import { SessionStore } from '../src/session/SessionStore.js';
import { SignalingServer } from '../src/signaling/SignalingServer.js';
import { SignalingClient } from '../src/signaling/SignalingClient.js';
import { SignalingProtocol } from '../src/signaling/SignalingProtocol.js';
import { PeerManager } from '../src/webrtc/PeerManager.js';
import { LatencyTracker } from '../src/metrics/LatencyTracker.js';
import { InputRouter } from '../src/input/InputRouter.js';
import { InputProtocol } from '../src/input/InputProtocol.js';
import { FrameController } from '../src/media/FrameController.js';
import { VideoEncoder } from '../src/media/VideoEncoder.js';
import { SESSION_STATES, CONNECTION_STATES } from '../src/shared/constants.js';

test('Phase 15: End-to-End full session lifecycle, signaling, media & input routing', async () => {
  // 1. Create Session
  const store = new SessionStore();
  const sessionManager = new SessionManager(store);
  const session = sessionManager.createSession({ durationMinutes: 10 });
  assert.ok(session.id);
  assert.ok(session.token);

  session.state.transition(SESSION_STATES.STARTING_GATEWAY);
  session.state.transition(SESSION_STATES.READY);
  session.state.transition(SESSION_STATES.ACTIVE);

  // 2. Start Signaling Server
  const signalPort = 39878;
  const signalingServer = new SignalingServer({ port: signalPort, store });
  signalingServer.start();

  // 3. Setup Server PeerManager & InputRouter
  const peerManager = new PeerManager({ sessionId: session.id });
  const latencyTracker = new LatencyTracker();
  const dispatchedToSimulator = [];

  const mockSimulatorAdapter = {
    async pointer(e) { dispatchedToSimulator.push(e); },
    async keyboard(e) { dispatchedToSimulator.push(e); },
    async scroll(e) {},
    async clipboard(text) {},
  };

  const inputRouter = new InputRouter(mockSimulatorAdapter, latencyTracker);

  // 4. Setup Media Pipeline (FrameController + VideoEncoder)
  const frameController = new FrameController({ maxQueueSize: 2 });
  const videoEncoder = new VideoEncoder({ payloadType: 98, ssrc: 12345 });

  // 5. Connect Client Signaling
  const signalingClient = new SignalingClient({
    url: `ws://127.0.0.1:${signalPort}/signal`,
    sessionId: session.id,
    token: session.token,
    generation: session.generation,
  });

  await signalingClient.connect();

  // Wire signaling offer/answer
  signalingServer.on('offer', async ({ ws, sessionId, message }) => {
    // Generate server answer
    const answer = SignalingProtocol.createAnswer(sessionId, message.generation, 'v=0\r\nm=video 9 ...\r\nm=application 9 ...');
    ws.send(JSON.stringify(answer));
  });

  const answerPromise = new Promise((resolve) => {
    signalingClient.on('answer', (msg) => {
      resolve(msg);
    });
  });

  // Client sends offer
  signalingClient.sendOffer('v=0\r\nm=video 9 ...\r\nm=application 9 ...');
  const receivedAnswer = await answerPromise;
  assert.ok(receivedAnswer);

  // 6. Test Input Routing & End-to-End Latency Tracking
  const inputEvent = InputProtocol.createPointerEvent({
    event: 'down',
    pointerId: 1,
    x: 0.5,
    y: 0.5,
    seq: 101,
    ts: Date.now() - 25, // 25ms client capture latency
  });

  await inputRouter.handleInputMessage(inputEvent);
  assert.equal(dispatchedToSimulator.length, 1);
  assert.equal(dispatchedToSimulator[0].seq, 101);

  // 7. Simulate Visual Frame Response
  frameController.pushFrame(Buffer.from('simulated-jpeg-frame'));
  const popped = frameController.popFrame();
  assert.ok(popped);
  const rtpPackets = videoEncoder.packetize(popped.frame);
  assert.ok(rtpPackets.length > 0);

  latencyTracker.recordFrameResponse(101);

  const metrics = latencyTracker.getMetrics();
  assert.equal(metrics.transport.count, 1);
  assert.ok(metrics.transport.p50 >= 20);
  assert.equal(metrics.e2e.count, 1);

  // 8. Reconnection Simulation (Increment generation)
  const nextGen = session.nextGeneration();
  assert.equal(nextGen, 2);

  // 9. Clean Idempotent Shutdown
  signalingClient.close();
  await signalingServer.close();
  await peerManager.close();
  await session.close();

  assert.equal(session.state.current, SESSION_STATES.STOPPED);
  assert.equal(store.get(session.id), null);
});
