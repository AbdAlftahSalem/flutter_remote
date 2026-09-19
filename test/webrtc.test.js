import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { sh } from '../src/lib/proc.js';

describe('WebRTC DataChannel Integration', () => {
  let gateProc;
  const GATE_PORT = 3399;
  const GATE_TOKEN = 'test-token-webrtc-12345';

  before(async () => {
    gateProc = spawn('node', ['templates/gate.cjs'], {
      env: {
        ...process.env,
        FLUTTER_REMOTE_GATE_TOKEN: GATE_TOKEN,
        FLUTTER_REMOTE_GATE_PORT: String(GATE_PORT),
        FLUTTER_REMOTE_TARGET_PORT: '3200',
        FLUTTER_REMOTE_WEBRTC_SIGNAL_PORT: '3201',
      },
      stdio: 'pipe',
    });

    // Wait for gate to start listening
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${GATE_PORT}/__flutter-remote/healthz`);
        if (res.ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  after(() => {
    if (gateProc) {
      gateProc.kill();
    }
  });

  test('templates/webrtc-peer.cjs syntax check', () => {
    const res = sh('node', ['--check', 'templates/webrtc-peer.cjs']);
    assert.equal(res.ok, true, `Syntax error in webrtc-peer.cjs: ${res.err}`);
  });

  test('gate.cjs serves /ice-config with STUN fallback when TURN is unconfigured', async () => {
    const res = await fetch(`http://127.0.0.1:${GATE_PORT}/ice-config?k=${GATE_TOKEN}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');

    const data = await res.json();
    assert.ok(Array.isArray(data.iceServers));
    assert.ok(data.iceServers.length > 0);
    assert.ok(data.iceServers.some((s) => JSON.stringify(s).includes('stun:stun.cloudflare.com:3478')));
  });

  test('gate.cjs serves /__flutter-remote/webrtc-hid.js client script', async () => {
    const res = await fetch(`http://127.0.0.1:${GATE_PORT}/__flutter-remote/webrtc-hid.js?k=${GATE_TOKEN}`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type').includes('javascript'));

    const text = await res.text();
    assert.ok(text.includes('RTCPeerConnection'));
    assert.ok(text.includes('createDataChannel'));
    assert.ok(text.includes('window.WebSocket = function'));
    assert.ok(text.includes('/ice-config'));
  });

  test('gate.cjs /ice-config rejects unauthenticated requests', async () => {
    const res = await fetch(`http://127.0.0.1:${GATE_PORT}/ice-config`);
    assert.equal(res.status, 403);
  });
});
