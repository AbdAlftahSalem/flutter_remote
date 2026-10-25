#!/usr/bin/env node
/** `npm run check`: every JavaScript file in the package must parse. */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : /\.(c|m)?js$/.test(n) ? [p] : [];
});

let failed = 0;
for (const file of ['bin', 'src', 'test', 'scripts'].flatMap((d) => walk(join(root, d)))) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    console.error(`✗ ${relative(root, file)}\n${r.stderr}`);
  }
}
console.log(failed ? `${failed} file(s) failed to parse` : 'all files parse');
process.exit(failed ? 1 : 0);
