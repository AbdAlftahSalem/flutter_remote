#!/usr/bin/env node
/**
 * Runs before `npm publish`: bin/ and src/ must match git exactly.
 *
 * npm packs every file under bin/ and src/ that is on disk, tracked or not.
 * 0.2.1 was published from a folder that still had the pre-0.2.0 modules
 * (src/cli.js, src/commands, src/lib, ...), so those dead files shipped too.
 */
import { spawnSync } from 'node:child_process';

const r = spawnSync('git', ['status', '--porcelain', '--ignored', '--', 'bin', 'src', 'package.json'], {
  encoding: 'utf8',
});
if (r.status !== 0) {
  console.error('check-clean: git is not available, skipping');
  process.exit(0);
}
const dirty = r.stdout.trim();
if (dirty) {
  console.error('✗ bin/ or src/ has files that are not committed (they would be published):');
  console.error(dirty);
  console.error('\nCommit or delete them (git clean -fdx bin src), or publish from a fresh clone.');
  process.exit(1);
}
console.log('bin/ and src/ match git');
