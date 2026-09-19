import test from 'node:test';
import assert from 'node:assert/strict';
import { DataChannelManager } from '../src/webrtc/DataChannelManager.js';
import { FrameController } from '../src/media/FrameController.js';
import { LatencyTracker } from '../src/metrics/LatencyTracker.js';
import { CHANNELS } from '../src/shared/constants.js';

test('Phase 16: Stress test 1000 pointer moves/sec with bounded queue and stable memory', async () => {
  const initialMemory = process.memoryUsage().heapUsed;
  let mockBufferedAmount = 0;
  let sentEvents = 0;

  const mockInputDc = {
    bufferedAmount: () => mockBufferedAmount,
    sendMessage: () => { sentEvents++; },
  };

  const mockPeer = { sessionId: 'stress-sess' };
  const dcManager = new DataChannelManager(mockPeer, { bufferedAmountThreshold: 500 });
  dcManager.attachChannel(CHANNELS.INPUT, mockInputDc);

  const frameController = new FrameController({ maxQueueSize: 2 });
  const latencyTracker = new LatencyTracker({ maxSamples: 1000 });

  const TOTAL_EVENTS = 20000;

  for (let i = 1; i <= TOTAL_EVENTS; i++) {
    // Alternate congestion every 500 events
    mockBufferedAmount = (i % 1000 < 500) ? 0 : 5000;

    const event = {
      v: 2,
      type: 'pointer',
      seq: i,
      ts: Date.now() - (i % 50),
      event: 'move',
      x: (i % 1000) / 1000,
      y: (i % 1000) / 1000,
    };

    dcManager.sendInput(event);
    latencyTracker.recordServerReceive(i, event.ts);
    latencyTracker.recordSimulatorDispatch(i);

    if (i % 10 === 0) {
      frameController.pushFrame(Buffer.from(`frame-${i}`));
      frameController.popFrame();
      latencyTracker.recordFrameResponse(i);
    }
  }

  const finalMemory = process.memoryUsage().heapUsed;
  const memoryGrowthMb = (finalMemory - initialMemory) / 1048576;

  // Verify bounded queues and backpressure drops
  assert.ok(dcManager.droppedInputEvents > 0, 'Backpressure must drop moves during congestion');
  assert.equal(dcManager.totalInputEvents, TOTAL_EVENTS);
  assert.ok(frameController.queueLength <= 2, 'Frame queue must remain bounded <= 2');

  // Verify memory growth is strictly bounded (< 30 MB for 20,000 events)
  assert.ok(memoryGrowthMb < 30, `Memory growth must be < 30MB, got ${memoryGrowthMb.toFixed(2)}MB`);

  // Verify latency metrics calculated properly under load
  const metrics = latencyTracker.getMetrics();
  assert.ok(metrics.transport.count > 0);
  assert.ok(metrics.transport.p50 >= 0);
  assert.ok(metrics.transport.p95 >= metrics.transport.p50);
});
