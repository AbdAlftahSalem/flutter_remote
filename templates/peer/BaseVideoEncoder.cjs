// flutter-remote-template-version: 1
/**
 * Flutter Remote Base Video Encoder (CommonJS)
 */

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { RtpPacketizer, NAL_TYPES } = require('./RtpPacketizer.cjs');
const { KeyframeController, RECOVERY_STATES } = require('./KeyframeController.cjs');

class BaseVideoEncoder extends EventEmitter {
  constructor(options = {}) {
    super();
    this.codec = options.codec || 'H264';
    this.encoderName = options.encoderName || 'base';
    this.isHardware = Boolean(options.isHardware);
    this.payloadType = options.payloadType || 98;
    this.ssrc = options.ssrc || 12345;
    this.mtu = options.mtu || 1200;
    this.fps = options.fps || 30;
    this.bitrateKbps = options.bitrateKbps || 2500;
    this.width = options.width || 720;
    this.height = options.height || 1280;
    this.ffmpegPath = options.ffmpegPath || 'ffmpeg';

    this.rtpPacketizer = new RtpPacketizer({
      payloadType: this.payloadType,
      ssrc: this.ssrc,
      mtu: this.mtu,
    });

    this.keyframeController = new KeyframeController({
      rtpPacketizer: this.rtpPacketizer,
      spawnEncoderFn: () => this._spawnEncoderProcess(),
    });

    this.keyframeController.on('keyframe_requested', (data) => this.emit('keyframe_requested', data));
    this.keyframeController.on('fresh_keyframe_encoded', (data) => this.emit('fresh_keyframe_encoded', data));

    this.maxPendingFrames = options.maxPendingFrames || 1;
    this._pendingQueue = [];
    this._waitingForDrain = false;
    this._hasDrainListener = false;

    this._streamBuffer = Buffer.alloc(0);
    this._pendingAU = [];
    this._auHasVcl = false;
    this._flushTimer = null;

    this._frameId = 0;
    this._latestFrameId = 0;
    this._latestFrame = null;

    this.metrics = this.keyframeController.metrics;
    this.metrics.encoderName = this.encoderName;
    this.metrics.isHardware = this.isHardware;
    this.metrics.inputReceived = 0;
    this.metrics.inputDropped = 0;
    this.metrics.inputPending = 0;
    this.metrics.encodedFrames = 0;
    this.metrics.totalEncodeLatencyMs = 0;
    this.metrics.maxEncodeLatencyMs = 0;
    this.metrics.lastEncodeLatencyMs = 0;
    this._diagInterval = null;

    this.ffmpegProc = null;
    this._isEncoding = false;
  }

  get cachedSps() { return this.keyframeController.cachedSps; }
  set cachedSps(v) { this.keyframeController.cachedSps = v; }

  get cachedPps() { return this.keyframeController.cachedPps; }
  set cachedPps(v) { this.keyframeController.cachedPps = v; }

  get cachedKeyframe() { return this.keyframeController.cachedKeyframe; }
  set cachedKeyframe(v) { this.keyframeController.cachedKeyframe = v; }

  get lastFrameType() { return this.keyframeController.lastFrameType; }
  set lastFrameType(v) { this.keyframeController.lastFrameType = v; }

  get _recoveryState() { return this.keyframeController.state; }
  set _recoveryState(v) { this.keyframeController.state = v; }

  get _pendingKeyframePromise() { return this.keyframeController.pendingKeyframePromise; }
  set _pendingKeyframePromise(v) { this.keyframeController.pendingKeyframePromise = v; }

  get _sequenceNumber() { return this.rtpPacketizer._sequenceNumber; }
  set _sequenceNumber(v) { this.rtpPacketizer._sequenceNumber = v; }

  get _timestamp() { return this.rtpPacketizer._timestamp; }
  set _timestamp(v) { this.rtpPacketizer._timestamp = v; }

  get _clockRate() { return this.rtpPacketizer._clockRate; }
  set _clockRate(v) { this.rtpPacketizer._clockRate = v; }

  get resolution() {
    return { width: this.width, height: this.height };
  }

