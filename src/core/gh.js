import { sh, shx } from './proc.js';
import { checkGitHub } from './preflight.js';
import { FlutterRemoteError, prerequisiteError } from './errors.js';

/** Throws a prerequisite error (with the fix) unless gh is installed and logged in. */
export function requireAuth() {
  const problem = checkGitHub().find((c) => c.status === 'fail');
  if (problem) throw prerequisiteError(`${problem.label}: ${problem.detail}`, problem.fix);
}

/**
 * `gh api <path>` returning parsed JSON. Returns null on failure.
 */
export function api(path, extra = []) {
  const r = sh('gh', ['api', path, ...extra]);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
}

/** gh logged in and this folder has a GitHub repository; returns owner/repo. */
export function requireRepo(cwd) {
  requireAuth();
  const repo = nameWithOwner(cwd);
  if (!repo) throw prerequisiteError('this folder has no GitHub repository yet', 'run flutter-remote up once (it creates one), or: gh repo create');
  return repo;
}

/**
 * owner/repo for the repository in cwd, or null if no remote.
 */
export function nameWithOwner(cwd) {
  const r = sh('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd });
  return r.ok ? r.out : null;
}

export function createRepo(cwd, name, { isPublic, branch }) {
  const args = [
    'repo', 'create', name,
    isPublic ? '--public' : '--private',
    '--source=.', '--remote=origin', '--push',
  ];
  shx('gh', args, { cwd });
  sh('git', ['branch', '--set-upstream-to', `origin/${branch}`, branch], { cwd });
  return nameWithOwner(cwd);
}

export function isPublicRepo(cwd) {
  const r = sh('gh', ['repo', 'view', '--json', 'visibility', '-q', '.visibility'], { cwd });
  return r.ok && r.out.toUpperCase() === 'PUBLIC';
}

/**
 * GitHub indexes a newly pushed workflow asynchronously, so the very first
 * dispatch after creating a repo or adding a workflow may return 404 for a few seconds.
 */
export async function dispatch(cwd, workflow, ref, inputs, { attempts = 12 } = {}) {
  const args = ['workflow', 'run', workflow, '--ref', ref];
  for (const [k, v] of Object.entries(inputs)) {
    if (v !== undefined && v !== null) {
      args.push('-f', `${k}=${v}`);
    }
  }

  let last = '';
  for (let i = 0; i < attempts; i++) {
    const r = sh('gh', args, { cwd });
    if (r.ok) return;
    last = r.err || r.out;
    if (!/could not find|not found|404|does not exist/i.test(last)) break;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new FlutterRemoteError(`GitHub refused to start ${workflow} on ${ref}: ${last.split('\n')[0]}`, {
    hint: /minutes|billing|spending/i.test(last)
      ? 'your GitHub Actions minutes are used up: wait for the monthly reset, or make the repo public (--public)'
      : `check https://github.com/${nameWithOwner(cwd) ?? 'OWNER/REPO'}/actions and that the workflow file is on the ${ref} branch`,
  });
}

/**
 * Poll until GitHub Actions has registered the workflow file in the repository.
 */
export async function waitForWorkflowRegistration(cwd, repo, path, { timeoutMs = 180000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = api(`repos/${repo}/actions/workflows`);
    if (list?.workflows?.some((w) => w.path === path || w.path.endsWith(path))) return true;
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  return false;
}

/**
 * Find the workflow run whose display title or inputs correlate with our session ID.
 */
export function findRun(cwd, workflow, session) {
  const r = sh('gh', [
    'run', 'list', '--workflow', workflow, '--limit', '25',
    '--json', 'databaseId,displayTitle,status,conclusion,url,createdAt',
  ], { cwd });
  if (!r.ok) return null;
  let runs;
  try {
    runs = JSON.parse(r.out);
  } catch {
    return null;
  }
  return runs.find((run) => run.displayTitle?.includes(session)) ?? null;
}

export function getRun(cwd, id) {
  const r = sh('gh', [
    'run', 'view', String(id),
    '--json', 'databaseId,status,conclusion,url,displayTitle,jobs',
  ], { cwd });
  if (!r.ok) return null;
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
}

/**
 * Read the commit status for context (e.g. flutter-remote/<session>).
 */
export function readStatus(cwd, repo, sha, context) {
  const data = api(`repos/${repo}/commits/${sha}/statuses`);
  if (!Array.isArray(data)) return null;
  return data.find((s) => s.context === context) ?? null;
}

export function cancelRun(cwd, id) {
  return sh('gh', ['run', 'cancel', String(id)], { cwd }).ok;
}

export function inFlightRuns(cwd, workflow) {
  const r = sh('gh', [
    'run', 'list', '--workflow', workflow, '--limit', '30',
    '--json', 'databaseId,displayTitle,status,conclusion,url',
  ], { cwd });
  if (!r.ok) return [];
  try {
    const list = JSON.parse(r.out);
    return list.filter((run) => run.status === 'queued' || run.status === 'in_progress');
  } catch {
    return [];
  }
}
