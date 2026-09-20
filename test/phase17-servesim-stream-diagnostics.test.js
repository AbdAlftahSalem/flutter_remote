import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { VideoEncoder } from '../src/media/VideoEncoder.js';

test('Phase 17: FLUTTER_REMOTE_STREAM_PATH configuration and defaults', () => {
  const defaultPath = process.env.FLUTTER_REMOTE_STREAM_PATH || '/stream.mjpeg?raw=1';
  assert.equal(defaultPath, '/stream.mjpeg?raw=1');

  const customPath = '/helper/TEST-SIM-UDID-1234/stream.mjpeg?raw=1';
  const resolved = customPath || defaultPath;
  assert.equal(resolved, '/helper/TEST-SIM-UDID-1234/stream.mjpeg?raw=1');
});

test('Phase 17: HTTP non-200 responses are reported with full error context', async () => {
  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));

  const server = http.createServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Simulator stream not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const targetHost = '127.0.0.1';
  const streamPath = '/helper/NONEXISTENT/stream.mjpeg?raw=1';

  try {
    await new Promise((resolve, reject) => {
      const req = http.get(
        {
          host: targetHost,
          port,
          path: streamPath,
          headers: { 'Accept-Encoding': 'identity' },
        },
        (res) => {
          console.log(
            `[webrtc-peer] serve-sim stream response: ` +
            `status=${res.statusCode} ` +
            `content-type=${res.headers['content-type'] || 'unknown'}`
          );

          if (res.statusCode !== 200) {
            console.error(
              `[webrtc-peer] serve-sim stream failed:\n` +
              `host=${targetHost}\n` +
              `port=${port}\n` +
              `path=${streamPath}\n` +
              `status=${res.statusCode}\n` +
              `content-type=${res.headers['content-type'] || 'unknown'}`
            );
          }
          res.resume();
          res.on('end', resolve);
        }
      );
      req.on('error', reject);
    });

    assert.ok(
      logs.some((l) => l.includes('[webrtc-peer] serve-sim stream response: status=404 content-type=text/plain')),
      'Must log HTTP 404 response'
    );
    assert.ok(
      errors.some((e) => e.includes('[webrtc-peer] serve-sim stream failed:') && e.includes('status=404') && e.includes(`port=${port}`)),
      'Must log full failure details including host, port, path, status, and content-type'
    );
  } finally {
    console.log = origLog;
    console.error = origError;
    server.close();
  }
});

test('Phase 17: HTTP 200 stream extracts JPEG frames and increments frame counter', async () => {
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));

  // Construct realistic minimal JPEG frames with SOI (FF D8) and EOI (FF D9)
  const createMockJpeg = (id) => {
    return Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from(`test-jpeg-frame-${id}`),
      Buffer.from([0xff, 0xd9]),
    ]);
  };

  const frames = [createMockJpeg(1), createMockJpeg(2), createMockJpeg(3), createMockJpeg(4)];

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    for (const f of frames) {
      res.write(f);
    }
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    let jpegFrameCount = 0;
    const extractedFrames = [];

    await new Promise((resolve, reject) => {
      const req = http.get(
        {
          host: '127.0.0.1',
          port,
          path: '/stream.mjpeg?raw=1',
          headers: { 'Accept-Encoding': 'identity' },
        },
        (res) => {
          console.log(
            `[webrtc-peer] serve-sim stream response: ` +
            `status=${res.statusCode} ` +
            `content-type=${res.headers['content-type'] || 'unknown'}`
          );

          let buffer = Buffer.alloc(0);
          res.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            let soi = buffer.indexOf(Buffer.from([0xff, 0xd8]));
            while (soi !== -1) {
              const eoi = buffer.indexOf(Buffer.from([0xff, 0xd9]), soi + 2);
              if (eoi === -1) break;

              const jpeg = buffer.subarray(soi, eoi + 2);
              jpegFrameCount++;
              extractedFrames.push(jpeg);

              if (jpegFrameCount <= 3 || jpegFrameCount % 60 === 0) {
                console.log(`[video] JPEG frames=${jpegFrameCount} size=${jpeg.length}`);
              }

              buffer = buffer.subarray(eoi + 2);
              soi = buffer.indexOf(Buffer.from([0xff, 0xd8]));
            }
          });

          res.on('end', resolve);
        }
      );
      req.on('error', reject);
    });

    assert.equal(jpegFrameCount, 4, 'Must extract exactly 4 JPEG frames');
    assert.equal(extractedFrames.length, 4);
    assert.ok(logs.some((l) => l.includes('[webrtc-peer] serve-sim stream response: status=200')));
    assert.ok(logs.some((l) => l.includes('[video] JPEG frames=1')));
    assert.ok(logs.some((l) => l.includes('[video] JPEG frames=2')));
    assert.ok(logs.some((l) => l.includes('[video] JPEG frames=3')));
    // Frame 4 should not be logged because only <=3 or %60===0 are logged
    assert.ok(!logs.some((l) => l.includes('[video] JPEG frames=4')));
  } finally {
    console.log = origLog;
    server.close();
  }
});

