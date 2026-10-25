import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertFlutterProject } from '../../core/flutter-project.js';
import { GITIGNORE } from '../../core/git.js';
import { scaffold, changed } from '../../core/scaffold.js';
import { ok, info, warn, dim } from '../../core/ui.js';

export { WORKFLOW_PATH, GATE_PATH, WEBRTC_PEER_PATH } from '../../core/scaffold.js';

/** Print what a scaffold run did. Returns true when files changed. */
export function printScaffoldReport(report) {
  for (const f of report.written) ok(`wrote ${f}`);
  if (report.updated.length) ok(`updated ${report.updated.length} flutter-remote file(s) to this version`);
  for (const f of report.removed) ok(`removed ${f} ${dim('(no longer used)')}`);
  for (const f of report.kept) {
    warn(`${f} was edited by you, so it was kept ${dim('(flutter-remote init --force replaces it)')}`);
  }
  return changed(report);
}

export async function init(cwd, flags = {}) {
  assertFlutterProject(cwd);
  const report = scaffold(cwd, { force: Boolean(flags.force) });
  let didChange = printScaffoldReport(report);

  const gitignore = join(cwd, '.gitignore');
  if (!existsSync(gitignore)) {
    writeFileSync(gitignore, GITIGNORE);
    ok('wrote .gitignore');
    didChange = true;
  }

  if (!didChange) info('already up to date — nothing to do');
  console.log(`\nNext: ${dim('flutter-remote up')}`);
}
