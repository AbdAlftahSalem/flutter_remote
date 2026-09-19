/**
 * Flutter Remote WebRTC V2 Real Video Encoder & RFC 6184 H.264 Packetizer
 *
 * Provides genuine H.264 video encoding:
 *   1. Real H.264 video encoding from image frames (JPEG / MJPEG) using FFmpeg (libx264 zerolatency).
 *   2. Annex-B NAL unit parsing (3-byte & 4-byte start codes across chunk boundaries).
 *   3. Access Unit (frame) demarcation and grouping (SPS, PPS, SEI, IDR / slices).
 *   4. Frame-based RTP timestamps (one timestamp per Access Unit, shared by all packets).
 *   5. RFC 6184 RTP marker bit (M=1 strictly on the final packet of the Access Unit).
 *   6. FFmpeg stdin backpressure management with bounded latest-frame priority queue.
 *   7. Fresh IDR keyframe recovery without restarting FFmpeg.
 */

import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

export const NAL_TYPES = {
  NON_IDR: 1,
  PARTITION_A: 2,
  PARTITION_B: 3,
  PARTITION_C: 4,
  IDR: 5,
  SEI: 6,
  SPS: 7,
  PPS: 8,
  AUD: 9,
  END_SEQUENCE: 10,
  END_STREAM: 11,
  FILLER: 12,
  FU_A: 28,
};

export const RECOVERY_STATES = {
  NORMAL: 'NORMAL',
  RECOVERY_REQUESTED: 'RECOVERY_REQUESTED',
  WAITING_FOR_IDR: 'WAITING_FOR_IDR',
  IDR_RECEIVED: 'IDR_RECEIVED',
  ERROR: 'ERROR',
};