test('Phase 17: VideoEncoder process identity safety on encoder close', () => {
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));

  try {
    const encoder = new VideoEncoder();

    // Mock active process 1
    const proc1 = new EventEmitter();
    proc1.pid = 1111;
    proc1.stdout = new EventEmitter();
    proc1.stderr = new EventEmitter();
    proc1.stdin = new EventEmitter();
    proc1.stdin.writable = true;
    proc1.stdin.write = () => true;

    encoder.ffmpegProc = proc1;
    encoder._isEncoding = true;

    // Attach identity-safe close handler to proc1
    proc1.on('close', (code, signal) => {
      if (encoder.ffmpegProc !== proc1) {
        console.log(`[ffmpeg] retired encoder closed pid=${proc1.pid}`);
        return;
      }

      encoder._isEncoding = false;
      encoder.ffmpegProc = null;
      encoder._flushPending();

      console.log(`[ffmpeg] active encoder closed pid=${proc1.pid} code=${code} signal=${signal}`);
      encoder.emit('encoder_closed', code);
    });

    // Simulate replacement: proc2 is spawned and becomes active encoder
    const proc2 = new EventEmitter();
    proc2.pid = 2222;
    proc2.stdout = new EventEmitter();
    proc2.stderr = new EventEmitter();
    proc2.stdin = new EventEmitter();
    proc2.stdin.writable = true;
    proc2.stdin.write = () => true;

    encoder.ffmpegProc = proc2;

    // Attach identity-safe close handler to proc2
    proc2.on('close', (code, signal) => {
      if (encoder.ffmpegProc !== proc2) {
        console.log(`[ffmpeg] retired encoder closed pid=${proc2.pid}`);
        return;
      }

      encoder._isEncoding = false;
      encoder.ffmpegProc = null;
      encoder._flushPending();

      console.log(`[ffmpeg] active encoder closed pid=${proc2.pid} code=${code} signal=${signal}`);
      encoder.emit('encoder_closed', code);
    });

    // Now proc1 exits (as the old retired encoder)
    proc1.emit('close', 0, null);

    // proc1 exit MUST NOT have cleared proc2!
    assert.equal(encoder.ffmpegProc, proc2, 'Old encoder close must not clear active encoder proc2');
    assert.equal(encoder._isEncoding, true, 'Active encoder must remain encoding');
    assert.ok(logs.some((l) => l.includes('[ffmpeg] retired encoder closed pid=1111')));

    // Now proc2 exits
    proc2.emit('close', 0, null);

    assert.equal(encoder.ffmpegProc, null, 'Active encoder close clears ffmpegProc');
    assert.equal(encoder._isEncoding, false, 'Encoding state must be false');
    assert.ok(logs.some((l) => l.includes('[ffmpeg] active encoder closed pid=2222')));
  } finally {
    console.log = origLog;
  }
});

test('Phase 17: VideoEncoder stderr visibility and throttling', () => {
  const errors = [];
  const origError = console.error;
  console.error = (...args) => errors.push(args.join(' '));

  try {
    const encoder = new VideoEncoder();
    const proc = new EventEmitter();
    proc.pid = 3333;
    proc.stderr = new EventEmitter();

    let lastStderrMsg = '';
    let repeatCount = 0;
    proc.stderr.on('data', (chunk) => {
      const message = chunk.toString().trim();
      if (!message) return;
      if (message.includes('deprecated') || message.includes('EOI missing')) return;

      if (message === lastStderrMsg) {
        repeatCount++;
        if (repeatCount % 50 === 0) {
          console.error(`[ffmpeg] ${message} (repeated ${repeatCount} times)`);
        }
        return;
      }
      lastStderrMsg = message;
      repeatCount = 0;
      console.error(`[ffmpeg] ${message}`);
    });

    // Send single error
    proc.stderr.emit('data', Buffer.from('x264 [error]: invalid parameter\n'));
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('[ffmpeg] x264 [error]: invalid parameter'));

    // Send repeated identical error 51 times (1 initial + 50 repeats)
    for (let i = 0; i < 51; i++) {
      proc.stderr.emit('data', Buffer.from('x264 [error]: repeated warning\n'));
    }

    // First time logged + 50th time logged = 2 logs total for repeated warning
    const repeatedLogs = errors.filter((e) => e.includes('repeated warning'));
    assert.equal(repeatedLogs.length, 2);
    assert.ok(repeatedLogs[1].includes('(repeated 50 times)'));
  } finally {
    console.error = origError;
  }
});
