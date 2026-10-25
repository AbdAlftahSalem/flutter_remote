/**
 * Scaffold end-to-end: `flutter-remote init` writes the runner bundle into a
 * real app repository, upgrades it safely, survives a Windows (CRLF) checkout,
 * and the files it wrote actually run.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cli, git, flutterProject, cleanupTemps, ROOT } from '../support/cli.mjs';
import { startProcess, stopAll, freePort, waitForHttp, request } from '../support/processes.mjs';

after(async () => { await stopAll(); cleanupTemps(); });

const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
const BUNDLE_SRC = join(ROOT, 'src', 'runner', 'flutter-remote');
const expectedFiles = () => [
  '.github/workflows/flutter-remote.yml',
  ...walk(BUNDLE_SRC).map((f) => `.github/flutter-remote/${relative(BUNDLE_SRC, f).split(sep).join('/')}`),
].sort();
const scaffolded = (dir) => walk(join(dir, '.github')).map((f) => relative(dir, f).split(sep).join('/')).sort();
const body = (text) => text.split('\n').slice(1).join('\n');

test('init writes the workflow and every runner file, each with a managed header', () => {
  const dir = flutterProject();
  const r = cli(['init'], { cwd: dir });
  assert.equal(r.code, 0, r.output);
  assert.deepEqual(scaffolded(dir), expectedFiles());
  for (const rel of expectedFiles()) {
    const text = readFileSync(join(dir, rel), 'utf8');
    assert.match(text.split('\n')[0], /^(\/\/|#) flutter-remote:managed sha256=[0-9a-f]{16} /, rel);
    const source = rel.startsWith('.github/workflows/')
      ? join(ROOT, 'src', 'runner', 'workflow', 'flutter-remote.yml')
      : join(BUNDLE_SRC, rel.slice('.github/flutter-remote/'.length));
    assert.equal(body(text), readFileSync(source, 'utf8'), `${rel} body must equal its source`);
  }
  assert.match(r.stdout, /Next: flutter-remote up/);
});

test('every scaffolded JavaScript file is valid (the gate and browser client included)', () => {
  const dir = flutterProject();
  cli(['init'], { cwd: dir });
  for (const rel of expectedFiles().filter((f) => /\.(c?js)$/.test(f))) {
    const check = spawnSync(process.execPath, ['--check', join(dir, rel)], { encoding: 'utf8' });
    assert.equal(check.status, 0, `${rel}: ${check.stderr}`);
  }
  const yml = readFileSync(join(dir, '.github/workflows/flutter-remote.yml'), 'utf8');
  assert.match(yml, /^on:\n {2}workflow_dispatch:/m);
});

test('running init again changes nothing', () => {
  const dir = flutterProject();
  cli(['init'], { cwd: dir });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'scaffold');
  const r = cli(['init'], { cwd: dir });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /already up to date/);
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('a file the user edited is kept (with a warning) until --force', () => {
  const dir = flutterProject();
  cli(['init'], { cwd: dir });
  const gate = join(dir, '.github/flutter-remote/gate.cjs');
  writeFileSync(gate, `${readFileSync(gate, 'utf8')}\n// my tweak\n`);

  const kept = cli(['init'], { cwd: dir });
  assert.match(kept.stdout, /\.github\/flutter-remote\/gate\.cjs was edited by you, so it was kept/);
  assert.match(readFileSync(gate, 'utf8'), /my tweak/);

  const forced = cli(['init', '--force'], { cwd: dir });
  assert.equal(forced.code, 0);
  assert.doesNotMatch(readFileSync(gate, 'utf8'), /my tweak/);
});

test('files from flutter-remote 0.1.x (template-version headers) are upgraded automatically', () => {
  const dir = flutterProject();
  cli(['init'], { cwd: dir });
  const gate = join(dir, '.github/flutter-remote/gate.cjs');
  // what 0.1.2 wrote: same header style the old releases used, older body
  writeFileSync(gate, '// flutter-remote-template-version: 12\nconsole.log("old gate");\n');
  const r = cli(['init'], { cwd: dir });
  assert.match(r.stdout, /updated 1 flutter-remote file/);
  assert.doesNotMatch(readFileSync(gate, 'utf8'), /old gate/);
});

test('an outdated but untouched file is upgraded without --force', () => {
  const dir = flutterProject();
  cli(['init'], { cwd: dir });
  const peer = join(dir, '.github/flutter-remote/peer/PeerSession.cjs');
  // simulate a previous flutter-remote version: different body, matching header hash
  const oldBody = 'module.exports = {};\n';
  const hash = createHash('sha256').update(oldBody).digest('hex').slice(0, 16);
  writeFileSync(peer, `// flutter-remote:managed sha256=${hash} — older\n${oldBody}`);
  const r = cli(['init'], { cwd: dir });
  assert.match(r.stdout, /updated 1 flutter-remote file/);
  assert.match(readFileSync(peer, 'utf8'), /class PeerSession/);
});

test('a Windows checkout (core.autocrlf=true, CRLF endings) is not mistaken for user edits', () => {
  const dir = flutterProject();
  cli(['init'], { cwd: dir });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'scaffold');
  git(dir, 'config', 'core.autocrlf', 'true');
  rmSync(join(dir, '.github'), { recursive: true });
  git(dir, 'checkout', '--', '.github');
  assert.match(readFileSync(join(dir, '.github/flutter-remote/gate.cjs'), 'utf8'), /\r\n/, 'checkout should have CRLF endings');
  const r = cli(['init'], { cwd: dir });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /already up to date/);
  assert.doesNotMatch(r.stdout, /edited by you/);
});

test('the scaffolded gate runs from the app repo and serves the browser client', async () => {
  const dir = flutterProject();
  cli(['init'], { cwd: dir });
  const port = await freePort();
  const gate = startProcess('gate', process.execPath, [join(dir, '.github/flutter-remote/gate.cjs')], {
    env: { FLUTTER_REMOTE_GATE_TOKEN: 'tok', FLUTTER_REMOTE_GATE_PORT: String(port), FLUTTER_REMOTE_TARGET_PORT: '9' },
  });
  await waitForHttp(`http://127.0.0.1:${port}/healthz`);
  const res = await request(`http://127.0.0.1:${port}/__flutter-remote/client.js`, { headers: { authorization: 'Bearer tok' } });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /javascript/);
  assert.match(res.body, /class FlutterRemoteClient/);
  await gate.stop();
});

test('files that older versions shipped and this one does not are removed (unless edited)', () => {
  const dir = flutterProject();
  cli(['init'], { cwd: dir });
  const oldOwned = join(dir, '.github/flutter-remote/peer/HardwareH264Encoder.cjs');
  const oldEdited = join(dir, '.github/flutter-remote/peer/SoftwareH264Encoder.cjs');
  writeFileSync(oldOwned, '// flutter-remote-template-version: 1\nmodule.exports = {};\n');
  writeFileSync(oldEdited, 'module.exports = { mine: true };\n');
  const r = cli(['init'], { cwd: dir });
  assert.match(r.stdout, /removed \.github\/flutter-remote\/peer\/HardwareH264Encoder\.cjs/);
  assert.equal(existsSync(oldOwned), false);
  assert.equal(existsSync(oldEdited), true, 'a file without our header is never deleted');
});
