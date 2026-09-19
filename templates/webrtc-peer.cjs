// flutter-remote-template-version: 2
/**
 * flutter-remote WebRTC & WebSocket Bridge.
 *
 * 1. Bridges WebRTC DataChannel HID messages directly to serve-sim's local /ws endpoint.
 * 2. Provides a zero-buffering /stream-ws endpoint that listens for simulator frame
 *    changes and pushes raw JPEG frames directly over WebSocket.
 */
const http = require('node:http');

let PeerConnection;
let WebSocket;
let WebSocketServer;

try {
  const ndc = require('node-datachannel');
  PeerConnection = ndc.PeerConnection;
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
const TARGET_HOST = '127.0.0.1';

process.on('uncaughtException', (err) => {
  console.error('[webrtc-peer uncaughtException]', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[webrtc-peer unhandledRejection]', reason);
});

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, peer: 'running', targetPort: PREVIEW_PORT }));
    return;
  }
  res.writeHead(404);
  res.end();
});

if (WebSocketServer) {
  const wss = new WebSocketServer({ server });

  // ─── Stream WebSocket: Listen for simulator changes & broadcast JPEGs ───
  const streamWsClients = new Set();
  let localStreamReq = null;

  function ensureLocalStream() {
    if (localStreamReq || streamWsClients.size === 0) return;

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

            // Broadcast raw JPEG frame to all connected WebSocket clients
            for (const client of streamWsClients) {
              if (client.readyState === 1 /* OPEN */) {
                try {
                  client.send(jpeg);
                } catch {}
              }
            }

            buffer = buffer.subarray(eoi + 2);
            soi = buffer.indexOf(Buffer.from([0xff, 0xd8]));
          }

          // Safeguard against memory leak if no valid JPEG boundary found
          if (buffer.length > 5 * 1024 * 1024) {
            buffer = Buffer.alloc(0);
          }
        });

        res.on('end', () => {
          localStreamReq = null;
          if (streamWsClients.size > 0) {
            setTimeout(ensureLocalStream, 1000);
          }
        });

        res.on('error', (err) => {
          console.error('[webrtc-peer local stream error]', err.message);
          localStreamReq = null;
          if (streamWsClients.size > 0) {
            setTimeout(ensureLocalStream, 1000);
          }
        });
      }
    );

    localStreamReq.on('error', (err) => {
      console.error('[webrtc-peer local stream request error]', err.message);
      localStreamReq = null;
      if (streamWsClients.size > 0) {
        setTimeout(ensureLocalStream, 1000);
      }
    });
  }

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');

    // Handle /stream-ws: Change-only socket frame streaming
    if (url.pathname === '/stream-ws') {
      console.log('[webrtc-peer] Client connected to /stream-ws');
      streamWsClients.add(ws);
      ensureLocalStream();

      ws.on('close', () => {
        streamWsClients.delete(ws);
        if (streamWsClients.size === 0 && localStreamReq) {
          try {
            localStreamReq.destroy();
          } catch {}
          localStreamReq = null;
        }
      });
      return;
    }

    // Handle /signal: WebRTC DataChannel signaling
    console.log('[webrtc-peer] Client connected to signaling');
    let peer = null;
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

          const rawIceServers = Array.isArray(msg.iceServers) && msg.iceServers.length > 0
            ? msg.iceServers
            : ['stun:stun.cloudflare.com:3478'];

          // Normalize iceServers format for node-datachannel
          const iceServers = [];
          for (const item of rawIceServers) {
            if (typeof item === 'string') {
              iceServers.push(item);
            } else if (item && typeof item === 'object') {
              const urls = item.urls || item.url;
              if (Array.isArray(urls)) {
                for (const u of urls) {
                  if (item.username && item.credential) {
                    iceServers.push({ urls: u, username: item.username, credential: item.credential });
                  } else {
                    iceServers.push(u);
                  }
                }
              } else if (urls) {
                if (item.username && item.credential) {
                  iceServers.push({ urls, username: item.username, credential: item.credential });
                } else {
                  iceServers.push(urls);
                }
              }
            }
          }

          peer = new PeerConnection('serve-sim-peer', { iceServers });

          peer.onLocalDescription((sdp, type) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type, sdp }));
            }
          });

          peer.onLocalCandidate((candidate, mid) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'candidate', candidate: { candidate, sdpMid: mid } }));
            }
          });

          peer.onDataChannel((dc) => {
            console.log('[webrtc-peer] DataChannel opened:', dc.getLabel ? dc.getLabel() : 'hid');
            const simWs = getServeSimWs();

            dc.onMessage((hidMsg) => {
              if (simWs.readyState === WebSocket.OPEN) {
                simWs.send(hidMsg);
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

          peer.setRemoteDescription(msg.sdp, 'offer');
        } else if (msg.type === 'candidate' && peer) {
          if (msg.candidate && msg.candidate.candidate) {
            const mid = msg.candidate.sdpMid || '0';
            peer.addRemoteCandidate(msg.candidate.candidate, mid);
          }
        }
      } catch (err) {
        console.error('[webrtc-peer signaling message error]', err.message);
      }
    });

    ws.on('close', () => {
      console.log('[webrtc-peer] Client disconnected from signaling');
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
  console.log(`[webrtc-peer] listening on ${TARGET_HOST}:${SIGNAL_PORT} -> serve-sim :${PREVIEW_PORT}`);
});