let resolvedFfmpegPath = null;
try {
  // Dynamically resolve ffmpeg-static if installed
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

    this._sequenceNumber = 1;
    this._timestamp = 0;
    this._clockRate = 90000; // 90kHz standard video clock

    // Caches
    this.cachedSps = null;
    this.cachedPps = null;
    this.cachedKeyframe = null;
    this.lastFrameType = null;

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

    // Fresh IDR Recovery State Machine
    this._recoveryState = RECOVERY_STATES.NORMAL;
    this._frameId = 0;
    this._latestFrameId = 0;
    this._latestFrame = null;
    this._pendingKeyframePromise = null;
    this._totalRecoveryLatencyMs = 0;

    // Diagnostics & Metrics
    this.metrics = {
      inputReceived: 0,
      inputDropped: 0,
      inputPending: 0,
      encodedFrames: 0,
      keyframes: 0,
      keyframeRequests: 0,
      freshKeyframeRecoveries: 0,
      freshKeyframeFailures: 0,
      forcedIdrRequests: 0,
      forcedIdrSuccesses: 0,
      forcedIdrFailures: 0,
      lastRecoveryLatencyMs: 0,
      averageRecoveryLatencyMs: 0,
      totalEncodeLatencyMs: 0,
      maxEncodeLatencyMs: 0,
    };
    this._diagInterval = null;

    // FFmpeg process
    this.ffmpegProc = null;
    this._isEncoding = false;
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

  /**
   * Starts the continuous background FFmpeg H.264 encoding process.
   */
  start() {
    if (this.ffmpegProc) return;

    try {
      this.ffmpegProc = this._spawnEncoderProcess();
      this._isEncoding = true;
      this._waitingForDrain = false;

      this.ffmpegProc.stdout.on('data', (chunk) => {
        this._handleEncodedData(chunk);
      });

      this._setupStdin(this.ffmpegProc.stdin);

      this.ffmpegProc.stderr.on('data', (errData) => {
        const msg = errData.toString();
        if (!msg.includes('deprecated') && !msg.includes('EOI missing')) {
          this.emit('encoder_warning', msg);
        }
      });

      this.ffmpegProc.on('error', (err) => {
        this.emit('encoder_error', err);
        this.close();
      });

      this.ffmpegProc.on('close', (code) => {
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

  /**
   * Encodes an incoming JPEG frame into H.264 with bounded queue & latest-frame priority.
   */
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

    // While waiting for IDR recovery on a replacement encoder, buffer in pending queue
    if (this._recoveryState === RECOVERY_STATES.WAITING_FOR_IDR) {
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

    // If currently waiting for drain, enforce bounded queue with latest-frame priority
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

    // Safe to write immediately
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

  /**
   * Internal handler for raw Annex-B H.264 stream from FFmpeg stdout.
   */
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

    // Flush timer for idle simulator ticks (no subsequent frame encoded)
    if ((this._auHasVcl || this._streamBuffer.length > 0) && this._isEncoding) {
      this._flushTimer = setTimeout(() => {
        this._flushPending();
      }, 10);
    }
  }

  /**
   * Feeds a stream chunk into the parser and returns any emitted Access Units.
   * Useful for both live streaming and unit testing chunk boundaries.
   */
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

  /**
   * Extracts all complete NAL units and identifies the last start code in this._streamBuffer.
   */
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

  /**
   * Checks if the trailing incomplete NAL starting at lastStartCode marks the beginning of a new AU.
   * If so, the currently pending AU is complete and can be emitted immediately.
   */
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
          const currentHasIdr = this._pendingAU.some(n => n.type === NAL_TYPES.IDR);
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

  /**
   * Determines if incoming NAL unit begins a new Access Unit.
   */
  _isNewAccessUnit(nal) {
    if (this._pendingAU.length === 0) {
      return false;
    }

    // 1. AUD (Access Unit Delimiter) always begins a new Access Unit
    if (nal.type === NAL_TYPES.AUD) {
      return true;
    }

    // 2. If current AU already contains video slices (VCL NALs):
    if (this._auHasVcl) {
      // Non-VCL NALs (SPS, PPS, SEI) preceding picture slices mark the next AU
      if (nal.type === NAL_TYPES.SPS || nal.type === NAL_TYPES.PPS || nal.type === NAL_TYPES.SEI) {
        return true;
      }

      // VCL NALs (types 1 to 5):
      if (nal.type >= 1 && nal.type <= 5) {
        // In H.264 slice header, first_mb_in_slice == 0 denotes first slice of new picture.
        // In unsigned Exp-Golomb, 0 is bit '1'. So byte 1 with 0x80 bit set indicates new frame.
        if (nal.data.length > 1 && (nal.data[1] & 0x80) !== 0) {
          return true;
        }

        // Transition between IDR and Non-IDR always denotes a new picture
        const currentHasIdr = this._pendingAU.some(n => n.type === NAL_TYPES.IDR);
        if (nal.type === NAL_TYPES.IDR && !currentHasIdr) {
          return true;
        }
        if (nal.type !== NAL_TYPES.IDR && currentHasIdr) {
          return true;
        }
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

    // If there is a trailing NAL with a start code in _streamBuffer
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

  /**
   * Parses a static Annex-B buffer into individual NAL units.
   * Recognizes both 3-byte (0x000001) and 4-byte (0x00000001) start codes.
   */
  parseNalUnits(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return [];
    }

    const nalUnits = [];
    const len = buffer.length;
    const startIndices = [];

    for (let i = 0; i <= len - 3; i++) {
      if (buffer[i] === 0x00 && buffer[i + 1] === 0x00) {
        if (buffer[i + 2] === 0x01) {
          startIndices.push({ index: i, prefixLen: 3 });
          i += 2;
        } else if (i <= len - 4 && buffer[i + 2] === 0x00 && buffer[i + 3] === 0x01) {
          startIndices.push({ index: i, prefixLen: 4 });
          i += 3;
        }
      }
    }

    if (startIndices.length === 0) {
      const nalType = buffer[0] & 0x1f;
      return [{ data: buffer, type: nalType }];
    }

    for (let k = 0; k < startIndices.length; k++) {
      const current = startIndices[k];
      const start = current.index + current.prefixLen;
      const end = (k + 1 < startIndices.length) ? startIndices[k + 1].index : len;
      const nalData = buffer.subarray(start, end);

      if (nalData.length > 0) {
        const nalType = nalData[0] & 0x1f;
        nalUnits.push({ data: nalData, type: nalType });
      }
    }

    return nalUnits;
  }

  /**
   * Caches SPS, PPS, and IDR keyframe data from parsed NAL units.
   * Keeps cachedKeyframe updated to the latest keyframe state.
   */
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
      this.metrics.keyframes++;
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

  /**
   * Advances and returns the next RTP timestamp based on clock rate and FPS.
   */
  _nextRtpTimestamp(fps = this.fps) {
    const timestampDelta = Math.round(this._clockRate / fps);
    this._timestamp = (this._timestamp + timestampDelta) >>> 0;
    return this._timestamp;
  }

  /**
   * Executes controlled main encoder replacement to generate a fresh IDR and align the reference chain.
   */
  async _performMainEncoderIdrRecovery() {
    if (!this._latestFrame) {
      throw new Error('No latest JPEG frame available for keyframe recovery');
    }

    if (this._recoveryState !== RECOVERY_STATES.NORMAL && this._recoveryState !== RECOVERY_STATES.ERROR) {
      return [];
    }

    this._recoveryState = RECOVERY_STATES.RECOVERY_REQUESTED;
    const startedAt = Date.now();
    const targetFrame = this._latestFrame;
    const targetFrameId = targetFrame.id || this._latestFrameId || 1;
    const targetJpeg = Buffer.isBuffer(targetFrame) ? targetFrame : targetFrame.jpeg;

    console.log(`[video] recovery requested for frameId=${targetFrameId}`);
    console.log(`[video] forcing next frame to IDR (frameId=${targetFrameId})`);
    this._recoveryState = RECOVERY_STATES.WAITING_FOR_IDR;

    return new Promise((resolve, reject) => {
      let nextProc;
      try {
        nextProc = this._spawnEncoderProcess();
      } catch (err) {
        this._handleRecoveryFailure(err, reject);
        return;
      }

      let stdoutBuffer = Buffer.alloc(0);
      let stderrBuffer = Buffer.alloc(0);
      let resolved = false;
      const recoveryTimeout = setTimeout(() => {
        if (!resolved) {
          this._handleRecoveryFailure(
            new Error('Timeout waiting for IDR recovery frame from encoder'),
            reject,
            nextProc
          );
        }
      }, 5000);

      const onRecoverySuccess = (auNals) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(recoveryTimeout);

        try {
          this._recoveryState = RECOVERY_STATES.IDR_RECEIVED;
          console.log(`[video] IDR received for frameId=${targetFrameId}`);

          // Validate SPS, PPS, IDR
          const hasIdr = auNals.some((n) => n.type === NAL_TYPES.IDR);
          if (!hasIdr) {
            throw new Error(
              `Recovery encoder did not produce IDR. NAL types: ${auNals.map((n) => n.type).join(',')}`
            );
          }
          const hasSps = auNals.some((n) => n.type === NAL_TYPES.SPS);
          const hasPps = auNals.some((n) => n.type === NAL_TYPES.PPS);
          if (!hasSps || !hasPps) {
            throw new Error(
              `Recovery IDR missing SPS/PPS. SPS=${hasSps} PPS=${hasPps}`
            );
          }

          // Cache SPS, PPS, IDR
          this.inspectAndCacheNals(auNals);

          // Packetize IDR Access Unit through unified RTP packetizer
          const packets = this.packetizeAccessUnit(auNals, this.fps);
          if (!packets || packets.length === 0) {
            throw new Error('Fresh recovery produced no RTP packets');
          }

          const latencyMs = Date.now() - startedAt;
          const seqStart = packets[0].readUInt16BE(2);
          const seqEnd = packets[packets.length - 1].readUInt16BE(2);
          const timestamp = packets[0].readUInt32BE(4);
          const ssrc = this.ssrc;

          console.log(
            `[video] IDR recovery completed\n` +
            `frameId=${targetFrameId}\n` +
            `latencyMs=${latencyMs}\n` +
            `seqStart=${seqStart}\n` +
            `seqEnd=${seqEnd}\n` +
            `timestamp=${timestamp}\n` +
            `ssrc=${ssrc}`
          );

          this.metrics.freshKeyframeRecoveries++;
          this.metrics.forcedIdrSuccesses++;
          this.metrics.lastRecoveryLatencyMs = latencyMs;
          this._totalRecoveryLatencyMs = (this._totalRecoveryLatencyMs || 0) + latencyMs;
          this.metrics.averageRecoveryLatencyMs = Math.round(
            this._totalRecoveryLatencyMs / this.metrics.forcedIdrSuccesses
          );

          // Switch active encoder to replacement encoder
          const oldProc = this.ffmpegProc;
          this.ffmpegProc = nextProc;
          this._isEncoding = true;
          this._waitingForDrain = false;
          this._streamBuffer = Buffer.alloc(0);
          this._pendingAU = [];
          this._auHasVcl = false;

          // Retire old encoder
          if (oldProc) {
            try {
              if (oldProc.stdin) oldProc.stdin.end();
              oldProc.kill('SIGTERM');
            } catch {}
          }

          // Wire nextProc stdout into continuous stream parser
          nextProc.stdout.removeAllListeners('data');
          nextProc.stdout.on('data', (chunk) => {
            this._handleEncodedData(chunk);
          });

          // Wire nextProc stdin
          this._setupStdin(nextProc.stdin);

          // Wire nextProc stderr & error/close
          nextProc.stderr.removeAllListeners('data');
          nextProc.stderr.on('data', (errData) => {
            const msg = errData.toString();
            if (!msg.includes('deprecated') && !msg.includes('EOI missing')) {
              this.emit('encoder_warning', msg);
            }
          });

          nextProc.on('error', (err) => {
            this.emit('encoder_error', err);
            this.close();
          });

          nextProc.on('close', (code) => {
            if (this.ffmpegProc === nextProc) {
              this._isEncoding = false;
              this.ffmpegProc = null;
              this._flushPending();
              this.emit('encoder_closed', code);
            }
          });

          // Emit packets for WebRTC track
          this.emit('packets', packets);
          this.emit('fresh_keyframe_encoded', {
            packets,
            recovery: true,
            latencyMs,
            frameId: targetFrameId,
          });

          this._recoveryState = RECOVERY_STATES.NORMAL;

          // Flush any pending frames into replacement encoder — subsequent frames become P-frames referencing this IDR!
          this._flushNextPendingInput();

          resolve(packets);
        } catch (err) {
          this._handleRecoveryFailure(err, reject, nextProc);
        }
      };

      const checkOutput = () => {
        const nals = this.parseNalUnits(stdoutBuffer);
        const hasVcl = nals.some((n) => n.type >= 1 && n.type <= 5);
        if (!hasVcl) return;

        onRecoverySuccess(nals);
      };

      nextProc.stdout.on('data', (chunk) => {
        stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
        if (!resolved) {
          checkOutput();
        }
      });

      nextProc.stderr.on('data', (chunk) => {
        stderrBuffer = Buffer.concat([stderrBuffer, chunk]);
      });

      nextProc.on('error', (err) => {
        if (!resolved) {
          this._handleRecoveryFailure(err, reject, nextProc);
        }
      });

      nextProc.on('close', (code) => {
        if (!resolved) {
          const err = new Error(
            `Replacement encoder exited with code ${code}: ${stderrBuffer.toString()}`
          );
          this._handleRecoveryFailure(err, reject, nextProc);
        }
      });

      // Write target JPEG into replacement encoder stdin
      try {
        nextProc.stdin.write(targetJpeg);
      } catch (err) {
        this._handleRecoveryFailure(err, reject, nextProc);
      }
    });
  }

  _handleRecoveryFailure(err, reject, nextProc = null) {
    this._recoveryState = RECOVERY_STATES.ERROR;
    this.metrics.freshKeyframeFailures++;
    this.metrics.forcedIdrFailures++;
    console.error(`[video] IDR recovery failed: ${err.message}`);
    this.emit('encoder_warning', `IDR recovery failed: ${err.message}`);

    if (nextProc) {
      try {
        if (nextProc.stdin) nextProc.stdin.end();
        nextProc.kill('SIGTERM');
      } catch {}
    }

    this._recoveryState = RECOVERY_STATES.NORMAL;
    reject(err);
  }

  /**
   * Handles client keyframe requests with request coalescing.
   */
  requestKeyframe() {
    this.metrics.keyframeRequests++;
    this.metrics.forcedIdrRequests++;

    console.log(
      `[video] keyframe request received ` +
      `(request count: ${this.metrics.keyframeRequests})`
    );

    this.emit('keyframe_requested', {
      count: this.metrics.keyframeRequests,
    });

    if (this._pendingKeyframePromise) {
      return this._pendingKeyframePromise;
    }

    this._pendingKeyframePromise = this._performMainEncoderIdrRecovery().finally(() => {
      this._pendingKeyframePromise = null;
    });

    return this._pendingKeyframePromise;
  }

  /**
   * Returns RFC 6184 RTP packets for the cached keyframe with fresh RTP timestamp & sequence numbers.
   */
  getKeyframePackets() {
    if (!this.hasKeyframe()) return [];
    return this.packetize(this.cachedKeyframe, this.fps);
  }

  /**
   * Packetizes an entire Access Unit (frame) into RFC 6184 compliant RTP packets.
   * Invariants:
   *  1. Exactly ONE RTP timestamp increment per Access Unit.
   *  2. ALL RTP packets of the Access Unit share the EXACT same timestamp.
   *  3. Marker bit (M=1) is set ONLY on the final RTP packet of the complete Access Unit.
   */
  packetizeAccessUnit(accessUnitNals, fps = 30) {
    if (!Array.isArray(accessUnitNals) || accessUnitNals.length === 0) {
      return [];
    }

    const frameTimestamp = this._nextRtpTimestamp(fps);

    const packets = [];
    const maxPayloadSize = this.mtu - 12; // 12-byte RTP header

    for (let u = 0; u < accessUnitNals.length; u++) {
      const nal = accessUnitNals[u];
      const nalData = nal.data;
      const isLastNalOfAU = (u === accessUnitNals.length - 1);

      if (nalData.length <= maxPayloadSize) {
        // Single NAL Unit Packet (RFC 6184 Section 5.6)
        const isLastPacketOfAU = isLastNalOfAU;
        const rtp = Buffer.alloc(12 + nalData.length);
        rtp[0] = 0x80;
        rtp[1] = (isLastPacketOfAU ? 0x80 : 0x00) | (this.payloadType & 0x7f);
        rtp.writeUInt16BE(this._sequenceNumber & 0xffff, 2);
        this._sequenceNumber = (this._sequenceNumber + 1) & 0xffff;
        rtp.writeUInt32BE(frameTimestamp, 4);
        rtp.writeUInt32BE(this.ssrc, 8);
        nalData.copy(rtp, 12);
        rtp.timestamp = frameTimestamp;
        rtp.marker = isLastPacketOfAU ? 1 : 0;
        packets.push(rtp);
      } else {
        // FU-A Fragmentation Units (RFC 6184 Section 5.8)
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
          const isLastPacketOfAU = isLastNalOfAU && isEnd;

          let fuHeader = originalType & 0x1f;
          if (isStart) fuHeader |= 0x80;
          if (isEnd) fuHeader |= 0x40;

          const chunkStart = i * maxFuPayload;
          const chunkEnd = Math.min(chunkStart + maxFuPayload, payloadData.length);
          const chunk = payloadData.subarray(chunkStart, chunkEnd);

          const rtp = Buffer.alloc(12 + 2 + chunk.length);
          rtp[0] = 0x80;
          rtp[1] = (isLastPacketOfAU ? 0x80 : 0x00) | (this.payloadType & 0x7f);
          rtp.writeUInt16BE(this._sequenceNumber & 0xffff, 2);
          this._sequenceNumber = (this._sequenceNumber + 1) & 0xffff;
          rtp.writeUInt32BE(frameTimestamp, 4);
          rtp.writeUInt32BE(this.ssrc, 8);

          rtp[12] = fuIndicator;
          rtp[13] = fuHeader;
          chunk.copy(rtp, 14);
          rtp.timestamp = frameTimestamp;
          rtp.marker = isLastPacketOfAU ? 1 : 0;
          packets.push(rtp);
        }
      }
    }

    return packets;
  }

  /**
   * Compatibility method: packetizes NAL units as an Access Unit.
   */
  packetizeNalUnits(nalUnits, fps = 30) {
    return this.packetizeAccessUnit(nalUnits, fps);
  }

  /**
   * Convenience method to parse buffer and packetize into RTP packets.
   */
  packetize(frameBuffer, fps = 30) {
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

  _startDiagnostics() {
    if (this._diagInterval) return;
    this._diagInterval = setInterval(() => {
      if (this.metrics.inputReceived > 0 || this.metrics.encodedFrames > 0) {
        const avgLatency = this.metrics.encodedFrames > 0
          ? Math.round(this.metrics.totalEncodeLatencyMs / this.metrics.encodedFrames)
          : 0;
        this.emit('diagnostics', {
          received: this.metrics.inputReceived,
          encoded: this.metrics.encodedFrames,
          dropped: this.metrics.inputDropped,
          pending: this.metrics.inputPending,
          keyframes: this.metrics.keyframes,
          keyframeRequests: this.metrics.keyframeRequests,
          avgLatencyMs: avgLatency,
          maxLatencyMs: this.metrics.maxEncodeLatencyMs,
        });
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
    this._hasDrainListener = false;

    this._recoveryState = RECOVERY_STATES.NORMAL;
    this._pendingKeyframePromise = null;
  }
}
