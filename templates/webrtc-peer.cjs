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
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

let ffmpegPath = null;
try {
  ffmpegPath = require('ffmpeg-static');
} catch {}
if (!ffmpegPath) {
  ffmpegPath = 'ffmpeg';
}

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

// RFC 6184 / Annex-B H.264 Video Encoder & RTP Packetizer
const NAL_TYPES = {
  NON_IDR: 1,
  IDR: 5,
  SEI: 6,
  SPS: 7,
  PPS: 8,
  FU_A: 28,
};

class VideoEncoder extends EventEmitter {
  constructor(options = {}) {
    super();
    this.payloadType = options.payloadType || 98;
    this.ssrc = options.ssrc || 12345;
    this.mtu = options.mtu || 1200;
    this.fps = options.fps || 30;
    this.bitrateKbps = options.bitrateKbps || 2500;
    this.ffmpegPath = options.ffmpegPath || ffmpegPath;

    this._sequenceNumber = 1;
    this._timestamp = 0;
    this._clockRate = 90000;

    this.cachedSps = null;
    this.cachedPps = null;
    this.cachedKeyframe = null;
    this.lastFrameType = null;

    this.ffmpegProc = null;
    this._nalBuffer = Buffer.alloc(0);
    this._isEncoding = false;
  }

  start() {
    if (this.ffmpegProc) return;

    const args = [
      '-loglevel', 'error',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-i', 'pipe:0',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-pix_fmt', 'yuv420p',
      '-g', String(this.fps),
      '-keyint_min', String(this.fps),
      '-b:v', `${this.bitrateKbps}k`,
      '-maxrate', `${this.bitrateKbps}k`,
      '-bufsize', `${this.bitrateKbps * 2}k`,
      '-f', 'h264',
      'pipe:1',
    ];

    try {
      this.ffmpegProc = spawn(this.ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      this._isEncoding = true;

      this.ffmpegProc.stdout.on('data', (chunk) => {
        this._handleEncodedData(chunk);
      });

      this.ffmpegProc.stderr.on('data', (errData) => {
        const msg = errData.toString();
        if (!msg.includes('deprecated') && !msg.includes('EOI missing')) {
          console.warn('[webrtc-peer encoder warning]', msg);
        }
      });

      this.ffmpegProc.on('error', (err) => {
        console.error('[webrtc-peer encoder error]', err.message);
        this.close();
      });

      this.ffmpegProc.on('close', (code) => {
        this._isEncoding = false;
        this.ffmpegProc = null;
      });
    } catch (err) {
      console.error('[webrtc-peer encoder spawn error]', err.message);
      this._isEncoding = false;
    }
  }

  encodeFrame(jpegBuffer) {
    if (!this.ffmpegProc || !this.ffmpegProc.stdin || !this.ffmpegProc.stdin.writable) {
      this.start();
    }

    if (this.ffmpegProc && this.ffmpegProc.stdin && this.ffmpegProc.stdin.writable) {
      try {
        this.ffmpegProc.stdin.write(jpegBuffer);
        return true;
      } catch (err) {
        console.error('[webrtc-peer encodeFrame error]', err.message);
        return false;
      }
    }
    return false;
  }

  _handleEncodedData(chunk) {
    this._nalBuffer = Buffer.concat([this._nalBuffer, chunk]);

    const nalUnits = this.parseNalUnits(this._nalBuffer);
    if (nalUnits.length > 1) {
      const completeNals = nalUnits.slice(0, -1);
      this.inspectAndCacheNals(completeNals);

      const packets = this.packetizeNalUnits(completeNals, this.fps);
      if (packets.length > 0) {
        this.emit('packets', packets);
      }

      const lastNal = nalUnits[nalUnits.length - 1];
      const prefix = Buffer.from([0x00, 0x00, 0x00, 0x01]);
      this._nalBuffer = Buffer.concat([prefix, lastNal.data]);
    }
  }

  parseNalUnits(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return [];

    const nalUnits = [];
    const len = buffer.length;
    const startIndices = [];

    for (let i = 0; i < len - 2; i++) {
      if (buffer[i] === 0x00 && buffer[i + 1] === 0x00) {
        if (buffer[i + 2] === 0x01) {
          startIndices.push({ index: i, prefixLen: 3 });
          i += 2;
        } else if (i < len - 3 && buffer[i + 2] === 0x00 && buffer[i + 3] === 0x01) {
          startIndices.push({ index: i, prefixLen: 4 });
          i += 3;
        }
      }
    }

    if (startIndices.length === 0) {
      const nalType = buffer[0] & 0x1f;
      return [{ data: buffer, type: nalType }];
    }

    for (let i = 0; i < startIndices.length; i++) {
      const current = startIndices[i];
      const start = current.index + current.prefixLen;
      const end = (i + 1 < startIndices.length) ? startIndices[i + 1].index : len;
      const nalData = buffer.subarray(start, end);

      if (nalData.length > 0) {
        const nalType = nalData[0] & 0x1f;
        nalUnits.push({ data: nalData, type: nalType });
      }
    }

    return nalUnits;
  }

  inspectAndCacheNals(nalUnits) {
    let hasIdr = false;

    for (const nal of nalUnits) {
      if (nal.type === NAL_TYPES.SPS) {
        this.cachedSps = Buffer.from(nal.data);
      } else if (nal.type === NAL_TYPES.PPS) {
        this.cachedPps = Buffer.from(nal.data);
      } else if (nal.type === NAL_TYPES.IDR) {
        hasIdr = true;
      }
    }

    if (hasIdr) {
      this.lastFrameType = 'keyframe';
      const partsWithPrefixes = [];
      const prefix = Buffer.from([0x00, 0x00, 0x00, 0x01]);

      if (this.cachedSps) {
        partsWithPrefixes.push(prefix, this.cachedSps);
      }
      if (this.cachedPps) {
        partsWithPrefixes.push(prefix, this.cachedPps);
      }
      for (const nal of nalUnits) {
        if (nal.type === NAL_TYPES.IDR) {
          partsWithPrefixes.push(prefix, nal.data);
        }
      }

      this.cachedKeyframe = Buffer.concat(partsWithPrefixes);
    } else if (nalUnits.some(n => n.type === NAL_TYPES.NON_IDR)) {
      this.lastFrameType = 'delta';
    }
  }

  hasKeyframe() {
    return Boolean(this.cachedKeyframe && this.cachedKeyframe.length > 0);
  }

  getKeyframe() {
    return this.cachedKeyframe;
  }

  getKeyframePackets() {
    if (!this.hasKeyframe()) return [];
    return this.packetize(this.cachedKeyframe, this.fps);
  }

  packetizeNalUnits(nalUnits, fps = 30) {
    const timestampDelta = Math.round(this._clockRate / fps);
    this._timestamp = (this._timestamp + timestampDelta) >>> 0;

    const packets = [];
    const maxPayloadSize = this.mtu - 12;

    for (let u = 0; u < nalUnits.length; u++) {
      const nal = nalUnits[u];
      const nalData = nal.data;
      const isLastNal = (u === nalUnits.length - 1);

      if (nalData.length <= maxPayloadSize) {
        const rtp = Buffer.alloc(12 + nalData.length);
        rtp[0] = 0x80;
        rtp[1] = (isLastNal ? 0x80 : 0x00) | (this.payloadType & 0x7f);
        rtp.writeUInt16BE(this._sequenceNumber & 0xffff, 2);
        this._sequenceNumber = (this._sequenceNumber + 1) & 0xffff;
        rtp.writeUInt32BE(this._timestamp, 4);
        rtp.writeUInt32BE(this.ssrc, 8);
        nalData.copy(rtp, 12);
        packets.push(rtp);
      } else {
        const nalHeader = nalData[0];
        const fnri = nalHeader & 0xe0;
        const originalType = nalHeader & 0x1f;

        const fuIndicator = fnri | NAL_TYPES.FU_A;
        const payloadData = nalData.subarray(1);
        const maxFuPayload = maxPayloadSize - 2;
        const totalChunks = Math.ceil(payloadData.length / maxFuPayload);

        for (let i = 0; i < totalChunks; i++) {
          const isStart = (i === 0);
          const isEnd = (i === totalChunks - 1);
          const isLastPacketOfFrame = isLastNal && isEnd;

          let fuHeader = originalType & 0x1f;
          if (isStart) fuHeader |= 0x80;
          if (isEnd) fuHeader |= 0x40;

          const chunkStart = i * maxFuPayload;
          const chunkEnd = Math.min(chunkStart + maxFuPayload, payloadData.length);
          const chunk = payloadData.subarray(chunkStart, chunkEnd);

          const rtp = Buffer.alloc(12 + 2 + chunk.length);
          rtp[0] = 0x80;
          rtp[1] = (isLastPacketOfFrame ? 0x80 : 0x00) | (this.payloadType & 0x7f);
          rtp.writeUInt16BE(this._sequenceNumber & 0xffff, 2);
          this._sequenceNumber = (this._sequenceNumber + 1) & 0xffff;
          rtp.writeUInt32BE(this._timestamp, 4);
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

  packetize(frameBuffer, fps = 30) {
    if (!Buffer.isBuffer(frameBuffer) || frameBuffer.length === 0) {
      return [];
    }
    const nalUnits = this.parseNalUnits(frameBuffer);
    if (nalUnits.length > 0) {
      this.inspectAndCacheNals(nalUnits);
    }
    const units = (nalUnits.length > 0) ? nalUnits : [{ data: frameBuffer, type: frameBuffer[0] & 0x1f }];
    return this.packetizeNalUnits(units, fps);
  }

  close() {
    this._isEncoding = false;
    if (this.ffmpegProc) {
      try {
        if (this.ffmpegProc.stdin) this.ffmpegProc.stdin.end();
        this.ffmpegProc.kill('SIGTERM');
      } catch {}
      this.ffmpegProc = null;
    }
    this._nalBuffer = Buffer.alloc(0);
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
  const videoEncoder = new VideoEncoder({ payloadType: 98, ssrc: 12345, mtu: 1200, fps: 30 });

  videoEncoder.on('packets', (rtpPackets) => {
    for (const track of activeVideoTracks) {
      try {
        for (const packet of rtpPackets) {
          track.sendMessageBinary(packet);
        }
      } catch {}
    }
  });

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

            // 2. Feed JPEG into real H.264 VideoEncoder
            if (activeVideoTracks.size > 0) {
              videoEncoder.encodeFrame(jpeg);
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

              // NOTE: Do not call videoTrack.setMediaHandler(...).
              // node-datachannel's setMediaHandler double-packetizes when used with sendMessageBinary.
              // VideoEncoder outputs RFC 6184 RTP packets sent directly via sendMessageBinary().
              activeVideoTracks.add(videoTrack);

              // Send cached keyframe immediately to new subscriber for instant playback (< 2s)
              if (videoEncoder.hasKeyframe()) {
                const keyPackets = videoEncoder.getKeyframePackets();
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
                  if (cmd.type === 'request_keyframe' && videoTrack && videoEncoder.hasKeyframe()) {
                    const keyPackets = videoEncoder.getKeyframePackets();
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
        if (activeVideoTracks.size === 0 && streamWsClients.size === 0) {
          videoEncoder.close();
        }
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
