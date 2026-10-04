import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BaseVideoEncoder } from '../src/media/BaseVideoEncoder.js';
import { SoftwareH264Encoder } from '../src/media/SoftwareH264Encoder.js';
import { ProcessSupervisor, PROCESS_STATES } from '../src/session/ProcessSupervisor.js';

class MockProcess extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdin = new EventEmitter();
    this.stdin.writable = true;
    this.stdin.write = () => true;
    this.stdin.end = () => {};
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
  }

  kill(signal = 'SIGTERM') {
    this.killed = true;
    setTimeout(() => {
      this.emit('close', signal === 'SIGKILL' ? 137 : 0, signal);
    }, 10);
    return true;
  }
}

class TestableEncoder extends BaseVideoEncoder {
  constructor(options = {}) {
    super({
      ...options,
      encoderName: 'testable',
    });
    this.nextPid = 70001;
    this.spawnedProcesses = [];
  }

  buildFfmpegArgs() {
    return [
      '-vf', `scale=${this.width}:${this.height}`,
      '-b:v', `${this.bitrateKbps}k`,
      '-g', String(this.fps),
    ];
  }

  _spawnEncoderProcess() {
    const proc = new MockProcess(this.nextPid++);
    this.spawnedProcesses.push(proc);
    return proc;
  }
}

test('Phase 25: BaseVideoEncoder reconfigure triggers controlled restart and SPS/PPS invalidation', () => {
  const encoder = new TestableEncoder({ fps: 30, bitrateKbps: 2500, width: 720, height: 1280 });
  encoder.start();

  const firstProc = encoder.ffmpegProc;
  assert.ok(firstProc);
  assert.equal(firstProc.pid, 70001);

  // Set initial fake SPS/PPS in keyframe controller
  encoder.keyframeController.cachedSps = Buffer.from([0x67, 0x01]);
  encoder.keyframeController.cachedPps = Buffer.from([0x68, 0x02]);
  encoder.keyframeController.cachedKeyframe = Buffer.from([0x65, 0x03]);

  let qualityChangedEvent = null;
  encoder.on('quality_changed', (evt) => {
    qualityChangedEvent = evt;
  });

  // Reconfigure to LOW profile
  const reconfigured = encoder.reconfigure({ width: 480, height: 854, fps: 15, bitrateKbps: 600 });
  assert.equal(reconfigured, true);

  // Verify parameters updated
  assert.equal(encoder.width, 480);
  assert.equal(encoder.height, 854);
  assert.equal(encoder.fps, 15);
  assert.equal(encoder.bitrateKbps, 600);

  // Verify quality_changed event
  assert.ok(qualityChangedEvent);
  assert.equal(qualityChangedEvent.bitrateKbps, 600);
  assert.equal(qualityChangedEvent.fps, 15);
  assert.equal(qualityChangedEvent.width, 480);
  assert.equal(qualityChangedEvent.height, 854);
  assert.equal(qualityChangedEvent.previous.bitrateKbps, 2500);

  // Verify old cached SPS/PPS were invalidated so client doesn't receive stale headers
  assert.equal(encoder.keyframeController.cachedSps, null);
  assert.equal(encoder.keyframeController.cachedPps, null);
  assert.equal(encoder.keyframeController.cachedKeyframe, null);

  // Verify replacement encoder process was promoted
  const secondProc = encoder.ffmpegProc;
  assert.ok(secondProc);
  assert.equal(secondProc.pid, 70002);
  assert.equal(firstProc.killed, true);

  encoder.close();
});

test('Phase 25: BaseVideoEncoder delegates setBitrate, setFramerate, and setResolution to reconfigure', () => {
  const encoder = new TestableEncoder({ fps: 30, bitrateKbps: 2500, width: 720, height: 1280 });

  encoder.setBitrate(1800);
  assert.equal(encoder.bitrateKbps, 1800);

  encoder.setFramerate(24);
  assert.equal(encoder.fps, 24);

  encoder.setResolution(1080, 1920);
  assert.equal(encoder.width, 1080);
  assert.equal(encoder.height, 1920);
});

test('Phase 25: BaseVideoEncoder integrates with ProcessSupervisor', async () => {
  const supervisor = new ProcessSupervisor('video-test');
  const encoder = new TestableEncoder({
    fps: 30,
    bitrateKbps: 2500,
    supervisor,
  });

  encoder.start();
  const pid1 = encoder.ffmpegProc.pid;
  assert.ok(pid1);

  // Verify tracked in supervisor
  const tracked1 = supervisor.getProcess(pid1);
  assert.ok(tracked1);
  assert.equal(tracked1.state, PROCESS_STATES.RUNNING);

  // Reconfigure triggers replacement and retires pid1
  encoder.reconfigure({ bitrateKbps: 1200 });
  const pid2 = encoder.ffmpegProc.pid;
  assert.notEqual(pid1, pid2);

  const tracked2 = supervisor.getProcess(pid2);
  assert.ok(tracked2);
  assert.equal(tracked2.state, PROCESS_STATES.RUNNING);

  // Close encoder terminates tracked process
  encoder.close();
});
