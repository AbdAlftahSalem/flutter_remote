import test from 'node:test';
import assert from 'node:assert/strict';
import { InputProtocol } from '../src/input/InputProtocol.js';
import { CoordinateMapper } from '../src/input/CoordinateMapper.js';
import { InputCoalescer } from '../src/input/InputCoalescer.js';
import { LatencyTracker } from '../src/metrics/LatencyTracker.js';
import { InputRouter } from '../src/input/InputRouter.js';

test('Phase 6: InputProtocol normalized coordinate validation', () => {
  const pEvent = InputProtocol.createPointerEvent({
    event: 'down',
    pointerId: 1,
    x: 0.25,
    y: 0.75,
  });

  assert.equal(pEvent.v, 2);
  assert.equal(pEvent.type, 'pointer');
  assert.equal(pEvent.x, 0.25);
  assert.equal(pEvent.y, 0.75);
  assert.ok(pEvent.ts > 0, 't0 timestamp must be present');

  assert.throws(() => InputProtocol.createPointerEvent({ event: 'down', x: 1.5, y: 0.5 }));
});

test('Phase 6: CoordinateMapper with letterboxing and pillarboxing', () => {
  // Container: 1000x1000, Video: 720x1280 (tall phone screen) -> Pillarboxed with black bars on left and right
  const containerRect = { left: 100, top: 50, width: 1000, height: 1000 };
  const res = CoordinateMapper.mapClientToNormalized({
    clientX: 600, // Exactly center X in container (100 + 500 = 600)
    clientY: 550, // Exactly center Y in container (50 + 500 = 550)
    containerRect,
    videoWidth: 720,
    videoHeight: 1280,
  });

  assert.equal(res.x, 0.5);
  assert.equal(res.y, 0.5);
  assert.ok(res.inside);

  // Click on black bar on the left
  const leftBarClick = CoordinateMapper.mapClientToNormalized({
    clientX: 150,
    clientY: 550,
    containerRect,
    videoWidth: 720,
    videoHeight: 1280,
  });
  assert.ok(!leftBarClick.inside);
  assert.equal(leftBarClick.x, 0); // Clamped
});

test('Phase 6: InputCoalescer coalescing moves and preserving down/up', async () => {
  const sent = [];
  const coalescer = new InputCoalescer({
    onSend: (e) => sent.push(e),
  });

  // Down is sent immediately
  coalescer.handlePointer({ event: 'down', pointerId: 1, x: 0.1, y: 0.1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event, 'down');

  // Rapid moves for pointer 1 are coalesced
  coalescer.handlePointer({ event: 'move', pointerId: 1, x: 0.2, y: 0.2 });
  coalescer.handlePointer({ event: 'move', pointerId: 1, x: 0.3, y: 0.3 });
  coalescer.handlePointer({ event: 'move', pointerId: 1, x: 0.4, y: 0.4 });

  // Flush pending moves
  coalescer.flushMoves();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].event, 'move');
  assert.equal(sent[1].x, 0.4); // Latest move won
});

test('Phase 6: LatencyTracker per-stage timestamps and P50/P95/P99 calculation', () => {
  const tracker = new LatencyTracker({ maxSamples: 100 });

  // Simulate 100 events with known artificial latencies
  for (let seq = 1; seq <= 100; seq++) {
    const t0 = 10000;
    tracker._pendingBySeq.set(seq, { t0, t1: t0 + seq }); // transport latency = seq ms (1..100)
    tracker.recordSimulatorDispatch(seq); // server latency
    tracker.recordFrameResponse(seq); // e2e latency
  }

  const metrics = tracker.getMetrics();
  assert.equal(metrics.transport.count, 100);
  assert.equal(metrics.transport.p50, 50);
  assert.equal(metrics.transport.p95, 95);
  assert.equal(metrics.transport.p99, 99);
});

test('Phase 6: InputRouter end-to-end dispatch and timestamp recording', async () => {
  const dispatched = [];
  const mockAdapter = {
    async pointer(e) { dispatched.push(e); },
    async keyboard(e) { dispatched.push(e); },
    async scroll(e) { dispatched.push(e); },
    async clipboard(text) { dispatched.push({ type: 'clipboard', text }); },
  };

  const tracker = new LatencyTracker();
  const router = new InputRouter(mockAdapter, tracker);

  const event = InputProtocol.createPointerEvent({
    event: 'down',
    pointerId: 1,
    x: 0.5,
    y: 0.5,
    seq: 42,
    ts: Date.now() - 20, // 20ms ago
  });

  await router.handleInputMessage(event);

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].seq, 42);

  // Record frame response
  tracker.recordFrameResponse(42);

  const metrics = tracker.getMetrics();
  assert.equal(metrics.transport.count, 1);
  assert.ok(metrics.transport.p50 >= 20);
  assert.equal(metrics.e2e.count, 1);
});
