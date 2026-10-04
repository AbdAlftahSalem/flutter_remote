import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveQualityController, QUALITY_PROFILES } from '../src/media/AdaptiveQualityController.js';
import { AdaptiveQualityController as AdaptiveQualityControllerCjs } from '../templates/peer/AdaptiveQualityController.cjs';

for (const [name, ControllerClass] of [
  ['ESM AdaptiveQualityController', AdaptiveQualityController],
  ['CJS AdaptiveQualityController', AdaptiveQualityControllerCjs],
]) {
  test(`${name}: initializes with default MEDIUM profile and targets`, () => {
    const controller = new ControllerClass();
    assert.equal(controller.currentLevel, 'MEDIUM');
    assert.deepEqual(controller.profile, QUALITY_PROFILES.MEDIUM);
    assert.equal(controller.profile.bitrateKbps, 1500);
    assert.equal(controller.profile.fps, 24);
  });

  test(`${name}: downgrades to LOW on severe network degradation`, () => {
    const reconfigured = [];
    const mockEncoder = {
      reconfigure: (p) => reconfigured.push(p),
    };

    const controller = new ControllerClass({
      videoEncoder: mockEncoder,
      initialLevel: 'HIGH',
      downgradeCooldownMs: 0,
    });

    controller.evaluateTelemetry({ rtt: 350, packetLoss: 0.08, droppedFrames: 15 });

    assert.equal(controller.currentLevel, 'LOW');
    assert.equal(reconfigured.length, 1);
    assert.equal(reconfigured[0].bitrateKbps, QUALITY_PROFILES.LOW.bitrateKbps);
    assert.equal(reconfigured[0].fps, QUALITY_PROFILES.LOW.fps);
  });

  test(`${name}: stepwise downgrades on moderate network degradation with min consecutive samples`, () => {
    const reconfigured = [];
    const mockEncoder = {
      reconfigure: (p) => reconfigured.push(p),
    };

    const controller = new ControllerClass({
      videoEncoder: mockEncoder,
      initialLevel: 'HIGH',
      downgradeCooldownMs: 0,
      minConsecutiveBadSamples: 2,
    });

    // 1st degraded sample: shouldn't trigger downgrade yet
    controller.evaluateTelemetry({ rtt: 190, packetLoss: 0.03, droppedFrames: 0 });
    assert.equal(controller.currentLevel, 'HIGH');
    assert.equal(reconfigured.length, 0);

    // 2nd degraded sample: satisfies minConsecutiveBadSamples
    controller.evaluateTelemetry({ rtt: 200, packetLoss: 0.035, droppedFrames: 1 });
    assert.equal(controller.currentLevel, 'MEDIUM');
    assert.equal(reconfigured.length, 1);
    assert.equal(reconfigured[0].bitrateKbps, QUALITY_PROFILES.MEDIUM.bitrateKbps);
  });

  test(`${name}: requires consecutive healthy samples and cooldown before upgrading`, () => {
    const reconfigured = [];
    const mockEncoder = {
      reconfigure: (p) => reconfigured.push(p),
    };

    const controller = new ControllerClass({
      videoEncoder: mockEncoder,
      initialLevel: 'LOW',
      upgradeCooldownMs: 0, // 0 for test determinism
      minConsecutiveGoodSamples: 3,
    });

    // Healthy sample 1
    controller.evaluateTelemetry({ rtt: 30, packetLoss: 0, droppedFrames: 0 });
    assert.equal(controller.currentLevel, 'LOW');

    // Healthy sample 2
    controller.evaluateTelemetry({ rtt: 25, packetLoss: 0, droppedFrames: 0 });
    assert.equal(controller.currentLevel, 'LOW');

    // Healthy sample 3: hits minConsecutiveGoodSamples -> upgrades to MEDIUM
    controller.evaluateTelemetry({ rtt: 28, packetLoss: 0, droppedFrames: 0 });
    assert.equal(controller.currentLevel, 'MEDIUM');
    assert.equal(reconfigured.length, 1);
    assert.equal(reconfigured[0].bitrateKbps, QUALITY_PROFILES.MEDIUM.bitrateKbps);
  });

  test(`${name}: respects upgrade cooldown period (prevents oscillation)`, () => {
    const reconfigured = [];
    const mockEncoder = {
      reconfigure: (p) => reconfigured.push(p),
    };

    const controller = new ControllerClass({
      videoEncoder: mockEncoder,
      initialLevel: 'LOW',
      upgradeCooldownMs: 10000,
      minConsecutiveGoodSamples: 1,
    });

    // Immediately after init, timeSinceLastTransition is near 0 < 10000ms
    controller.evaluateTelemetry({ rtt: 20, packetLoss: 0, droppedFrames: 0 });
    assert.equal(controller.currentLevel, 'LOW');
    assert.equal(reconfigured.length, 0);

    // Simulate time elapsed past cooldown
    controller._lastTransitionTime = Date.now() - 11000;
    controller.evaluateTelemetry({ rtt: 20, packetLoss: 0, droppedFrames: 0 });
    assert.equal(controller.currentLevel, 'MEDIUM');
    assert.equal(reconfigured.length, 1);
  });

  test(`${name}: manual setProfile overrides level and reconfigures encoder`, () => {
    const reconfigured = [];
    const mockEncoder = {
      reconfigure: (p) => reconfigured.push(p),
    };

    const controller = new ControllerClass({
      videoEncoder: mockEncoder,
      initialLevel: 'LOW',
    });

    controller.setProfile('HIGH');
    assert.equal(controller.currentLevel, 'HIGH');
    assert.equal(reconfigured.length, 1);
    assert.equal(reconfigured[0].bitrateKbps, QUALITY_PROFILES.HIGH.bitrateKbps);
  });
}
