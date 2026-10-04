import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import * as esmBase from '../src/media/BaseVideoEncoder.js';
import * as esmHw from '../src/media/HardwareH264Encoder.js';
import * as esmSw from '../src/media/SoftwareH264Encoder.js';
import * as esmDetector from '../src/media/EncoderDetector.js';
import * as esmVideo from '../src/media/VideoEncoder.js';
import * as esmAdaptive from '../src/media/AdaptiveQualityController.js';

const require = createRequire(import.meta.url);
const cjsBase = require('../templates/peer/BaseVideoEncoder.cjs');
const cjsHw = require('../templates/peer/HardwareH264Encoder.cjs');
const cjsSw = require('../templates/peer/SoftwareH264Encoder.cjs');
const cjsDetector = require('../templates/peer/EncoderDetector.cjs');
const cjsVideo = require('../templates/peer/VideoEncoder.cjs');
const cjsAdaptive = require('../templates/peer/AdaptiveQualityController.cjs');

test('Drift Detection: BaseVideoEncoder exports and NAL constants match', () => {
  assert.ok(esmBase.BaseVideoEncoder);
  assert.ok(cjsBase.BaseVideoEncoder);

  assert.deepEqual(esmBase.NAL_TYPES, cjsBase.NAL_TYPES);
  assert.deepEqual(esmBase.RECOVERY_STATES, cjsBase.RECOVERY_STATES);

  const esmProto = Object.getOwnPropertyNames(esmBase.BaseVideoEncoder.prototype);
  const cjsProto = Object.getOwnPropertyNames(cjsBase.BaseVideoEncoder.prototype);

  const criticalMethods = [
    'reconfigure',
    'requestKeyframe',
    'setBitrate',
    'setFramerate',
    'setResolution',
    'hasKeyframe',
    'getKeyframe',
    'getKeyframePackets',
    'buildFfmpegArgs',
    'close',
  ];

  for (const m of criticalMethods) {
    assert.ok(esmProto.includes(m), `ESM BaseVideoEncoder missing ${m}`);
    assert.ok(cjsProto.includes(m), `CJS BaseVideoEncoder missing ${m}`);
  }
});

test('Drift Detection: Hardware and Software encoder subclasses match', () => {
  const esmHwInst = new esmHw.HardwareH264Encoder({ fps: 30, bitrateKbps: 2000, width: 720, height: 1280 });
  const cjsHwInst = new cjsHw.HardwareH264Encoder({ fps: 30, bitrateKbps: 2000, width: 720, height: 1280 });

  assert.equal(esmHwInst.isHardware, cjsHwInst.isHardware);
  assert.equal(esmHwInst.encoderName, cjsHwInst.encoderName);
  assert.deepEqual(esmHwInst.buildFfmpegArgs(), cjsHwInst.buildFfmpegArgs());

  const esmSwInst = new esmSw.SoftwareH264Encoder({ fps: 24, bitrateKbps: 1500, width: 480, height: 854 });
  const cjsSwInst = new cjsSw.SoftwareH264Encoder({ fps: 24, bitrateKbps: 1500, width: 480, height: 854 });

  assert.equal(esmSwInst.isHardware, cjsSwInst.isHardware);
  assert.equal(esmSwInst.encoderName, cjsSwInst.encoderName);
  assert.deepEqual(esmSwInst.buildFfmpegArgs(), cjsSwInst.buildFfmpegArgs());
});

test('Drift Detection: EncoderDetector exports match', () => {
  assert.equal(typeof esmDetector.detectH264Encoder, 'function');
  assert.equal(typeof cjsDetector.detectH264Encoder, 'function');

  assert.equal(typeof esmDetector.verifyEncoderRealRuntime, 'function');
  assert.equal(typeof cjsDetector.verifyEncoderRealRuntime, 'function');

  assert.equal(typeof esmDetector.resetEncoderDetectionCache, 'function');
  assert.equal(typeof cjsDetector.resetEncoderDetectionCache, 'function');
});

test('Drift Detection: AdaptiveQualityController profiles and methods match', () => {
  assert.deepEqual(esmAdaptive.QUALITY_PROFILES, cjsAdaptive.QUALITY_PROFILES);

  const esmCtrl = new esmAdaptive.AdaptiveQualityController();
  const cjsCtrl = new cjsAdaptive.AdaptiveQualityController();

  assert.equal(esmCtrl.currentLevel, cjsCtrl.currentLevel);
  assert.deepEqual(esmCtrl.profile, cjsCtrl.profile);
  assert.equal(typeof esmCtrl.evaluateTelemetry, 'function');
  assert.equal(typeof cjsCtrl.evaluateTelemetry, 'function');
  assert.equal(typeof esmCtrl.setProfile, 'function');
  assert.equal(typeof cjsCtrl.setProfile, 'function');
});
