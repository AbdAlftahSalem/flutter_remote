/**
 * Flutter Remote WebRTC V3 Real Video Encoder
 *
 * NOTE / ARCHITECTURE:
 * This module is a reference and unit-testable implementation. The live encoder that runs
 * on the remote macOS GitHub Actions runner is located at `templates/peer/VideoEncoder.cjs`
 * (bundled and deployed to `.github/flutter-remote/peer/VideoEncoder.cjs`).
 * Edits here do not affect live runner streaming sessions.
 *
 * Provides genuine H.264 video encoding:
 *   1. Real H.264 video encoding from image frames (JPEG / MJPEG) using FFmpeg (libx264 zerolatency).
 *   2. Annex-B NAL unit parsing (3-byte & 4-byte start codes across chunk boundaries).
 *   3. Access Unit (frame) demarcation and grouping (SPS, PPS, SEI, IDR / slices).
 *   4. Delegates RTP packetization to RtpPacketizer.
 *   5. Delegates keyframe recovery to KeyframeController.
 *   6. FFmpeg stdin backpressure management with bounded latest-frame priority queue.
 *   7. Fresh IDR keyframe recovery maintaining reference chain.
 */

import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { RtpPacketizer, NAL_TYPES } from './RtpPacketizer.js';
import { KeyframeController, RECOVERY_STATES } from './KeyframeController.js';

export { NAL_TYPES, RECOVERY_STATES };

let resolvedFfmpegPath = null;
try {
  const ffmpegStatic = await import('ffmpeg-static');
  resolvedFfmpegPath = ffmpegStatic.default || ffmpegStatic;
} catch {
  resolvedFfmpegPath = 'ffmpeg';
}

export class VideoEncoder extends EventEmitter {
  constructor(options = {}) {
    super();
    this.payloadType = options.payloadType || 98; // 98 for H.264
    this.ssrc = options.ssrc || 12345;
    this.mtu = options.mtu || 1200; // Safe MTU for UDP
    this.fps = options.fps || 30;
    this.bitrateKbps = options.bitrateKbps || 2500;
    this.ffmpegPath = options.ffmpegPath || resolvedFfmpegPath;

    // Submodules
    this.rtpPacketizer = new RtpPacketizer({
      payloadType: this.payloadType,
      ssrc: this.ssrc,
      mtu: this.mtu,
    });

    this.keyframeController = new KeyframeController({
      rtpPacketizer: this.rtpPacketizer,
      spawnEncoderFn: () => this._spawnEncoderProcess(),
    });

    // Forward keyframe controller events
    this.keyframeController.on('keyframe_requested', (data) => this.emit('keyframe_requested', data));
    this.keyframeController.on('fresh_keyframe_encoded', (data) => this.emit('fresh_keyframe_encoded', data));

    // Backpressure & Bounded Queue
    this.maxPendingFrames = options.maxPendingFrames || 1;
    this._pendingQueue = [];
    this._waitingForDrain = false;
    this._hasDrainListener = false;

    // Stream Parser & Access Unit Demarcation State
    this._streamBuffer = Buffer.alloc(0);
    this._pendingAU = [];
    this._auHasVcl = false;
    this._flushTimer = null;

    // Frame tracking for recovery
    this._frameId = 0;
    this._latestFrameId = 0;
    this._latestFrame = null;

    // Diagnostics & Metrics (shared directly with keyframeController)
    this.metrics = this.keyframeController.metrics;
    this.metrics.inputReceived = 0;
    this.metrics.inputDropped = 0;
    this.metrics.inputPending = 0;
    this.metrics.encodedFrames = 0;
    this.metrics.totalEncodeLatencyMs = 0;
    this.metrics.maxEncodeLatencyMs = 0;
    this._diagInterval = null;

    // FFmpeg process
    this.ffmpegProc = null;
    this._isEncoding = false;
  }

  // Delegated getters & setters for backwards compatibility
  get cachedSps() { return this.keyframeController.cachedSps; }
  set cachedSps(val) { this.keyframeController.cachedSps = val; }

  get cachedPps() { return this.keyframeController.cachedPps; }
  set cachedPps(val) { this.keyframeController.cachedPps = val; }

  get cachedKeyframe() { return this.keyframeController.cachedKeyframe; }
  set cachedKeyframe(val) { this.keyframeController.cachedKeyframe = val; }

  get lastFrameType() { return this.keyframeController.lastFrameType; }
  set lastFrameType(val) { this.keyframeController.lastFrameType = val; }

  get _recoveryState() { return this.keyframeController.state; }
  set _recoveryState(val) { this.keyframeController.state = val; }

