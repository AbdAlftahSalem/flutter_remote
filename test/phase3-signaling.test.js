import test from 'node:test';
import assert from 'node:assert/strict';
import { SignalingProtocol, SIGNALING_TYPES } from '../src/signaling/SignalingProtocol.js';
import { OfferHandler } from '../src/signaling/OfferHandler.js';
import { IceHandler } from '../src/signaling/IceHandler.js';
import { SignalingServer } from '../src/signaling/SignalingServer.js';
import { SignalingClient } from '../src/signaling/SignalingClient.js';
import { SessionStore } from '../src/session/SessionStore.js';
import { Session } from '../src/session/SessionManager.js';

test('Phase 3: SignalingProtocol message envelope & stale generation rejection', () => {
  const offerMsg = SignalingProtocol.createOffer('sess-100', 3, 'v=0\r\nm=video 9 ...');
  assert.equal(offerMsg.v, 2);
  assert.equal(offerMsg.type, 'offer');
  assert.equal(offerMsg.sessionId, 'sess-100');
  assert.equal(offerMsg.generation, 3);
  assert.ok(offerMsg.payload.sdp);

  const serialized = JSON.stringify(offerMsg);

  // Parsing when generation 3 is active -> accepted
  const res3 = SignalingProtocol.parse(serialized, 3);
  assert.equal(res3.isStale, false);
  assert.equal(res3.message.type, 'offer');

  // Parsing when generation 4 is active -> rejected as stale
  const res4 = SignalingProtocol.parse(serialized, 4);
  assert.equal(res4.isStale, true);
  assert.ok(res4.reason.includes('Stale generation 3'));
});

test('Phase 3: OfferHandler SDP validation', () => {
  const sdpWithBoth = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 98\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel';
  const res = OfferHandler.validateOffer(sdpWithBoth);
  assert.ok(res.valid);
  assert.ok(res.hasVideo);
  assert.ok(res.hasDataChannel);

  assert.throws(() => OfferHandler.validateOffer('invalid sdp'), (err) => err.message.includes('missing v=0'));
});

test('Phase 3: IceHandler candidate buffering and flushing', () => {
  const mockPeer = {
    applied: [],
    addRemoteCandidate(c, mid) {
      this.applied.push({ c, mid });
    },
  };

  const handler = new IceHandler(mockPeer, { generation: 2 });

  // Add candidate before remote description is ready -> buffered
  const added1 = handler.handleCandidate({ candidate: 'cand-1', sdpMid: '0' }, 2);
  assert.ok(added1);
  assert.equal(handler.bufferedCount, 1);
  assert.equal(mockPeer.applied.length, 0);

  // Stale generation candidate -> dropped immediately
  const addedStale = handler.handleCandidate({ candidate: 'cand-stale', sdpMid: '0' }, 1);
  assert.equal(addedStale, false);
  assert.equal(handler.bufferedCount, 1);

  // Mark remote description ready -> flushes buffer
  handler.setRemoteDescriptionReady();
  assert.equal(handler.bufferedCount, 0);
  assert.equal(mockPeer.applied.length, 1);
  assert.equal(mockPeer.applied[0].c, 'cand-1');

  // Subsequent candidate applied immediately
  handler.handleCandidate({ candidate: 'cand-2', sdpMid: '0' }, 2);
  assert.equal(mockPeer.applied.length, 2);
  assert.equal(mockPeer.applied[1].c, 'cand-2');
});

test('Phase 3: SignalingServer + SignalingClient end-to-end communication', async () => {
  const store = new SessionStore();
  const session = new Session({ id: 'test-session-e2e', durationMinutes: 5, store });
  store.register(session);

  const serverPort = 39871;
  const server = new SignalingServer({ port: serverPort, store });
  server.start();

  let serverReceivedOffer = false;
  let clientReceivedAnswer = false;

  server.on('offer', ({ ws, sessionId, message }) => {
    serverReceivedOffer = true;
    const answer = SignalingProtocol.createAnswer(sessionId, message.generation, 'v=0\r\nm=video answer');
    ws.send(JSON.stringify(answer));
  });

  const client = new SignalingClient({
    url: `ws://127.0.0.1:${serverPort}/signal`,
    sessionId: session.id,
    token: session.token,
    generation: 1,
  });

  await client.connect();

  const exchangePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Signaling exchange timed out')), 5000);

    client.on('answer', (msg) => {
      clientReceivedAnswer = true;
      assert.ok(msg.payload.sdp.includes('answer'));
      clearTimeout(timeout);
      resolve();
    });

    client.sendOffer('v=0\r\nm=video offer');
  });

  await exchangePromise;

  assert.ok(serverReceivedOffer, 'Server must receive offer');
  assert.ok(clientReceivedAnswer, 'Client must receive answer');

  client.close();
  await server.close();
});
