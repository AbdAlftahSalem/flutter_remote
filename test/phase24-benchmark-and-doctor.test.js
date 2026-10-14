import test from 'node:test';
import assert from 'node:assert/strict';
import { doctor } from '../src/commands/doctor.js';
import { benchmark } from '../src/commands/benchmark.js';

test('Phase 24: doctor command runs all prerequisite checks without error', async () => {
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => {
    logs.push(args.join(' '));
  };

  try {
    await doctor(process.cwd());
  } finally {
    console.log = originalLog;
  }

  const output = logs.join('\n');
  assert.ok(output.includes('Flutter Remote Doctor'));
  assert.ok(output.includes('Git installed'));
  assert.ok(output.includes('Node.js >= 20'));
  assert.ok(output.includes('H.264 Encoder'));
  assert.ok(output.includes('WebRTC (node-datachannel)'));
  assert.ok(output.includes('Cloudflare tunnel'));
});

test('Phase 24: benchmark command measures pipeline throughput and latency', async () => {
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => {
    logs.push(args.join(' '));
  };

  try {
    await benchmark(process.cwd(), { frames: 5, live: false });
  } finally {
    console.log = originalLog;
  }

  const output = logs.join('\n');
  assert.ok(output.includes('Flutter Remote Benchmark'));
  assert.ok(output.includes('Encoder:'));
  assert.ok(output.includes('FPS:'));
  assert.ok(output.includes('Bitrate:'));
  assert.ok(output.includes('Input P50:'));
  assert.ok(output.includes('Input P95:'));
  assert.ok(output.includes('CPU:'));
  assert.ok(output.includes('Memory:'));
});