  get health() {
    return {
      running: this._isEncoding && Boolean(this.ffmpegProc),
      pid: this.ffmpegProc?.pid || null,
      waitingForDrain: this._waitingForDrain,
      queueDepth: this._pendingQueue.length,
      recoveryState: this.keyframeController.state,
      encoderName: this.encoderName,
      isHardware: this.isHardware,
    };
  }

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
    if (!Buffer.isBuffer(frameBuffer) || frameBuffer.length === 0) return [];
    const nalUnits = this.parseNalUnits(frameBuffer);
    if (nalUnits.length > 0) this.inspectAndCacheNals(nalUnits);
    const units = nalUnits.length > 0 ? nalUnits : [{ data: frameBuffer, type: frameBuffer[0] & 0x1f }];
    return this.packetizeAccessUnit(units, fps);
  }

  setBitrate(bitrateKbps) {
    const num = Number(bitrateKbps);
    if (num > 0 && num !== this.bitrateKbps) {
      this.bitrateKbps = num;
      this.emit('quality_changed', { bitrateKbps: this.bitrateKbps, fps: this.fps });
    }
  }

  setFramerate(fps) {
    const num = Number(fps);
    if (num > 0 && num !== this.fps) {
      this.fps = num;
      this.emit('quality_changed', { bitrateKbps: this.bitrateKbps, fps: this.fps });
    }
  }

  setResolution(width, height) {
    if (width > 0 && height > 0) {
      this.width = width;
      this.height = height;
    }
  }

  requestKeyframe(reason = 'manual') {
    if (this.hasKeyframe()) {
      const cachedPackets = this.getKeyframePackets(this.fps);
      if (cachedPackets && cachedPackets.length > 0) {
        this.emit('packets', cachedPackets);
      }
    }

    const p = this.keyframeController.requestKeyframe(
      this._latestFrame,
      (nextProc) => this._promoteReplacementEncoder(nextProc),
      (buf) => this.parseNalUnits(buf),
      this.fps
    );

    p.then((packets) => {
      if (packets && packets.length > 0) {
        this.emit('packets', packets);
      }
    }).catch(() => {});

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

    nextProc.on('close', () => {
      if (this.ffmpegProc !== nextProc) return;
      this._isEncoding = false;
      this.ffmpegProc = null;
      this._flushPending();
    });

    this._flushNextPendingInput();
  }

  _syncMetrics() {
    Object.assign(this.metrics, this.keyframeController.metrics);
  }

  buildFfmpegArgs() {
    throw new Error('buildFfmpegArgs must be implemented by subclass');
  }

  _spawnEncoderProcess() {
    const args = this.buildFfmpegArgs();
    return spawn(this.ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  }

  start() {
    if (this.ffmpegProc) return;

    try {
      const proc = this._spawnEncoderProcess();
      this.ffmpegProc = proc;
      this._isEncoding = true;
      this._waitingForDrain = false;

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
        this.emit('encoder_error', err);
        this.close();
      });

      proc.on('close', (code) => {
        if (this.ffmpegProc !== proc) return;
        this._isEncoding = false;
        this.ffmpegProc = null;
        this._flushPending();
        this.emit('encoder_closed', code);
      });

      this._startDiagnostics();
    } catch (err) {
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

  encode(frame) {
    return this.encodeFrame(frame);
  }

  encodeFrame(jpegBuffer) {
    if (!Buffer.isBuffer(jpegBuffer) || jpegBuffer.length === 0) return false;

    this._frameId++;
    this._latestFrameId = this._frameId;
    jpegBuffer.id = this._frameId;
    this._latestFrame = jpegBuffer;
    this.metrics.inputReceived++;

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
      if (!canAcceptMore) this._waitingForDrain = true;
    } catch (err) {
      this.emit('encoder_error', err);
    }
  }

  _handleEncodedData(chunk) {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }

    if (this._streamBuffer.length === 0) {
      this._streamBuffer = chunk;
    } else {
      this._streamBuffer = Buffer.concat([this._streamBuffer, chunk]);
    }

    const { completeNals, lastStartCode } = this._extractCompleteNalsWithLast();

    for (const nal of completeNals) {
      if (this._isNewAccessUnit(nal)) {
        this._emitCurrentAccessUnit();
      }
      this._pendingAU.push(nal);
      if (nal.type >= 1 && nal.type <= 5) this._auHasVcl = true;
    }

    if (lastStartCode) this._checkTrailingStartCode(lastStartCode);

    if ((this._auHasVcl || this._streamBuffer.length > 0) && this._isEncoding) {
      this._flushTimer = setTimeout(() => this._flushPending(), 10);
    }
  }

  feedStream(chunk) {
    if (this._streamBuffer.length === 0) {
      this._streamBuffer = chunk;
    } else {
      this._streamBuffer = Buffer.concat([this._streamBuffer, chunk]);
    }

    const { completeNals, lastStartCode } = this._extractCompleteNalsWithLast();
    const emittedAUs = [];

    for (const nal of completeNals) {
      if (this._isNewAccessUnit(nal)) {
        const au = this._emitCurrentAccessUnit();
        if (au) emittedAUs.push(au);
      }
      this._pendingAU.push(nal);
      if (nal.type >= 1 && nal.type <= 5) this._auHasVcl = true;
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

    if (startCodes.length === 0) return { completeNals: [], lastStartCode: null };

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
        completeNals.push({ data: nalData, type: nalData[0] & 0x1f });
      }
    }

    const lastStartCode = startCodes[startCodes.length - 1];
    this._streamBuffer = buffer.subarray(lastStartCode.index);

    return { completeNals, lastStartCode: { index: 0, prefixLen: lastStartCode.prefixLen } };
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
        if (nal.data.length > 1 && (nal.data[1] & 0x80) !== 0) return true;
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
      return [{ data: buffer, type: buffer[0] & 0x1f }];
    }

    for (let k = 0; k < startCodes.length; k++) {
      const current = startCodes[k];
      const start = current.index + current.prefixLen;
      const end = (k + 1 < startCodes.length) ? startCodes[k + 1].index : len;
      const nalData = buffer.subarray(start, end);
      if (nalData.length > 0) {
        nalUnits.push({ data: nalData, type: nalData[0] & 0x1f });
      }
    }

    return nalUnits;
  }

  _startDiagnostics() {
    if (this._diagInterval) return;
    this._diagInterval = setInterval(() => {
      if (this.metrics.inputReceived > 0 || this.metrics.encodedFrames > 0) {
        // quiet diagnostics
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

module.exports = {
  BaseVideoEncoder,
  NAL_TYPES,
  RECOVERY_STATES,
};
