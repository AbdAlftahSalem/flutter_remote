import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PortManager } from '../src/config/PortManager.js';
import { ProcessSupervisor, PROCESS_STATES } from '../src/session/ProcessSupervisor.js';
import {
  validateGeneration,
  validateControlMessage,
  validateClipboardMessage,
} from '../src/shared/validation.js';
import { SessionError } from '../src/shared/errors.js';

test('Phase 23: PortManager collision detection and port reservation', async () => {
  const pm = new PortManager({
    gateway: 4100,
    preview: 4101,
    signaling: 4102,
    agent: 4103,
  });

  assert.equal(pm.getPort('gateway'), 4100);
  assert.equal(pm.getPort('preview'), 4101);

  // Collision detection
  assert.throws(
    () => pm.setPort('preview', 4100),
    (err) => err instanceof SessionError && err.message.includes('Port collision detected')
  );

  // Out of range port numbers
  assert.throws(() => pm.setPort('gateway', -1), SessionError);
  assert.throws(() => pm.setPort('gateway', 70000), SessionError);
  assert.throws(() => pm.setPort('gateway', 'not-a-number'), SessionError);

  // Dynamic available port lookup
  const dynamicPort = await pm.findAvailablePort(4500);
  assert.ok(dynamicPort >= 4500);
  assert.ok(pm.allocatedDynamicPorts.has(dynamicPort));

  pm.releasePort(dynamicPort);
  assert.ok(!pm.allocatedDynamicPorts.has(dynamicPort));

  pm.releaseAll();
  assert.equal(pm.allocatedDynamicPorts.size, 0);
});

test('Phase 23: ProcessSupervisor lifecycle tracking and termination escalation', async () => {
  const supervisor = new ProcessSupervisor('test-session');

  // Create a mock child process
  class MockChildProcess extends EventEmitter {
    constructor(pid) {
      super();
      this.pid = pid;
      this.signalsReceived = [];
    }

    kill(signal = 'SIGTERM') {
      this.signalsReceived.push(signal);
      // Simulate asynchronous process exit on SIGTERM
      setTimeout(() => {
        this.emit('close', 0, signal);
      }, 20);
      return true;
    }
  }

  const mockChild = new MockChildProcess(99001);
  const tracked = supervisor.trackProcess(99001, 'ffmpeg-encoder', 3200, mockChild);

  assert.equal(tracked.pid, 99001);
  assert.equal(tracked.state, PROCESS_STATES.RUNNING);
  assert.equal(supervisor.runningProcesses.length, 1);

  // Terminate process with SIGTERM
  await supervisor.terminateProcess(99001, { timeoutMs: 500 });
  assert.equal(tracked.state, PROCESS_STATES.DEAD);
  assert.ok(mockChild.signalsReceived.includes('SIGTERM'));

  // Test escalation to SIGKILL if SIGTERM is ignored
  class StubbornProcess extends EventEmitter {
    constructor(pid) {
      super();
      this.pid = pid;
      this.signalsReceived = [];
    }

    kill(signal = 'SIGTERM') {
      this.signalsReceived.push(signal);
      // Do not exit on SIGTERM, only exit on SIGKILL
      if (signal === 'SIGKILL') {
        setTimeout(() => {
          this.emit('close', 137, 'SIGKILL');
        }, 10);
      }
      return true;
    }
  }

  const stubborn = new StubbornProcess(99002);
  supervisor.trackProcess(99002, 'stubborn-daemon', 3201, stubborn);

  await supervisor.terminateProcess(99002, { timeoutMs: 50 });
  assert.ok(stubborn.signalsReceived.includes('SIGTERM'));
  assert.ok(stubborn.signalsReceived.includes('SIGKILL'));

  // Terminate all
  const p3 = new MockChildProcess(99003);
  supervisor.trackProcess(99003, 'worker', null, p3);
  await supervisor.terminateAll({ timeoutMs: 100 });
  assert.equal(supervisor.runningProcesses.length, 0);
});

test('Phase 23: Strict generation and protocol validation', () => {
  // Generation validation: returns true for valid/current generations, false for stale
  assert.equal(validateGeneration(1, 1), true);
  assert.equal(validateGeneration(5, 4), true);
  assert.equal(validateGeneration(3, 3), true);
  assert.equal(validateGeneration(2, 5), false); // Stale generation dropped

  // Control message validation
  assert.doesNotThrow(() => validateControlMessage({ type: 'request_keyframe' }));
  assert.doesNotThrow(() => validateControlMessage({ type: 'quality', level: 'high' }));
  assert.doesNotThrow(() => validateControlMessage({ type: 'bitrate', kbps: 2000 }));
  assert.doesNotThrow(() => validateControlMessage({ type: 'resize', width: 720, height: 1280 }));

  assert.throws(() => validateControlMessage(null), SessionError);
  assert.throws(() => validateControlMessage({}), SessionError);
  assert.throws(() => validateControlMessage({ type: 123 }), SessionError);

  // Clipboard message validation
  assert.doesNotThrow(() => validateClipboardMessage('Hello, World!'));
  assert.throws(() => validateClipboardMessage(12345), SessionError);
  assert.throws(() => validateClipboardMessage({ text: 'not a string' }), SessionError);

  // Huge clipboard exceeding 256KB limit
  const hugeText = 'A'.repeat(300_000);
  assert.throws(() => validateClipboardMessage(hugeText), SessionError);
});
