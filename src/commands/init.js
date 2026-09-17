import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFlutterProject } from '../lib/flutter-project.js';
import { GITIGNORE } from '../lib/git.js';
import { ok, info, warn, dim } from '../lib/ui.js';

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates');

export const WORKFLOW_PATH = '.github/workflows/flutter-remote.yml';
export const GATE_PATH = '.github/flutter-remote/gate.cjs';

const VERSION_RE = /flutter-remote-template-version:\s*(\d+)/;
const versionOf = (text) => Number(text.match(VERSION_RE)?.[1] ?? 0);

/**
 * Writes the workflow + gate into the project. Returns true if anything changed.
 */
export function scaffold(cwd, { force = false } = {}) {
  let changed = false;

  for (const [rel, src] of [
    [WORKFLOW_PATH, 'flutter-remote.yml'],
    [GATE_PATH, 'gate.cjs'],
  ]) {
    const dest = join(cwd, rel);
    const templatePath = join(TEMPLATES, src);
    if (!existsSync(templatePath)) {
      throw new Error(`Bundled template missing: ${templatePath}`);
    }
    const template = readFileSync(templatePath, 'utf8');

    if (existsSync(dest) && !force) {
      const existing = readFileSync(dest, 'utf8');
      if (existing === template) continue;

      const [have, want] = [versionOf(existing), versionOf(template)];
      if (have >= want) {
        warn(`${rel} differs from the bundled template ${dim('(flutter-remote init --force to overwrite)')}`);
        continue;
      }
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, template);
      ok(`updated ${rel} ${dim(`(template v${have} → v${want})`)}`);
      changed = true;
      continue;
    }

    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, template);
    ok(`wrote ${rel}`);
    changed = true;
  }

  const gitignore = join(cwd, '.gitignore');
  if (!existsSync(gitignore)) {
    writeFileSync(gitignore, GITIGNORE);
    ok('wrote .gitignore');
    changed = true;
  }

  return changed;
}

export async function init(cwd, flags = {}) {
  assertFlutterProject(cwd);
  const changed = scaffold(cwd, { force: flags.force });
  if (!changed) {
    info('already initialized — nothing to do');
  }
  console.log(`\nNext: ${dim('flutter-remote up')}`);
}
