/**
 * Flutter Remote Adaptive Quality Controller
 *
 * Owns dynamic video quality adaptation across WebRTC connections:
 *   - Evaluates network telemetry (RTT, packet loss, jitter, dropped frames)
 *   - Employs asymmetric hysteresis to avoid profile oscillation:
 *       - Rapid downgrade on degradation (short cooldown)
 *       - Conservative upgrade on sustained healthy connection (long cooldown)
 *   - Directly reconfigures the underlying video encoder
 */

import { EventEmitter } from 'node:events';
import { VIDEO_PRESETS } from '../shared/constants.js';
import { logger } from '../shared/logger.js';

export const QUALITY_PROFILES = {
  LOW: { ...VIDEO_PRESETS.LOW },
  MEDIUM: { ...VIDEO_PRESETS.MEDIUM },
  HIGH: { ...VIDEO_PRESETS.HIGH },
};

export class AdaptiveQualityController extends EventEmitter {
  constructor(options = {}) {
    super();
    this.videoEncoder = options.videoEncoder || null;
    this.currentLevel = options.initialLevel || 'MEDIUM';
    this.profile = { ...(QUALITY_PROFILES[this.currentLevel] || QUALITY_PROFILES.MEDIUM) };

    this.upgradeCooldownMs = options.upgradeCooldownMs !== undefined ? options.upgradeCooldownMs : 8000;
    this.downgradeCooldownMs = options.downgradeCooldownMs !== undefined ? options.downgradeCooldownMs : 2000;
    this.minConsecutiveGoodSamples = options.minConsecutiveGoodSamples !== undefined ? options.minConsecutiveGoodSamples : 4;
    this.minConsecutiveBadSamples = options.minConsecutiveBadSamples !== undefined ? options.minConsecutiveBadSamples : 2;

    this._lastTransitionTime = Date.now();
    this._consecutiveGoodSamples = 0;
    this._consecutiveBadSamples = 0;
    this._lastTelemetry = null;
  }

  evaluateTelemetry(telemetry = {}) {
    this._lastTelemetry = { ...telemetry, receivedAt: Date.now() };
    const rtt = Number(telemetry.rtt || 0);
    const packetLoss = Number(telemetry.packetLoss || 0);
    const droppedFrames = Number(telemetry.droppedFrames || 0);

    const isSevere = rtt > 300 || packetLoss > 0.05 || droppedFrames > 10;
    const isDegraded = rtt > 180 || packetLoss > 0.025 || droppedFrames > 4;
    const isHealthy = rtt < 75 && packetLoss < 0.005 && droppedFrames === 0;

    const now = Date.now();
    const timeSinceLastTransition = now - this._lastTransitionTime;

    if (isSevere) {
      this._consecutiveGoodSamples = 0;
      this._consecutiveBadSamples += 2;
      if (this.currentLevel !== 'LOW' && timeSinceLastTransition >= this.downgradeCooldownMs) {
        this._applyLevel('LOW', 'severe_network_degradation');
        return this.profile;
      }
    } else if (isDegraded) {
      this._consecutiveGoodSamples = 0;
      this._consecutiveBadSamples++;
      if (this._consecutiveBadSamples >= this.minConsecutiveBadSamples && timeSinceLastTransition >= this.downgradeCooldownMs) {
        this._downgradeStep('moderate_network_degradation');
        this._consecutiveBadSamples = 0;
        return this.profile;
      }
    } else if (isHealthy) {
      this._consecutiveBadSamples = 0;
      this._consecutiveGoodSamples++;
      if (this._consecutiveGoodSamples >= this.minConsecutiveGoodSamples && timeSinceLastTransition >= this.upgradeCooldownMs) {
        this._upgradeStep('sustained_healthy_connection');
        this._consecutiveGoodSamples = 0;
        return this.profile;
      }
    } else {
      // Neutral sample, dampen counters
      if (this._consecutiveGoodSamples > 0) this._consecutiveGoodSamples--;
      if (this._consecutiveBadSamples > 0) this._consecutiveBadSamples--;
    }

    return this.profile;
  }

  _downgradeStep(reason) {
    if (this.currentLevel === 'HIGH') {
      this._applyLevel('MEDIUM', reason);
    } else if (this.currentLevel === 'MEDIUM') {
      this._applyLevel('LOW', reason);
    }
  }

  _upgradeStep(reason) {
    if (this.currentLevel === 'LOW') {
      this._applyLevel('MEDIUM', reason);
    } else if (this.currentLevel === 'MEDIUM') {
      this._applyLevel('HIGH', reason);
    }
  }

  _applyLevel(level, reason = 'manual') {
    if (!QUALITY_PROFILES[level]) return;
    const prevLevel = this.currentLevel;
    if (prevLevel === level) return;

    this.currentLevel = level;
    this.profile = { ...QUALITY_PROFILES[level] };
    this._lastTransitionTime = Date.now();

    logger.info('quality.profile_changed', {
      previous: prevLevel,
      current: this.currentLevel,
      profile: this.profile,
      reason,
    });

    if (this.videoEncoder && typeof this.videoEncoder.reconfigure === 'function') {
      this.videoEncoder.reconfigure(this.profile);
    }

    this.emit('profile_changed', {
      previous: prevLevel,
      current: this.currentLevel,
      profile: this.profile,
      reason,
    });
  }

  setProfile(level) {
    this._applyLevel(level, 'manual_override');
  }

  get status() {
    return {
      level: this.currentLevel,
      profile: { ...this.profile },
      lastTransitionTime: this._lastTransitionTime,
      lastTelemetry: this._lastTelemetry ? { ...this._lastTelemetry } : null,
    };
  }
}
