import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { FrameController } from '../src/media/FrameController.js';
import { BaseVideoEncoder } from '../src/media/BaseVideoEncoder.js';
import { AdaptiveQualityController } from '../src/media/AdaptiveQualityController.js';
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

test('Stability: FrameController bounded queue depth and zero memory leak during continuous frame bursts', async () => {
  const iterations = Number(process.env.FLUTTER_REMOTE_STABILITY_ITERATIONS || 500);
  const frameController = new FrameController({ maxQueueSize: 2 });

  if (global.gc) global.gc();
  const initialMemory = process.memoryUsage().heapUsed;

  const testPayload = Buffer.alloc(4096, 0x5a);

  for (let i = 0; i < iterations; i++) {
    frameController.pushFrame(testPayload);
    // Invariant: queue depth must never exceed maxQueueSize (2)
    assert.ok(frameController.queueLength <= 2, `Queue depth ${frameController.queueLength} exceeded limit 2 at iteration ${i}`);
  }

  // Queue must be exactly at maxQueueSize (2)
  assert.equal(frameController.queueLength, 2);
  assert.equal(frameController.totalFramesDropped, iterations - 2);

  if (global.gc) global.gc();
  const finalMemory = process.memoryUsage().heapUsed;
  const memoryDeltaMb = (finalMemory - initialMemory) / (1024 * 1024);

  // Memory delta must not blow up
  assert.ok(memoryDeltaMb < 15, `Memory grew by ${memoryDeltaMb.toFixed(2)} MB, potential leak detected`);

  frameController.clear();
  assert.equal(frameController.queueLength, 0);
});

test('Stability: Repeated quality reconfigurations do not leak processes or crash supervisor', async () => {
  const supervisor = new ProcessSupervisor('stability-test');
  let fakePidCounter = 8000;

  class MockReconfigurableEncoder extends BaseVideoEncoder {
    constructor() {
      super({ supervisor, encoderName: 'reconfig-test' });
    }
    buildFfmpegArgs() {
      return ['-f', 'null', '-'];
    }
    _spawnEncoderProcess() {
      return new MockProcess(++fakePidCounter);
    }
  }

  const encoder = new MockReconfigurableEncoder();
  const qualityController = new AdaptiveQualityController({
    videoEncoder: encoder,
    upgradeCooldownMs: 0,
    downgradeCooldownMs: 0,
    minConsecutiveGoodSamples: 1,
    minConsecutiveBadSamples: 1,
  });

  encoder.start();
  const initialPid = encoder.ffmpegProc.pid;
  assert.ok(initialPid);
  assert.equal(supervisor.getProcess(initialPid).state, PROCESS_STATES.RUNNING);

  // Cycle through quality profiles repeatedly
  const profiles = ['LOW', 'MEDIUM', 'HIGH', 'MEDIUM', 'LOW', 'HIGH'];
  for (const prof of profiles) {
    qualityController.setProfile(prof);
    assert.equal(qualityController.currentLevel, prof);
    const activePid = encoder.ffmpegProc.pid;
    assert.ok(activePid);
    assert.equal(supervisor.getProcess(activePid).state, PROCESS_STATES.RUNNING);
  }

  // Allow close callbacks for retired processes to finish
  await new Promise((r) => setTimeout(r, 50));

  // The final active encoder process is running and tracked
  const currentPid = encoder.ffmpegProc.pid;
  assert.equal(supervisor.getProcess(currentPid).state, PROCESS_STATES.RUNNING);

  // Clean shutdown terminates the encoder
  encoder.close();
  assert.equal(encoder.health.running, false);
});
