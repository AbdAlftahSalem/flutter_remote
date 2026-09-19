// flutter-remote-template-version: 3
/**
 * flutter-remote WebRTC V2 & Legacy Bridge.
 *
 * 1. WebRTC Video Track (H.264/VP8) streaming frames directly to browser <video>.
 * 2. WebRTC DataChannels (input, keyboard, control, telemetry) for low-latency HID.
 * 3. Fallback /stream-ws endpoint for change-only socket streaming in legacy mode.
 */
const http = require('node:http');

let ndc;
let PeerConnection;
let Video;
let WebSocket;
let WebSocketServer;

try {
  ndc = require('node-datachannel');
  PeerConnection = ndc.PeerConnection;
  Video = ndc.Video;
} catch (e) {
  console.error('[webrtc-peer] node-datachannel not found:', e.message);
}

try {
  const wsPkg = require('ws');
  WebSocket = wsPkg.WebSocket || wsPkg;
  WebSocketServer = wsPkg.WebSocketServer;
} catch (e) {
  console.error('[webrtc-peer] ws package not found:', e.message);
}

const PREVIEW_PORT = Number(process.env.FLUTTER_REMOTE_TARGET_PORT || process.env.PREVIEW_PORT || 3200);
const SIGNAL_PORT = Number(process.env.FLUTTER_REMOTE_WEBRTC_SIGNAL_PORT || 3201);
const TRANSPORT_MODE = process.env.FLUTTER_REMOTE_TRANSPORT || 'webrtc';
const TARGET_HOST = '127.0.0.1';

process.on('uncaughtException', (err) => {
  console.error('[webrtc-peer uncaughtException]', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[webrtc-peer unhandledRejection]', reason);
});

// Simple RTP packetizer for video frames
function packetizeFrame(frameBuffer, payloadType = 98, ssrc = 12345, seqState = { seq: 1, ts: 0 }) {
  const mtu = 1200;
  const payloadSize = mtu - 12;
  const totalChunks = Math.ceil(frameBuffer.length / payloadSize);
  const packets = [];

  seqState.ts = (seqState.ts + 3000) >>> 0;

  for (let i = 0; i < totalChunks; i++) {
    const isLast = (i === totalChunks - 1);
    const start = i * payloadSize;
    const end = Math.min(start + payloadSize, frameBuffer.length);
    const chunk = frameBuffer.subarray(start, end);

    const rtp = Buffer.alloc(12 + chunk.length);
    rtp[0] = 0x80;
    rtp[1] = (isLast ? 0x80 : 0x00) | (payloadType & 0x7f);
    rtp.writeUInt16BE(seqState.seq & 0xffff, 2);
    seqState.seq = (seqState.seq + 1) & 0xffff;
    rtp.writeUInt32BE(seqState.ts, 4);
    rtp.writeUInt32BE(ssrc, 8);
    chunk.copy(rtp, 12);
    packets.push(rtp);
  }
  return packets;
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, peer: 'running', mode: TRANSPORT_MODE, targetPort: PREVIEW_PORT }));
    return;
  }
  res.writeHead(404);
  res.end();
});

