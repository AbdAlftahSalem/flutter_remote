import * as gh from '../lib/gh.js';
import { loadSession, clearSession } from '../lib/session.js';
import { info, ok, warn, dim } from '../lib/ui.js';

const WORKFLOW = 'flutter-remote.yml';

export async function down(cwd, flags = {}) {
  gh.requireAuth();

  if (flags.all) {
    const runs = gh.inFlightRuns(cwd, WORKFLOW);
    if (runs.length === 0) {
      info('No flutter-remote runs in flight');
      clearSession(cwd);
      return;
    }
    for (const run of runs) {
      if (gh.cancelRun(cwd, run.databaseId)) {
        ok(`Cancelled run ${run.databaseId} ${dim(run.displayTitle ?? '')}`);
      } else {
        warn(`Could not cancel run ${run.databaseId} — ${run.url}`);
      }
    }
    clearSession(cwd);
    return;
  }

  const session = loadSession(cwd);
  if (!session) {
    info(`No active flutter-remote session recorded ${dim('(try: flutter-remote down --all)')}`);
    return;
  }

  const run = gh.getRun(cwd, session.runId);
  if (run?.status === 'completed') {
    info(`Run already completed (${run.conclusion})`);
  } else if (gh.cancelRun(cwd, session.runId)) {
    ok(`Cancelled run ${session.runId} — remote macOS runner and simulator shutting down`);
  } else {
    warn(`Could not cancel run ${session.runId}; cancel it manually at ${session.url}`);
  }

  const others = gh.inFlightRuns(cwd, WORKFLOW).filter((r) => r.databaseId !== session.runId);
  if (others.length) {
    warn(`${others.length} other flutter-remote run(s) still in flight — ${dim('flutter-remote down --all')}`);
  }

  clearSession(cwd);
}
