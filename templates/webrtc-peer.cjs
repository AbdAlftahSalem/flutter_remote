// flutter-remote-template-version: 4
/**
 * flutter-remote WebRTC V3 Thin Peer Bridge Bootstrap.
 *
 * Modular architecture:
 *   1. VideoEncoder & RtpPacketizer: H.264 encoding & RFC 6184 packetization
 *   2. ServeSimConsumer: MJPEG stream consumption & WebSocket bridge
 *   3. PeerSession: RTCPeerConnection & DataChannels (input, keyboard, control, telemetry)
 *   4. ServerMetrics: Real-time pipeline observability
 */

const http = require('node:http');
const { VideoEncoder } = require('./peer/VideoEncoder.cjs');
const { ServeSimConsumer } = require('./peer/ServeSimConsumer.cjs');
const { PeerSession } = require('./peer/PeerSession.cjs');
const { ServerMetrics } = require('./peer/Metrics.cjs');

let ndc;
let PeerConnection;
let Video;

try {
  ndc = require('node-datachannel');
  PeerConnection = ndc.PeerConnection;
  Video = ndc.Video;
} catch (e) {
  console.error('[webrtc-peer] node-datachannel not found:', e.message);
}

let WebSocket;
let WebSocketServer;

try {
  const wsPkg = require('ws');
  WebSocket = wsPkg.WebSocket || wsPkg;
  WebSocketServer = wsPkg.WebSocketServer;
} catch (e) {
  console.error('[webrtc-peer] ws package not found:', e.message);
}

const PREVIEW_PORT = Number(process.env.FLUTTER_REMOTE_TARGET_PORT || process.env.PREVIEW_PORT || 3200);
const STREAM_PATH = process.env.FLUTTER_REMOTE_STREAM_PATH || '/stream.mjpeg?raw=1';
const SIGNAL_PORT = Number(process.env.FLUTTER_REMOTE_WEBRTC_SIGNAL_PORT || 3201);
const TRANSPORT_MODE = process.env.FLUTTER_REMOTE_TRANSPORT || 'webrtc';
const TARGET_HOST = '127.0.0.1';

process.on('uncaughtException', (err) => {
  console.error('[webrtc-peer uncaughtException]', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[webrtc-peer unhandledRejection]', reason);
});

// Create video encoder
const videoEncoder = new VideoEncoder({ payloadType: 98, ssrc: 12345, mtu: 1200, fps: 30 });
const serverMetrics = new ServerMetrics();

const streamWsClients = new Set();
const activeVideoTracks = new Set();

// Broadcast encoded RTP packets to all active WebRTC video tracks
videoEncoder.on('packets', (rtpPackets) => {
  serverMetrics.rtp.packetsSent += rtpPackets.length;
  serverMetrics.rtp.framesPacketized++;
  for (const track of activeVideoTracks) {
    try {
      for (const packet of rtpPackets) {
        track.sendMessageBinary(packet);
      }
    } catch {}
  }
});

// Setup serve-sim MJPEG consumer & WebSocket bridge
const serveSimConsumer = new ServeSimConsumer({
  targetHost: TARGET_HOST,
  previewPort: PREVIEW_PORT,
  streamPath: STREAM_PATH,
  videoEncoder,
  streamWsClients,
  activeVideoTracks,
  WebSocketClass: WebSocket,
});

// Helper to configure Video track with H264 & VP8
function createVideoTrack(peer) {
  if (!Video) return null;
  const video = new Video('video', 'SendOnly');
  video.addH264Codec(98);
  video.addVP8Codec(97);
  return peer.addTrack(video);
}

// HTTP Server
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, peer: 'running', mode: TRANSPORT_MODE, targetPort: PREVIEW_PORT }));
    return;
  }
  if (req.url === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(serverMetrics.getSnapshot()));
    return;
  }
  res.writeHead(404);
  res.end();
});

// WebSocket Server
if (WebSocketServer) {
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');

    // Handle /stream-ws: Change-only socket frame streaming (legacy fallback)
    if (url.pathname === '/stream-ws') {
      console.log('[webrtc-peer] Client connected to /stream-ws');
      streamWsClients.add(ws);
      serveSimConsumer.ensureLocalStream();

      ws.on('close', () => {
        streamWsClients.delete(ws);
        if (streamWsClients.size === 0 && activeVideoTracks.size === 0) {
          serveSimConsumer.close();
        }
      });
      return;
    }

    // Handle /signal: WebRTC Media & DataChannel signaling
    console.log('[webrtc-peer] WebRTC client connected');
    serverMetrics.sessions++;
    serverMetrics.connectedSessions++;

    const session = new PeerSession({
      ws,
      ndc: { PeerConnection, Video },
      videoEncoder,
      serveSimConsumer,
      activeVideoTracks,
      transportMode: TRANSPORT_MODE,
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'offer') {
          session.handleOffer(msg);
        } else if (msg.type === 'ice-candidate' || msg.type === 'candidate') {
          session.handleCandidate(msg);
        }
      } catch (err) {
        console.error('[webrtc-peer signaling error]', err.message);
      }
    });

    ws.on('close', () => {
      console.log('[webrtc-peer] Client disconnected from signaling');
      serverMetrics.connectedSessions = Math.max(0, serverMetrics.connectedSessions - 1);
      session.close();

      if (activeVideoTracks.size === 0 && streamWsClients.size === 0) {
        videoEncoder.close();
        serveSimConsumer.close();
      }
    });
  });
}

// Graceful shutdown
function shutdown(signal) {
  console.log(`[webrtc-peer] shutting down on ${signal}`);
  videoEncoder.close();
  serveSimConsumer.close();
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(SIGNAL_PORT, TARGET_HOST, () => {
  console.log(`[webrtc-peer] listening on ${TARGET_HOST}:${SIGNAL_PORT}`);
  console.log(`[webrtc-peer] target serve-sim: ${TARGET_HOST}:${PREVIEW_PORT}`);
  console.log(`[webrtc-peer] stream path: ${STREAM_PATH}`);
});