if (WebSocketServer) {
  const wss = new WebSocketServer({ server });

  const streamWsClients = new Set();
  const activeVideoTracks = new Set();
  let localStreamReq = null;
  const rtpSeqState = { seq: 1, ts: 0 };

  function ensureLocalStream() {
    if (localStreamReq || (streamWsClients.size === 0 && activeVideoTracks.size === 0)) return;

    console.log('[webrtc-peer] Starting local MJPEG stream consumer from serve-sim');
    localStreamReq = http.get(
      {
        host: TARGET_HOST,
        port: PREVIEW_PORT,
        path: '/stream',
        headers: { 'Accept-Encoding': 'identity' },
      },
      (res) => {
        let buffer = Buffer.alloc(0);

        res.on('data', (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);

          let soi = buffer.indexOf(Buffer.from([0xff, 0xd8]));
          while (soi !== -1) {
            const eoi = buffer.indexOf(Buffer.from([0xff, 0xd9]), soi + 2);
            if (eoi === -1) break;

            const jpeg = buffer.subarray(soi, eoi + 2);

            // 1. Broadcast raw JPEG to WebSocket clients (legacy fallback)
            for (const client of streamWsClients) {
              if (client.readyState === 1 /* OPEN */) {
                try { client.send(jpeg); } catch {}
              }
            }

            // 2. Packetize and send to WebRTC video tracks
            if (activeVideoTracks.size > 0) {
              const rtpPackets = packetizeFrame(jpeg, 98, 12345, rtpSeqState);
              for (const track of activeVideoTracks) {
                try {
                  for (const packet of rtpPackets) {
                    track.sendMessageBinary(packet);
                  }
                } catch {}
              }
            }

            buffer = buffer.subarray(eoi + 2);
            soi = buffer.indexOf(Buffer.from([0xff, 0xd8]));
          }

          if (buffer.length > 5 * 1024 * 1024) {
            buffer = Buffer.alloc(0);
          }
        });

        res.on('end', () => {
          localStreamReq = null;
          if (streamWsClients.size > 0 || activeVideoTracks.size > 0) {
            setTimeout(ensureLocalStream, 1000);
          }
        });

        res.on('error', (err) => {
          console.error('[webrtc-peer local stream error]', err.message);
          localStreamReq = null;
          if (streamWsClients.size > 0 || activeVideoTracks.size > 0) {
            setTimeout(ensureLocalStream, 1000);
          }
        });
      }
    );

    localStreamReq.on('error', (err) => {
      console.error('[webrtc-peer local stream request error]', err.message);
      localStreamReq = null;
      if (streamWsClients.size > 0 || activeVideoTracks.size > 0) {
        setTimeout(ensureLocalStream, 1000);
      }
    });
  }

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');

    // Handle /stream-ws: Change-only socket frame streaming (legacy fallback)
    if (url.pathname === '/stream-ws') {
      console.log('[webrtc-peer] Client connected to /stream-ws');
      streamWsClients.add(ws);
      ensureLocalStream();

      ws.on('close', () => {
        streamWsClients.delete(ws);
        if (streamWsClients.size === 0 && activeVideoTracks.size === 0 && localStreamReq) {
          try { localStreamReq.destroy(); } catch {}
          localStreamReq = null;
        }
      });
      return;
    }

    // Handle /signal: WebRTC Media & DataChannel signaling
    console.log('[webrtc-peer] Client connected to signaling');
    let peer = null;
    let videoTrack = null;
    let serveSimWs = null;

    function getServeSimWs() {
      if (serveSimWs && serveSimWs.readyState === WebSocket.OPEN) {
        return serveSimWs;
      }
      serveSimWs = new WebSocket(`ws://${TARGET_HOST}:${PREVIEW_PORT}/ws`);
      serveSimWs.on('error', (err) => {
        console.error('[webrtc-peer -> serve-sim ws error]', err.message);
      });
      return serveSimWs;
    }

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'offer') {
          if (!PeerConnection) {
            console.error('[webrtc-peer] Cannot create peer: node-datachannel unavailable');
            return;
          }

          const rawIceServers = (msg.payload && msg.payload.iceServers) || msg.iceServers || ['stun:stun.cloudflare.com:3478'];
          const iceServers = [];
          for (const item of rawIceServers) {
            if (typeof item === 'string') {
              iceServers.push(item);
            } else if (item && typeof item === 'object') {
              const urls = item.urls || item.url;
              if (Array.isArray(urls)) {
                for (const u of urls) {
                  iceServers.push(item.username && item.credential ? { urls: u, username: item.username, credential: item.credential } : u);
                }
              } else if (urls) {
                iceServers.push(item.username && item.credential ? { urls, username: item.username, credential: item.credential } : urls);
              }
            }
          }

          peer = new PeerConnection('serve-sim-peer', { iceServers });

          // Add Video track in V2 mode
          if (Video && TRANSPORT_MODE !== 'v1') {
            try {
              const video = new Video('video', 'SendOnly');
              video.addH264Codec(98);
              video.addVP8Codec(97);
              videoTrack = peer.addTrack(video);
              activeVideoTracks.add(videoTrack);
              ensureLocalStream();
            } catch (err) {
              console.warn('[webrtc-peer video track error]', err.message);
            }
          }

          peer.onLocalDescription((sdp, type) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                v: 2,
                type,
                generation: msg.generation || 1,
                payload: { sdp },
              }));
            }
          });

          peer.onLocalCandidate((candidate, mid) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                v: 2,
                type: 'ice-candidate',
                generation: msg.generation || 1,
                payload: { candidate, sdpMid: mid },
              }));
            }
          });

          peer.onDataChannel((dc) => {
            const label = dc.getLabel ? dc.getLabel() : 'input';
            console.log('[webrtc-peer] DataChannel opened:', label);
            const simWs = getServeSimWs();

            dc.onMessage((rawMsg) => {
              if (simWs.readyState === WebSocket.OPEN) {
                simWs.send(rawMsg);
              }
            });

            simWs.on('message', (simMsg) => {
              try {
                if (typeof dc.sendMessageBinary === 'function' && Buffer.isBuffer(simMsg)) {
                  dc.sendMessageBinary(simMsg);
                } else if (typeof dc.sendMessage === 'function') {
                  dc.sendMessage(simMsg);
                }
              } catch {}
            });
          });

          const offerSdp = (msg.payload && msg.payload.sdp) || msg.sdp;
          peer.setRemoteDescription(offerSdp, 'offer');
        } else if ((msg.type === 'ice-candidate' || msg.type === 'candidate') && peer) {
          const candidateData = msg.payload || msg.candidate;
          if (candidateData && candidateData.candidate) {
            const mid = candidateData.sdpMid || '0';
            peer.addRemoteCandidate(candidateData.candidate, mid);
          }
        }
      } catch (err) {
        console.error('[webrtc-peer signaling error]', err.message);
      }
    });

    ws.on('close', () => {
      console.log('[webrtc-peer] Client disconnected from signaling');
      if (videoTrack) {
        activeVideoTracks.delete(videoTrack);
        videoTrack = null;
      }
      if (peer) {
        try { peer.close(); } catch {}
        peer = null;
      }
      if (serveSimWs) {
        try { serveSimWs.close(); } catch {}
        serveSimWs = null;
      }
    });
  });
}

server.listen(SIGNAL_PORT, TARGET_HOST, () => {
  console.log(`[webrtc-peer] listening on ${TARGET_HOST}:${SIGNAL_PORT} -> serve-sim :${PREVIEW_PORT} (mode: ${TRANSPORT_MODE})`);
});