  get _pendingKeyframePromise() { return this.keyframeController.pendingKeyframePromise; }
  set _pendingKeyframePromise(val) { this.keyframeController.pendingKeyframePromise = val; }

  get _sequenceNumber() { return this.rtpPacketizer._sequenceNumber; }
  set _sequenceNumber(val) { this.rtpPacketizer._sequenceNumber = val; }

  get _timestamp() { return this.rtpPacketizer._timestamp; }
  set _timestamp(val) { this.rtpPacketizer._timestamp = val; }

  get _clockRate() { return this.rtpPacketizer._clockRate; }
  set _clockRate(val) { this.rtpPacketizer._clockRate = val; }

  _nextRtpTimestamp(fps = this.fps) {
    return this.rtpPacketizer.nextRtpTimestamp(fps);
  }

  hasKeyframe() {
    return this.keyframeController.hasKeyframe();
  }

  getKeyframe() {
    return this.keyframeController.getKeyframe();
  }

  getKeyframePackets(fps = this.fps) {
    return this.keyframeController.getKeyframePackets(fps);
  }

  inspectAndCacheNals(nalUnits) {
    this.keyframeController.inspectAndCacheNals(nalUnits);
    this.metrics.keyframes = this.keyframeController.metrics.keyframes;
  }

  packetizeAccessUnit(accessUnitNals, fps = this.fps) {
    return this.rtpPacketizer.packetizeAccessUnit(accessUnitNals, fps);
  }

  packetizeNalUnits(nalUnits, fps = this.fps) {
    return this.packetizeAccessUnit(nalUnits, fps);
  }

  packetize(frameBuffer, fps = this.fps) {
    if (!Buffer.isBuffer(frameBuffer) || frameBuffer.length === 0) {
      return [];
    }
    const nalUnits = this.parseNalUnits(frameBuffer);
    if (nalUnits.length > 0) {
      this.inspectAndCacheNals(nalUnits);
    }
    const units = (nalUnits.length > 0) ? nalUnits : [{ data: frameBuffer, type: frameBuffer[0] & 0x1f }];
    return this.packetizeAccessUnit(units, fps);
  }

  requestKeyframe() {
    const p = this.keyframeController.requestKeyframe(
      this._latestFrame,
      (nextProc) => this._promoteReplacementEncoder(nextProc),
      (buf) => this.parseNalUnits(buf),
      this.fps
    );
    this._syncMetrics();
    return p;
  }

  _performMainEncoderIdrRecovery() {
    return this.requestKeyframe();
  }

  _promoteReplacementEncoder(nextProc) {
    const oldProc = this.ffmpegProc;
    this.ffmpegProc = nextProc;
    this._setupStdin(nextProc.stdin);

    if (oldProc) {
      try {
        if (oldProc.stdin) oldProc.stdin.end();
        oldProc.kill('SIGTERM');
      } catch {}
    }

    nextProc.stdout.on('data', (chunk) => {
      if (this.ffmpegProc !== nextProc) return;
      this._handleEncodedData(chunk);
    });

    nextProc.on('close', (code, signal) => {
      if (this.ffmpegProc !== nextProc) {
        console.log(`[ffmpeg] retired encoder closed pid=${nextProc.pid}`);
        return;
      }
      this._isEncoding = false;
      this.ffmpegProc = null;
      this._flushPending();
      console.log(`[ffmpeg] active encoder closed pid=${nextProc.pid} code=${code} signal=${signal}`);
    });

    this._flushNextPendingInput();
  }

  _syncMetrics() {
    Object.assign(this.metrics, this.keyframeController.metrics);
  }

  /**
   * Spawns a continuous FFmpeg H.264 encoding process.
   */
  _spawnEncoderProcess() {
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
      '-keyint_min', '1',
      '-forced-idr', '1',
      '-aud', '1',
      '-b:v', `${this.bitrateKbps}k`,
      '-maxrate', `${this.bitrateKbps}k`,
      '-bufsize', `${this.bitrateKbps * 2}k`,
      '-f', 'h264',
      'pipe:1',
    ];

    return spawn(this.ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  }

