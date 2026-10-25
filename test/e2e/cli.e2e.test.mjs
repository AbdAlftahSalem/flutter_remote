/**
 * CLI end-to-end: the real `flutter-remote` binary, run as a process, in real
 * folders and git repositories. Runs on Linux, macOS and Windows; no GitHub
 * access needed.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cli, git, tempDir, flutterProject, pathWithoutGh, cleanupTemps, ROOT } from '../support/cli.mjs';

after(cleanupTemps);
const unix = process.platform !== 'win32';

test('--version prints the package version', () => {
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  for (const flag of ['--version', '-v']) {
    const r = cli([flag]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), version);
  }
});

test('--help lists every command', () => {
  const r = cli(['-h']);
  assert.equal(r.code, 0);
  for (const cmd of ['up', 'init', 'status', 'down', 'doctor', 'benchmark', 'upload', 'r2', 'turn']) {
    assert.match(r.stdout, new RegExp(`^\\s+${cmd}\\s`, 'm'), `help should list ${cmd}`);
  }
});

test('a mistyped command suggests the right one and exits 2', () => {
  const r = cli(['stauts']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Unknown command "stauts"/);
  assert.match(r.stderr, /Fix:\s+did you mean: flutter-remote status/);
});

test('a bad flag value is rejected with a fix, before anything is touched', () => {
  const dir = tempDir();
  const r = cli(['up', '--minutes', '999'], { cwd: dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--minutes must be a whole number from 1 to 350/);
  assert.match(r.stderr, /Fix:\s+flutter-remote up --minutes 30/);
  assert.equal(existsSync(join(dir, '.git')), false, 'no git repo may be created');
});

test('a flag that needs a value says so', () => {
  const r = cli(['up', '--device']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--device needs a value/);
});

test('up stops at preflight with every problem listed and creates nothing', { skip: !unix && 'PATH isolation uses symlinks' }, () => {
  const dir = tempDir();
  const r = cli(['up', '--no-open'], { cwd: dir, env: { PATH: pathWithoutGh() } });
  assert.equal(r.code, 3);
  assert.match(r.stdout, /✗ GitHub CLI installed/);
  assert.match(r.stdout, /✗ Flutter project/);
  assert.match(r.stderr, /prerequisite\(s\) missing/);
  assert.match(r.stderr, /Fix:/);
  assert.equal(existsSync(join(dir, '.git')), false);
  assert.equal(existsSync(join(dir, '.github')), false);
});

test('doctor reads a real Flutter project and repo, with a fix for each problem', { skip: !unix && 'PATH isolation uses symlinks' }, () => {
  const dir = flutterProject({ name: 'shop_app', bundleId: 'com.acme.shop' });
  writeFileSync(join(dir, 'lib', 'extra.dart'), '// uncommitted\n');
  const r = cli(['doctor'], { cwd: dir, env: { PATH: pathWithoutGh() } });
  assert.equal(r.code, 3, 'gh missing must block');
  assert.match(r.stdout, /✓ Node\.js 20\+/);
  assert.match(r.stdout, /✓ Git installed/);
  assert.match(r.stdout, /✗ GitHub CLI installed/);
  assert.match(r.stdout, /→ (winget install GitHub\.cli|brew install gh|install GitHub CLI)/);
  assert.match(r.stdout, /✓ Flutter project\s+shop_app v1\.0\.0\+1 · com\.acme\.shop/);
  assert.match(r.stdout, /✓ On a branch\s+main/);
  assert.match(r.stdout, /! Working tree\s+1 uncommitted change/);
  assert.match(r.stdout, /! flutter-remote files\s+not added yet/);
});

test('doctor flags a detached HEAD, which up could not push', { skip: !unix && 'PATH isolation uses symlinks' }, () => {
  const dir = flutterProject();
  git(dir, 'checkout', '-q', '--detach');
  const r = cli(['doctor'], { cwd: dir, env: { PATH: pathWithoutGh() } });
  assert.match(r.stdout, /✗ On a branch\s+HEAD is detached/);
  assert.match(r.stdout, /→ git switch main/);
});

test('doctor and init name the missing ios/ folder and how to add it', () => {
  const dir = flutterProject({ gitInit: false });
  rmSync(join(dir, 'ios'), { recursive: true }); // a Flutter app created without iOS support
  const r = cli(['init'], { cwd: dir });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /not a Flutter project \(missing: ios\/\)/);
  assert.match(r.stderr, /Fix:\s+add iOS support: flutter create --platforms=ios \./);
});

test('status without a session explains how to start one', () => {
  const dir = flutterProject();
  const r = cli(['status'], { cwd: dir });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /No session for this project yet \(start one: flutter-remote up\)/);
});

test('upload refuses a device .ipa and says how to make a simulator build', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'Runner.ipa'), 'not really');
  const r = cli(['upload', 'Runner.ipa'], { cwd: dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /device build/);
  assert.match(r.stderr, /flutter build ios --simulator --no-codesign/);
});

test('upload refuses an iPhoneOS .app', () => {
  const dir = tempDir();
  mkdirSync(join(dir, 'Runner.app'));
  writeFileSync(join(dir, 'Runner.app', 'Info.plist'), '<key>CFBundleSupportedPlatforms</key><array><string>iPhoneOS</string></array>');
  const r = cli(['upload', 'Runner.app'], { cwd: dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /built for real iPhones/);
});

test('--r2 no longer pretends to upload', () => {
  const dir = tempDir();
  mkdirSync(join(dir, 'Runner.app'));
  const r = cli(['upload', 'Runner.app', '--r2'], { cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /R2 is not supported yet/);
  assert.doesNotMatch(r.output, /Uploaded/);
});

test('r2 with missing credentials names every missing flag', () => {
  const r = cli(['r2', '--bucket', 'b'], { env: { HOME: tempDir(), USERPROFILE: tempDir() } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /missing --account-id, --access-key-id, --secret-access-key/);
});

test('turn without keys explains the two flags', () => {
  const r = cli(['turn']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--key-id and --key-token are both needed/);
});

test('benchmark --local runs the runner\'s real H.264 encoder on real frames', () => {
  const dir = flutterProject();
  const r = cli(['benchmark', '--local', '--frames', '30'], { cwd: dir });
  assert.equal(r.code, 0, r.output);
  assert.match(r.stdout, /Encoder\s+libx264|Encoder\s+h264_videotoolbox/);
  const kbps = Number(r.stdout.match(/Bitrate\s+(\d+) kbps/)?.[1]);
  const fps = Number(r.stdout.match(/Throughput\s+([\d.]+) fps/)?.[1]);
  assert.ok(kbps > 0, `bitrate ${kbps}`);
  assert.ok(fps > 5, `throughput ${fps}`);
});
