import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../src/config/index.js';
import { DEFAULT_CONFIG } from '../src/config/defaultConfig.js';
import { validatePayloadSize, validateSignalingMessage, validateInputEvent, validateToken, timingSafeCompare } from '../src/shared/validation.js';
import { Logger } from '../src/shared/logger.js';
import { calculateBackoff, generateToken, generateSessionId } from '../src/shared/utils.js';
import { SessionError, AuthenticationError, SignalingError } from '../src/shared/errors.js';

test('Phase 1: Configuration precedence and resolution', () => {
  // 1. Defaults
  const def = resolveConfig({}, {});
  assert.equal(def.transport, 'webrtc');
  assert.equal(def.codec, 'mjpeg');
  assert.equal(def.fps, 30);
  assert.equal(def.ports.gateway, 3199);

  // 2. Env override
  const withEnv = resolveConfig({}, { FLUTTER_REMOTE_FPS: '60', FLUTTER_REMOTE_GATE_PORT: '4000' });
  assert.equal(withEnv.fps, 60);
  assert.equal(withEnv.ports.gateway, 4000);

  // 3. CLI override takes precedence over Env
  const withCli = resolveConfig({ fps: 24, 'max-dimension': 1080 }, { FLUTTER_REMOTE_FPS: '60' });
  assert.equal(withCli.fps, 24);
  assert.equal(withCli.maxDimension, 1080);
});

test('Phase 1: Payload and message validation', () => {
  // Size limit validation
  assert.doesNotThrow(() => validatePayloadSize('short message', 100));
  assert.throws(
    () => validatePayloadSize(Buffer.alloc(200), 100),
    (err) => err instanceof SessionError && err.code === 'PAYLOAD_TOO_LARGE'
  );

  // Signaling message validation
  assert.doesNotThrow(() => validateSignalingMessage({ v: 2, type: 'offer', sdp: 'test' }));
  assert.throws(() => validateSignalingMessage({ v: 1, type: 'offer' }), SignalingError);
  assert.throws(() => validateSignalingMessage({}), SignalingError);

  // Input event coordinate normalization validation
  assert.doesNotThrow(() => validateInputEvent({ type: 'pointer', x: 0.5, y: 0.5 }));
  assert.throws(
    () => validateInputEvent({ type: 'pointer', x: 1.5, y: 0.5 }),
    (err) => err instanceof SessionError && err.message.includes('normalized between 0.0 and 1.0')
  );
  assert.throws(
    () => validateInputEvent({ type: 'pointer', x: -0.1, y: 0.5 }),
    (err) => err instanceof SessionError && err.message.includes('normalized between 0.0 and 1.0')
  );
});

test('Phase 1: Token validation and timing safety', () => {
  const token = generateToken(32);
  assert.ok(token.length >= 32);

  assert.ok(timingSafeCompare('secret-key-1234', 'secret-key-1234'));
  assert.ok(!timingSafeCompare('secret-key-1234', 'secret-key-wrong'));
  assert.ok(!timingSafeCompare('short', 'longer-string'));

  assert.doesNotThrow(() => validateToken('my-token', 'my-token'));
  assert.throws(() => validateToken('wrong-token', 'my-token'), AuthenticationError);
  assert.throws(() => validateToken('', 'my-token'), AuthenticationError);
});

test('Phase 1: Structured logger sensitive field redaction', () => {
  let loggedOutput = '';
  const testLogger = new Logger({
    name: 'test',
    json: true,
  });

  // Capture stdout write
  const origWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    loggedOutput += chunk;
    return true;
  };

  try {
    testLogger.info('session.started', {
      sessionId: 'sess-123',
      gate_token: 'SUPER_SECRET_TOKEN',
      password: 'TURN_PASSWORD_SECRET',
      normalField: 'visible',
    });
  } finally {
    process.stdout.write = origWrite;
  }

  const parsed = JSON.parse(loggedOutput.trim());
  assert.equal(parsed.sessionId, 'sess-123');
  assert.equal(parsed.gate_token, '[REDACTED]');
  assert.equal(parsed.password, '[REDACTED]');
  assert.equal(parsed.normalField, 'visible');
});

test('Phase 1: Backoff calculation with jitter', () => {
  const b0 = calculateBackoff(0);
  assert.ok(b0 >= 500 && b0 <= 550, `Attempt 0 backoff: ${b0}`);

  const b1 = calculateBackoff(1);
  assert.ok(b1 >= 1000 && b1 <= 1100, `Attempt 1 backoff: ${b1}`);

  const b5 = calculateBackoff(5);
  assert.ok(b5 <= 10000, `Max backoff bound: ${b5}`);
});
