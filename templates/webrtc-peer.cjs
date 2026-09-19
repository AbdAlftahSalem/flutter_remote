// flutter-remote-template-version: 4
/**
 * flutter-remote WebRTC V2 & Legacy Bridge.
 *
 * 1. WebRTC Video Track (H.264/VP8) streaming frames directly to browser <video>.
 * 2. WebRTC DataChannels (input, keyboard, control, telemetry) for low-latency HID.
 * 3. Connection-ready serve-sim WebSocket adapter with safe queueing and flush on OPEN.
 * 4. Fallback /stream-ws endpoint for change-only socket streaming in legacy mode.
 */
const http = require('node:http');

let ndc;
let PeerConnection;
let Video;
let H264RtpPacketizer;
let RtpPacketizationConfig;
let WebSocket;
let WebSocketServer;

try {
  ndc = require('node-datachannel');
  PeerConnection = ndc.PeerConnection;
  Video = ndc.Video;
  H264RtpPacketizer = ndc.H264RtpPacketizer;
  RtpPacketizationConfig = ndc.RtpPacketizationConfig;
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

// RFC 6184 / Annex-B NAL unit parser and packetizer
class H264Packetizer {
  constructor(payloadType = 98, ssrc = 12345, mtu = 1200) {
    this.payloadType = payloadType;
    this.ssrc = ssrc;
    this.mtu = mtu;
    this.seq = 1;
    this.ts = 0;
    this.cachedSps = null;
    this.cachedPps = null;
    this.cachedKeyframe = null;
  }

  parseNals(buf) {
    if (!Buffer.isBuffer(buf) || buf.length === 0) return [];
    const nals = [];
    const len = buf.length;
    const indices = [];

    for (let i = 0; i < len - 2; i++) {
      if (buf[i] === 0x00 && buf[i + 1] === 0x00) {
        if (buf[i + 2] === 0x01) {
          indices.push({ idx: i, pLen: 3 });
          i += 2;
        } else if (i < len - 3 && buf[i + 2] === 0x00 && buf[i + 3] === 0x01) {
          indices.push({ idx: i, pLen: 4 });
          i += 3;
        }
      }
    }

    if (indices.length === 0) {
      return [{ data: buf, type: buf[0] & 0x1f }];
    }

    for (let k = 0; k < indices.length; k++) {
      const cur = indices[k];
      const start = cur.idx + cur.pLen;
      const end = (k + 1 < indices.length) ? indices[k + 1].idx : len;
      const nal = buf.subarray(start, end);
      if (nal.length > 0) {
        nals.push({ data: nal, type: nal[0] & 0x1f });
      }
    }
    return nals;
  }

  inspectNals(nals) {
    let isKey = false;
    for (const n of nals) {
      if (n.type === 7) this.cachedSps = Buffer.from(n.data);
      else if (n.type === 8) this.cachedPps = Buffer.from(n.data);
      else if (n.type === 5) isKey = true;
    }

    if (isKey) {
      const pfx = Buffer.from([0x00, 0x00, 0x00, 0x01]);
      const parts = [];
      if (this.cachedSps) parts.push(pfx, this.cachedSps);
      if (this.cachedPps) parts.push(pfx, this.cachedPps);
      for (const n of nals) {
        if (n.type === 5) parts.push(pfx, n.data);
      }
      this.cachedKeyframe = Buffer.concat(parts);
    }
  }

  packetize(buf, fps = 30) {
    if (!Buffer.isBuffer(buf) || buf.length === 0) return [];
    this.ts = (this.ts + Math.round(90000 / fps)) >>> 0;

    const nals = this.parseNals(buf);
    if (nals.length > 0) this.inspectNals(nals);

    const packets = [];
    const maxPayload = this.mtu - 12;
    const units = nals.length > 0 ? nals : [{ data: buf, type: buf[0] & 0x1f }];

    for (let u = 0; u < units.length; u++) {
      const nal = units[u];
      const nalData = nal.data;
      const isLastNal = (u === units.length - 1);

      if (nalData.length <= maxPayload) {
        const rtp = Buffer.alloc(12 + nalData.length);
        rtp[0] = 0x80;
        rtp[1] = (isLastNal ? 0x80 : 0x00) | (this.payloadType & 0x7f);
        rtp.writeUInt16BE(this.seq & 0xffff, 2);
        this.seq = (this.seq + 1) & 0xffff;
        rtp.writeUInt32BE(this.ts, 4);
        rtp.writeUInt32BE(this.ssrc, 8);
        nalData.copy(rtp, 12);
        packets.push(rtp);
      } else {
        const nalHeader = nalData[0];
        const fnri = nalHeader & 0xe0;
        const origType = nalHeader & 0x1f;
        const fuIndicator = fnri | 28; // FU-A
        const payloadData = nalData.subarray(1);
        const maxFu = maxPayload - 2;
        const total = Math.ceil(payloadData.length / maxFu);

        for (let i = 0; i < total; i++) {
          const isStart = (i === 0);
          const isEnd = (i === total - 1);
          let fuHeader = origType & 0x1f;
          if (isStart) fuHeader |= 0x80;
          if (isEnd) fuHeader |= 0x40;

          const s = i * maxFu;
          const e = Math.min(s + maxFu, payloadData.length);
          const chunk = payloadData.subarray(s, e);

          const rtp = Buffer.alloc(12 + 2 + chunk.length);
          rtp[0] = 0x80;
          rtp[1] = (isLastNal && isEnd ? 0x80 : 0x00) | (this.payloadType & 0x7f);
          rtp.writeUInt16BE(this.seq & 0xffff, 2);
          this.seq = (this.seq + 1) & 0xffff;
          rtp.writeUInt32BE(this.ts, 4);
          rtp.writeUInt32BE(this.ssrc, 8);
          rtp[12] = fuIndicator;
          rtp[13] = fuHeader;
          chunk.copy(rtp, 14);
          packets.push(rtp);
        }
      }
    }
    return packets;
  }
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
  const h264Packetizer = new H264Packetizer(98, 12345, 1200);

  function ensureLocalStream() {
    if (localStreamReq || (streamWsClients.size === 0 && activeVideoTracks.size === 0)) return;

    console.log('[webrtc-peer] Starting local stream consumer from serve-sim');
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
              const rtpPackets = h264Packetizer.packetize(jpeg, 30);
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
    let serveSimQueue = [];
    let serveSimConnecting = false;

    // Connection-ready serve-sim socket with queueing and flush on open
    function sendToServeSim(msg) {
      if (serveSimWs && serveSimWs.readyState === WebSocket.OPEN) {
        try {
          serveSimWs.send(msg);
          return;
        } catch {}
      }

      // If connecting, queue critical events and coalesce moves
      if (serveSimQueue.length < 500) {
        try {
          const parsed = JSON.parse(typeof msg === 'string' ? msg : msg.toString());
          if (parsed.event === 'move' || parsed.type === 'pointer_move') {
            // Replace previous pending move to avoid queue buildup
            const lastIdx = serveSimQueue.findLastIndex((item) => {
              try {
                const p = JSON.parse(typeof item === 'string' ? item : item.toString());
                return p.event === 'move' || p.type === 'pointer_move';
              } catch { return false; }
            });
            if (lastIdx !== -1) {
              serveSimQueue[lastIdx] = msg;
              return;
            }
          }
        } catch {}
        serveSimQueue.push(msg);
      }

      initServeSimWs();
    }

    function initServeSimWs() {
      if (serveSimConnecting || (serveSimWs && serveSimWs.readyState === WebSocket.OPEN)) return;
      serveSimConnecting = true;

      serveSimWs = new WebSocket(`ws://${TARGET_HOST}:${PREVIEW_PORT}/ws`);

      serveSimWs.on('open', () => {
        serveSimConnecting = false;
        console.log('[webrtc-peer] Connected to serve-sim /ws, flushing queue of', serveSimQueue.length);
        while (serveSimQueue.length > 0 && serveSimWs.readyState === WebSocket.OPEN) {
          const m = serveSimQueue.shift();
          try { serveSimWs.send(m); } catch {}
        }
      });

      serveSimWs.on('error', (err) => {
        serveSimConnecting = false;
        console.warn('[webrtc-peer -> serve-sim ws error]', err.message);
      });

      serveSimWs.on('close', () => {
        serveSimConnecting = false;
      });
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

              // Configure native H.264 packetizer if available
              if (H264RtpPacketizer && RtpPacketizationConfig) {
                try {
                  const rtpCfg = new RtpPacketizationConfig(12345, 'video', 98, 90000);
                  const pkt = new H264RtpPacketizer('StartSequence', rtpCfg);
                  videoTrack.setMediaHandler(pkt);
                } catch {}
              }

              activeVideoTracks.add(videoTrack);

              // Send cached keyframe immediately to new subscriber for instant playback (< 2s)
              if (h264Packetizer.cachedKeyframe) {
                const keyPackets = h264Packetizer.packetize(h264Packetizer.cachedKeyframe, 30);
                for (const kp of keyPackets) {
                  try { videoTrack.sendMessageBinary(kp); } catch {}
                }
              }

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
            initServeSimWs();

            dc.onMessage((rawMsg) => {
              // Handle control channel commands
              if (label === 'control') {
                try {
                  const cmd = JSON.parse(rawMsg.toString());
                  if (cmd.type === 'request_keyframe' && videoTrack && h264Packetizer.cachedKeyframe) {
                    const keyPackets = h264Packetizer.packetize(h264Packetizer.cachedKeyframe, 30);
                    for (const kp of keyPackets) {
                      try { videoTrack.sendMessageBinary(kp); } catch {}
                    }
                    return;
                  }
                } catch {}
              }

              sendToServeSim(rawMsg);
            });

            if (serveSimWs) {
              serveSimWs.on('message', (simMsg) => {
                try {
                  if (typeof dc.sendMessageBinary === 'function' && Buffer.isBuffer(simMsg)) {
                    dc.sendMessageBinary(simMsg);
                  } else if (typeof dc.sendMessage === 'function') {
                    dc.sendMessage(simMsg);
                  }
                } catch {}
              });
            }
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
      serveSimQueue = [];
      serveSimConnecting = false;
    });
  });
}

server.listen(SIGNAL_PORT, TARGET_HOST, () => {
  console.log(`[webrtc-peer] listening on ${TARGET_HOST}:${SIGNAL_PORT} -> serve-sim :${PREVIEW_PORT} (mode: ${TRANSPORT_MODE})`);
});
