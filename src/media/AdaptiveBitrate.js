/**
 * Flutter Remote WebRTC V2 Adaptive Bitrate Controller
 *
 * Dynamically adjusts video resolution, FPS, and bitrate based on:
 *   - RTT
 *   - Packet loss
 *   - Dropped frames
 *
 * CRITICAL INVARIANT: Video quality adjustments NEVER degrade or delay input.
 */

import { EventEmitter } from 'node:events';
import { VIDEO_PRESETS } from '../shared/constants.js';
import { logger } from '../shared/logger.js';

export class AdaptiveBitrate extends EventEmitter {
  constructor(options = {}) {
    super();
    this.currentLevel = options.initialLevel || 'MEDIUM';
    this.preset = { ...VIDEO_PRESETS[this.currentLevel] };
    this._consecutiveGoodSamples = 0;
    this._consecutiveBadSamples = 0;
  }

  evaluateMetrics({ rtt = 50, packetLoss = 0, droppedFrames = 0 }) {
    // Bad conditions: RTT > 200ms or packet loss > 3% or dropped frames > 5
    const isDegraded = rtt > 200 || packetLoss > 0.03 || droppedFrames > 5;
    // Excellent conditions: RTT < 60ms and packet loss < 0.5% and dropped frames == 0
    const isExcellent = rtt < 60 && packetLoss < 0.005 && droppedFrames === 0;

    if (isDegraded) {
      this._consecutiveGoodSamples = 0;
      this._consecutiveBadSamples++;

      if (this._consecutiveBadSamples >= 2) {
        this._downgrade();
        this._consecutiveBadSamples = 0;
      }
    } else if (isExcellent) {
      this._consecutiveBadSamples = 0;
      this._consecutiveGoodSamples++;

      if (this._consecutiveGoodSamples >= 5) {
        this._upgrade();
        this._consecutiveGoodSamples = 0;
      }
    } else {
      this._consecutiveGoodSamples = 0;
      this._consecutiveBadSamples = 0;
    }

    return this.preset;
  }

  _downgrade() {
    let nextLevel = this.currentLevel;
    if (this.currentLevel === 'HIGH') {
      nextLevel = 'MEDIUM';
    } else if (this.currentLevel === 'MEDIUM') {
      nextLevel = 'LOW';
    }

    if (nextLevel !== this.currentLevel) {
      this.currentLevel = nextLevel;
      this.preset = { ...VIDEO_PRESETS[this.currentLevel] };
      logger.info('media.quality_downgraded', { level: this.currentLevel, preset: this.preset });
      this.emit('quality_change', { level: this.currentLevel, preset: this.preset });
    }
  }

  _upgrade() {
    let nextLevel = this.currentLevel;
    if (this.currentLevel === 'LOW') {
      nextLevel = 'MEDIUM';
    } else if (this.currentLevel === 'MEDIUM') {
      nextLevel = 'HIGH';
    }

    if (nextLevel !== this.currentLevel) {
      this.currentLevel = nextLevel;
      this.preset = { ...VIDEO_PRESETS[this.currentLevel] };
      logger.info('media.quality_upgraded', { level: this.currentLevel, preset: this.preset });
      this.emit('quality_change', { level: this.currentLevel, preset: this.preset });
    }
  }
}
