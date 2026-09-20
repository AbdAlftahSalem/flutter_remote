// flutter-remote-template-version: 4
/**
 * Flutter Remote WebRTC V3 ServeSimConsumer (CommonJS)
 *
 * Owns:
 *   1. HTTP client for serve-sim MJPEG stream (SOI/EOI boundary demarcation)
 *   2. Feeding parsed JPEGs to VideoEncoder & legacy /stream-ws subscribers
 *   3. WebSocket client bridge to serve-sim /ws with offline queueing & move coalescing
 */

const http = require('node:http');

class ServeSimConsumer {
  constructor(options = {}) {
    this.targetHost = options.targetHost || '127.0.0.1';
    this.previewPort = options.previewPort || 3200;
    this.streamPath = options.streamPath || '/stream.mjpeg?raw=1';
    this.videoEncoder = options.videoEncoder || null;
    this.streamWsClients = options.streamWsClients || new Set();
    this.activeVideoTracks = options.activeVideoTracks || new Set();
    this.WebSocketClass = options.WebSocketClass || null;

    this.localStreamReq = null;
    this.jpegFrameCount = 0;

    // WebSocket bridge state
    this.serveSimWs = null;
    this.serveSimQueue = [];
    this.serveSimConnecting = false;
  }

  ensureLocalStream() {
    if (this.localStreamReq || (this.streamWsClients.size === 0 && this.activeVideoTracks.size === 0)) {
      return;
    }

    console.log('[webrtc-peer] starting serve-sim stream consumer');
    console.log(
      `[webrtc-peer] Connecting to serve-sim stream: http://${this.targetHost}:${this.previewPort}${this.streamPath}`
    );

    this.localStreamReq = http.get(
      {
        host: this.targetHost,
        port: this.previewPort,
        path: this.streamPath,
        headers: { 'Accept-Encoding': 'identity' },
      },
      (res) => {
        console.log(
          `[webrtc-peer] serve-sim stream response: status=${res.statusCode} content-type=${res.headers['content-type'] || 'unknown'}`
        );

        if (res.statusCode !== 200) {
          console.error(
            `[webrtc-peer] serve-sim stream failed:\n` +
            `host=${this.targetHost}\n` +
            `port=${this.previewPort}\n` +
            `path=${this.streamPath}\n` +
            `status=${res.statusCode}\n` +
            `content-type=${res.headers['content-type'] || 'unknown'}`
          );
        }

        let buffer = Buffer.alloc(0);

        res.on('data', (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);

          let soi = buffer.indexOf(Buffer.from([0xff, 0xd8]));
          while (soi !== -1) {
            const eoi = buffer.indexOf(Buffer.from([0xff, 0xd9]), soi + 2);
            if (eoi === -1) break;

            const jpeg = buffer.subarray(soi, eoi + 2);
            this.jpegFrameCount++;

            if (this.jpegFrameCount <= 3 || this.jpegFrameCount % 60 === 0) {
              console.log(`[video] JPEG frames=${this.jpegFrameCount} size=${jpeg.length}`);
            }

            // 1. Broadcast raw JPEG to WebSocket clients (legacy fallback)
            for (const client of this.streamWsClients) {
              if (client.readyState === 1 /* OPEN */) {
                try { client.send(jpeg); } catch {}
              }
            }

            // 2. Feed JPEG into real H.264 VideoEncoder
            if (this.activeVideoTracks.size > 0 && this.videoEncoder) {
              this.videoEncoder.encodeFrame(jpeg);
            }

            buffer = buffer.subarray(eoi + 2);
            soi = buffer.indexOf(Buffer.from([0xff, 0xd8]));
          }

          if (buffer.length > 5 * 1024 * 1024) {
            buffer = Buffer.alloc(0);
          }
        });

        res.on('end', () => {
          this.localStreamReq = null;
          if (this.streamWsClients.size > 0 || this.activeVideoTracks.size > 0) {
            setTimeout(() => this.ensureLocalStream(), 1000);
          }
        });

        res.on('error', (err) => {
          console.error('[webrtc-peer local stream error]', err.message);
          this.localStreamReq = null;
          if (this.streamWsClients.size > 0 || this.activeVideoTracks.size > 0) {
            setTimeout(() => this.ensureLocalStream(), 1000);
          }
        });
      }
    );

    this.localStreamReq.on('error', (err) => {
      console.error('[webrtc-peer local stream request error]', err.message);
      this.localStreamReq = null;
      if (this.streamWsClients.size > 0 || this.activeVideoTracks.size > 0) {
        setTimeout(() => this.ensureLocalStream(), 1000);
      }
    });
  }

  sendToServeSim(msg) {
    if (this.serveSimWs && this.serveSimWs.readyState === 1 /* OPEN */) {
      try {
        this.serveSimWs.send(msg);
        return;
      } catch {}
    }

    if (this.serveSimQueue.length < 500) {
      try {
        const parsed = JSON.parse(typeof msg === 'string' ? msg : msg.toString());
        if (parsed.event === 'move' || parsed.type === 'pointer_move') {
          const lastIdx = this.serveSimQueue.findLastIndex((item) => {
            try {
              const p = JSON.parse(typeof item === 'string' ? item : item.toString());
              return p.event === 'move' || p.type === 'pointer_move';
            } catch { return false; }
          });
          if (lastIdx !== -1) {
            this.serveSimQueue[lastIdx] = msg;
            return;
          }
        }
      } catch {}
      this.serveSimQueue.push(msg);
    }

    this.initServeSimWs();
  }

  initServeSimWs() {
    if (!this.WebSocketClass) return;
    if (this.serveSimConnecting || (this.serveSimWs && this.serveSimWs.readyState === 1 /* OPEN */)) return;
    this.serveSimConnecting = true;

    this.serveSimWs = new this.WebSocketClass(`ws://${this.targetHost}:${this.previewPort}/ws`);

    this.serveSimWs.on('open', () => {
      this.serveSimConnecting = false;
      console.log('[webrtc-peer] Connected to serve-sim /ws, flushing queue of', this.serveSimQueue.length);
      while (this.serveSimQueue.length > 0 && this.serveSimWs.readyState === 1) {
        const m = this.serveSimQueue.shift();
        try { this.serveSimWs.send(m); } catch {}
      }
    });

    this.serveSimWs.on('error', (err) => {
      this.serveSimConnecting = false;
      console.warn('[webrtc-peer -> serve-sim ws error]', err.message);
    });

    this.serveSimWs.on('close', () => {
      this.serveSimConnecting = false;
    });
  }

  close() {
    if (this.localStreamReq) {
      try { this.localStreamReq.destroy(); } catch {}
      this.localStreamReq = null;
    }
    if (this.serveSimWs) {
      try { this.serveSimWs.close(); } catch {}
      this.serveSimWs = null;
    }
    this.serveSimQueue = [];
    this.serveSimConnecting = false;
  }
}

module.exports = {
  ServeSimConsumer,
};