  start() {
    if (this.ffmpegProc) return;

    try {
      const proc = this._spawnEncoderProcess();
      this.ffmpegProc = proc;
      this._isEncoding = true;
      this._waitingForDrain = false;

      console.log(`[ffmpeg] encoder started pid=${proc.pid}`);

      proc.stdout.on('data', (chunk) => {
        if (this.ffmpegProc !== proc) return;
        this._handleEncodedData(chunk);
      });

      this._setupStdin(proc.stdin);

      let lastStderrMsg = '';
      let repeatCount = 0;
      proc.stderr.on('data', (errData) => {
        const msg = errData.toString().trim();
        if (!msg || msg.includes('deprecated') || msg.includes('EOI missing')) return;

        if (msg === lastStderrMsg) {
          repeatCount++;
          if (repeatCount % 50 === 0) {
            console.error(`[ffmpeg] ${msg} (repeated ${repeatCount} times)`);
          }
          return;
        }
        lastStderrMsg = msg;
        repeatCount = 0;
        console.error(`[ffmpeg] ${msg}`);
        this.emit('encoder_warning', msg);
      });

      proc.on('error', (err) => {
        console.error(`[ffmpeg] encoder error pid=${proc.pid}: ${err.message}`);
        this.emit('encoder_error', err);
        this.close();
      });

      proc.on('close', (code, signal) => {
        if (this.ffmpegProc !== proc) {
          console.log(`[ffmpeg] retired encoder closed pid=${proc.pid}`);
          return;
        }

        this._isEncoding = false;
        this.ffmpegProc = null;
        this._flushPending();

        console.log(`[ffmpeg] active encoder closed pid=${proc.pid} code=${code} signal=${signal}`);
        this.emit('encoder_closed', code);
      });

      this._startDiagnostics();
    } catch (err) {
      console.error('[ffmpeg] encoder spawn error:', err.message);
      this.emit('encoder_error', err);
      this._isEncoding = false;
    }
  }

  _setupStdin(stdin) {
    if (!stdin || typeof stdin.on !== 'function') return;
    this._hasDrainListener = true;
    stdin.on('drain', () => {
      this._waitingForDrain = false;
      this._flushNextPendingInput();
    });
  }

  encodeFrame(jpegBuffer) {
    if (!Buffer.isBuffer(jpegBuffer) || jpegBuffer.length === 0) {
      return false;
    }

    this._frameId++;
    this._latestFrameId = this._frameId;
    const frameCopy = Buffer.from(jpegBuffer);
    frameCopy.id = this._frameId;
    this._latestFrame = frameCopy;
    this.metrics.inputReceived++;

    if (this.metrics.inputReceived <= 3 || this.metrics.inputReceived % 60 === 0) {
      console.log(
        `[video] received=${this.metrics.inputReceived} encoded=${this.metrics.encodedFrames} ` +
        `keyframes=${this.metrics.keyframes} dropped=${this.metrics.inputDropped}`
      );
    }

    if (this.keyframeController.state === RECOVERY_STATES.WAITING_FOR_IDR) {
      while (this._pendingQueue.length >= this.maxPendingFrames) {
        this._pendingQueue.shift();
        this.metrics.inputDropped++;
        this.emit('frame_dropped', { totalDropped: this.metrics.inputDropped });
      }
      this._pendingQueue.push({ buffer: jpegBuffer, ts: Date.now() });
      this.metrics.inputPending = this._pendingQueue.length;
      return false;
    }

    if (!this.ffmpegProc || !this.ffmpegProc.stdin || !this.ffmpegProc.stdin.writable) {
      this.start();
    }

    if (!this.ffmpegProc || !this.ffmpegProc.stdin || !this.ffmpegProc.stdin.writable) {
      return false;
    }

    if (!this._hasDrainListener && this.ffmpegProc.stdin) {
      this._setupStdin(this.ffmpegProc.stdin);
    }

    if (this._waitingForDrain) {
      while (this._pendingQueue.length >= this.maxPendingFrames) {
        this._pendingQueue.shift();
        this.metrics.inputDropped++;
        this.emit('frame_dropped', { totalDropped: this.metrics.inputDropped });
      }
      this._pendingQueue.push({ buffer: jpegBuffer, ts: Date.now() });
      this.metrics.inputPending = this._pendingQueue.length;
      return false;
    }

    try {
      const canAcceptMore = this.ffmpegProc.stdin.write(jpegBuffer);
      if (!canAcceptMore) {
        this._waitingForDrain = true;
      }
      return true;
    } catch (err) {
      this.emit('encoder_error', err);
      return false;
    }
  }

  _flushNextPendingInput() {
    if (this._pendingQueue.length === 0 || !this.ffmpegProc?.stdin?.writable) return;

    const item = this._pendingQueue.shift();
    this.metrics.inputPending = this._pendingQueue.length;

    try {
      const canAcceptMore = this.ffmpegProc.stdin.write(item.buffer);
      if (!canAcceptMore) {
        this._waitingForDrain = true;
      }
    } catch (err) {
      this.emit('encoder_error', err);
    }
  }

