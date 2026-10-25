/**
 * Run the real `flutter-remote` binary as a child process, and build real
 * Flutter-shaped projects and git repositories in temp folders.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BIN = join(ROOT, 'bin', 'flutter-remote.js');

/** Run the CLI. Returns { code, stdout, stderr, output }. */
export function cli(args, { cwd, env = {}, input } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, output: `${r.stdout}${r.stderr}` };
}

export function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const temps = [];
export function tempDir(prefix = 'fr-e2e-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
export function cleanupTemps() {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** A minimal but real Flutter app layout (what `flutter create` makes, trimmed). */
export function flutterProject({ name = 'demo_app', bundleId = 'com.example.demoApp', gitInit = true } = {}) {
  const dir = tempDir();
  writeFileSync(join(dir, 'pubspec.yaml'), `name: ${name}\ndescription: e2e fixture\nversion: 1.0.0+1\n\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\n\ndependencies:\n  flutter:\n    sdk: flutter\n\nflutter:\n  uses-material-design: true\n`);
  mkdirSync(join(dir, 'lib'));
  writeFileSync(join(dir, 'lib', 'main.dart'), "import 'package:flutter/material.dart';\nvoid main() => runApp(const MaterialApp(home: Scaffold()));\n");
  mkdirSync(join(dir, 'ios', 'Runner.xcodeproj'), { recursive: true });
  writeFileSync(join(dir, 'ios', 'Runner.xcodeproj', 'project.pbxproj'), `PRODUCT_BUNDLE_IDENTIFIER = ${bundleId};\n`);
  if (gitInit) {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'e2e@example.com');
    git(dir, 'config', 'user.name', 'e2e');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'initial');
  }
  return dir;
}

/**
 * A PATH that holds only `node` and `git` (no `gh`), built from symlinks, so a
 * test can see what a user without GitHub CLI sees. Not available on Windows.
 */
export function pathWithoutGh() {
  const bin = tempDir('fr-path-');
  for (const tool of ['git', 'node']) {
    const which = spawnSync('which', [tool], { encoding: 'utf8' }).stdout.trim();
    if (which) symlinkSync(which, join(bin, tool));
  }
  const sys = ['/usr/bin', '/bin'].filter((p) => existsSync(p) && !existsSync(join(p, 'gh')));
  return [bin, ...sys].join(delimiter);
}
