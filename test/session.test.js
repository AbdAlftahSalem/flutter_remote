import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveSession, loadSession, clearSession } from '../src/lib/session.js';

describe('Session Persistence', () => {
  let tempDir;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flutter-remote-session-test-'));
    mkdirSync(join(tempDir, '.git'), { recursive: true });
  });

  after(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  test('saves, loads, and clears session data', () => {
    assert.equal(loadSession(tempDir), null);

    saveSession(tempDir, {
      session: 'test-session-123',
      repo: 'user/app',
      runId: 999888,
    });

    const loaded = loadSession(tempDir);
    assert.ok(loaded);
    assert.equal(loaded.session, 'test-session-123');
    assert.equal(loaded.repo, 'user/app');
    assert.equal(loaded.runId, 999888);
    assert.ok(typeof loaded.startedAt === 'number');

    clearSession(tempDir);
    assert.equal(loadSession(tempDir), null);
  });
});
