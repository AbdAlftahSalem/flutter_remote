import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffold } from '../src/commands/init.js';
import { sh } from '../src/lib/proc.js';

describe('Workflow & Gate Templates', () => {
  let tempDir;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flutter-remote-scaffold-test-'));
  });

  after(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  test('templates/flutter-remote.yml contains required markers and steps', () => {
    const yml = readFileSync('templates/flutter-remote.yml', 'utf8');
    assert.ok(yml.includes('# flutter-remote-template-version: 12'));
    assert.ok(yml.includes('name: flutter-remote'));
    assert.ok(yml.includes('subosito/flutter-action@v2'));
    assert.ok(yml.includes('flutter build'));
    assert.ok(yml.includes('xcrun simctl boot'));
    assert.ok(yml.includes('xcrun simctl install'));
    assert.ok(yml.includes('xcrun simctl launch'));
    assert.ok(yml.includes('cloudflared'));
  });

  test('templates/gate.cjs is valid JavaScript syntax', () => {
    const res = sh('node', ['--check', 'templates/gate.cjs']);
    assert.equal(res.ok, true, `Syntax error in gate.cjs: ${res.err}`);
  });

  test('templates/webrtc-peer.cjs is valid JavaScript syntax', () => {
    const res = sh('node', ['--check', 'templates/webrtc-peer.cjs']);
    assert.equal(res.ok, true, `Syntax error in webrtc-peer.cjs: ${res.err}`);
  });

  test('scaffold writes templates into destination directory', () => {
    const projDir = join(tempDir, 'sample-proj');
    mkdirSync(projDir, { recursive: true });

    const changed = scaffold(projDir);
    assert.equal(changed, true);

    const workflowFile = join(projDir, '.github', 'workflows', 'flutter-remote.yml');
    const gateFile = join(projDir, '.github', 'flutter-remote', 'gate.cjs');
    const webrtcPeerFile = join(projDir, '.github', 'flutter-remote', 'webrtc-peer.cjs');
    const gitignoreFile = join(projDir, '.gitignore');

    assert.ok(existsSync(workflowFile), 'flutter-remote.yml should exist');
    assert.ok(existsSync(gateFile), 'gate.cjs should exist');
    assert.ok(existsSync(webrtcPeerFile), 'webrtc-peer.cjs should exist');
    assert.ok(existsSync(gitignoreFile), '.gitignore should exist');

    const content = readFileSync(workflowFile, 'utf8');
    assert.ok(content.includes('flutter-remote'));
  });
});