  _handleEncodedData(chunk) {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }

    this._streamBuffer = Buffer.concat([this._streamBuffer, chunk]);
    const { completeNals, lastStartCode } = this._extractCompleteNalsWithLast();

    for (const nal of completeNals) {
      if (this._isNewAccessUnit(nal)) {
        this._emitCurrentAccessUnit();
      }

      this._pendingAU.push(nal);
      if (nal.type >= 1 && nal.type <= 5) {
        this._auHasVcl = true;
      }
    }

    if (lastStartCode) {
      this._checkTrailingStartCode(lastStartCode);
    }

    if ((this._auHasVcl || this._streamBuffer.length > 0) && this._isEncoding) {
      this._flushTimer = setTimeout(() => {
        this._flushPending();
      }, 10);
    }
  }

  feedStream(chunk) {
    this._streamBuffer = Buffer.concat([this._streamBuffer, chunk]);
    const { completeNals, lastStartCode } = this._extractCompleteNalsWithLast();
    const emittedAUs = [];

    for (const nal of completeNals) {
      if (this._isNewAccessUnit(nal)) {
        const au = this._emitCurrentAccessUnit();
        if (au) emittedAUs.push(au);
      }

      this._pendingAU.push(nal);
      if (nal.type >= 1 && nal.type <= 5) {
        this._auHasVcl = true;
      }
    }

    if (lastStartCode) {
      const au = this._checkTrailingStartCode(lastStartCode);
      if (au) emittedAUs.push(au);
    }

    return emittedAUs;
  }

  _extractCompleteNalsWithLast() {
    const buffer = this._streamBuffer;
    if (buffer.length === 0) return { completeNals: [], lastStartCode: null };

    const startCodes = [];
    const len = buffer.length;

    for (let i = 0; i <= len - 3; i++) {
      if (buffer[i] === 0x00 && buffer[i + 1] === 0x00) {
        if (buffer[i + 2] === 0x01) {
          startCodes.push({ index: i, prefixLen: 3 });
          i += 2;
        } else if (i <= len - 4 && buffer[i + 2] === 0x00 && buffer[i + 3] === 0x01) {
          startCodes.push({ index: i, prefixLen: 4 });
          i += 3;
        }
      }
    }

    if (startCodes.length === 0) {
      return { completeNals: [], lastStartCode: null };
    }

    if (startCodes.length === 1) {
      if (startCodes[0].index > 0) {
        this._streamBuffer = buffer.subarray(startCodes[0].index);
      }
      return { completeNals: [], lastStartCode: { index: 0, prefixLen: startCodes[0].prefixLen } };
    }

    const completeNals = [];
    for (let k = 0; k < startCodes.length - 1; k++) {
      const current = startCodes[k];
      const next = startCodes[k + 1];
      const nalData = buffer.subarray(current.index + current.prefixLen, next.index);
      if (nalData.length > 0) {
        const nalType = nalData[0] & 0x1f;
        completeNals.push({ data: nalData, type: nalType });
      }
    }

    const lastStartCode = startCodes[startCodes.length - 1];
    this._streamBuffer = buffer.subarray(lastStartCode.index);

    return {
      completeNals,
      lastStartCode: { index: 0, prefixLen: lastStartCode.prefixLen },
    };
  }

  _checkTrailingStartCode(lastStartCode) {
    const buffer = this._streamBuffer;
    const trailing = buffer.subarray(lastStartCode.index + lastStartCode.prefixLen);
    if (trailing.length < 2) return null;

    const nalType = trailing[0] & 0x1f;
    const isFirstMb = (trailing[1] & 0x80) !== 0;

    let isNewAU = false;
    if (nalType === NAL_TYPES.AUD) {
      isNewAU = true;
    } else if (this._auHasVcl) {
      if (nalType === NAL_TYPES.SPS || nalType === NAL_TYPES.PPS || nalType === NAL_TYPES.SEI) {
        isNewAU = true;
      } else if (nalType >= 1 && nalType <= 5) {
        if (isFirstMb) {
          isNewAU = true;
        } else {
          const currentHasIdr = this._pendingAU.some((n) => n.type === NAL_TYPES.IDR);
          if (nalType === NAL_TYPES.IDR && !currentHasIdr) isNewAU = true;
          if (nalType !== NAL_TYPES.IDR && currentHasIdr) isNewAU = true;
        }
      }
    }

    if (isNewAU && this._pendingAU.length > 0) {
      return this._emitCurrentAccessUnit();
    }
    return null;
  }

  _isNewAccessUnit(nal) {
    if (this._pendingAU.length === 0) return false;

    if (nal.type === NAL_TYPES.AUD) return true;

    if (this._auHasVcl) {
      if (nal.type === NAL_TYPES.SPS || nal.type === NAL_TYPES.PPS || nal.type === NAL_TYPES.SEI) {
        return true;
      }

      if (nal.type >= 1 && nal.type <= 5) {
        if (nal.data.length > 1 && (nal.data[1] & 0x80) !== 0) {
          return true;
        }
        const currentHasIdr = this._pendingAU.some((n) => n.type === NAL_TYPES.IDR);
        if (nal.type === NAL_TYPES.IDR && !currentHasIdr) return true;
        if (nal.type !== NAL_TYPES.IDR && currentHasIdr) return true;
      }
    }

    return false;
  }

  _emitCurrentAccessUnit() {
    if (this._pendingAU.length === 0) return null;

    const auNals = this._pendingAU;
    this._pendingAU = [];
    this._auHasVcl = false;

    this.inspectAndCacheNals(auNals);
    this.metrics.encodedFrames++;

    const packets = this.packetizeAccessUnit(auNals, this.fps);
    if (packets.length > 0) {
      this.emit('packets', packets);
    }

    return auNals;
  }

  _flushPending() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }

    if (this._streamBuffer.length >= 4) {
      let pfxLen = 0;
      if (this._streamBuffer[0] === 0 && this._streamBuffer[1] === 0) {
        if (this._streamBuffer[2] === 1) pfxLen = 3;
        else if (this._streamBuffer[2] === 0 && this._streamBuffer[3] === 1) pfxLen = 4;
      }
      if (pfxLen > 0) {
        const nalData = this._streamBuffer.subarray(pfxLen);
        if (nalData.length > 0) {
          const nalType = nalData[0] & 0x1f;
          this._streamBuffer = Buffer.alloc(0);
          if (this._isNewAccessUnit({ data: nalData, type: nalType })) {
            this._emitCurrentAccessUnit();
          }
          this._pendingAU.push({ data: nalData, type: nalType });
          if (nalType >= 1 && nalType <= 5) this._auHasVcl = true;
        }
      }
    }

    if (this._auHasVcl) {
      this._emitCurrentAccessUnit();
    }
  }

  parseNalUnits(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return [];

    const nalUnits = [];
    const len = buffer.length;
    const startCodes = [];

    for (let i = 0; i <= len - 3; i++) {
      if (buffer[i] === 0x00 && buffer[i + 1] === 0x00) {
        if (buffer[i + 2] === 0x01) {
          startCodes.push({ index: i, prefixLen: 3 });
          i += 2;
        } else if (i <= len - 4 && buffer[i + 2] === 0x00 && buffer[i + 3] === 0x01) {
          startCodes.push({ index: i, prefixLen: 4 });
          i += 3;
        }
      }
    }

    if (startCodes.length === 0) {
      const nalType = buffer[0] & 0x1f;
      return [{ data: buffer, type: nalType }];
    }

    for (let k = 0; k < startCodes.length; k++) {
      const current = startCodes[k];
      const start = current.index + current.prefixLen;
      const end = (k + 1 < startCodes.length) ? startCodes[k + 1].index : len;
      const nalData = buffer.subarray(start, end);

      if (nalData.length > 0) {
        const nalType = nalData[0] & 0x1f;
        nalUnits.push({ data: nalData, type: nalType });
      }
    }

    return nalUnits;
  }

  _startDiagnostics() {
    if (this._diagInterval) return;
    this._diagInterval = setInterval(() => {
      if (this.metrics.inputReceived > 0 || this.metrics.encodedFrames > 0) {
        console.log(
          `[video] received=${this.metrics.inputReceived} encoded=${this.metrics.encodedFrames} ` +
          `keyframes=${this.metrics.keyframes} dropped=${this.metrics.inputDropped}`
        );
      }
    }, 3000);
    this._diagInterval.unref?.();
  }

  close() {
    this._isEncoding = false;
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._diagInterval) {
      clearInterval(this._diagInterval);
      this._diagInterval = null;
    }
    if (this.ffmpegProc) {
      try {
        if (this.ffmpegProc.stdin) this.ffmpegProc.stdin.end();
        this.ffmpegProc.kill('SIGTERM');
      } catch {}
      this.ffmpegProc = null;
    }
    this._streamBuffer = Buffer.alloc(0);
    this._pendingAU = [];
    this._auHasVcl = false;
    this._pendingQueue = [];
    this._waitingForDrain = false;

    this.keyframeController.reset();
  }
}
