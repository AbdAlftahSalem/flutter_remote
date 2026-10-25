/**
 * Preflight checks shared by `flutter-remote doctor` (prints all of them) and
 * `flutter-remote up` (stops before touching git or GitHub if any check fails).
 *
 * Each check returns { id, label, status: 'pass'|'warn'|'fail', detail?, fix? }.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sh, has } from './proc.js';
import { assertFlutterProject, getFlutterAppName, getFlutterBundleId } from './flutter-project.js';
import { manifest, render, classify } from './scaffold.js';

const MIN_NODE_MAJOR = 20;

const pass = (id, label, detail) => ({ id, label, status: 'pass', detail });
const warn = (id, label, detail, fix) => ({ id, label, status: 'warn', detail, fix });
const fail = (id, label, detail, fix) => ({ id, label, status: 'fail', detail, fix });

const GH_INSTALL_FIX = process.platform === 'win32'
  ? 'winget install GitHub.cli   (then open a new terminal)'
  : process.platform === 'darwin'
    ? 'brew install gh'
    : 'install GitHub CLI: https://github.com/cli/cli#installation';

export function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  return major >= MIN_NODE_MAJOR
    ? pass('node', `Node.js ${MIN_NODE_MAJOR}+`, `v${process.versions.node}`)
    : fail('node', `Node.js ${MIN_NODE_MAJOR}+`, `found v${process.versions.node}`, 'install Node.js 20 LTS or newer from https://nodejs.org');
}

export function checkGit() {
  return has('git')
    ? pass('git', 'Git installed', sh('git', ['--version']).out.replace('git version ', 'v'))
    : fail('git', 'Git installed', 'git was not found on PATH', 'install Git: https://git-scm.com/downloads');
}

/** gh installed, logged in, and allowed to push workflow files. */
export function checkGitHub() {
  if (!has('gh')) return [fail('gh', 'GitHub CLI installed', 'gh was not found on PATH', GH_INSTALL_FIX)];
  const out = [pass('gh', 'GitHub CLI installed', sh('gh', ['--version']).out.split('\n')[0].replace(/^gh version /, 'v'))];

  const status = sh('gh', ['auth', 'status'], { timeout: 15000 });
  const text = `${status.out}\n${status.err}`;
  if (!status.ok) {
    out.push(fail('gh-auth', 'GitHub login', 'gh is not logged in', 'gh auth login'));
    return out;
  }
  const account = /account\s+(\S+)/i.exec(text)?.[1] ?? /as\s+(\S+)/i.exec(text)?.[1];
  out.push(pass('gh-auth', 'GitHub login', account ? `@${account}` : 'logged in'));

  const scopes = /Token scopes:\s*(.*)/i.exec(text)?.[1];
  if (scopes !== undefined && !/workflow/.test(scopes)) {
    out.push(fail('gh-scope', 'Permission to push workflows', 'your gh token lacks the "workflow" scope, so GitHub will reject the .github/workflows file',
      'gh auth refresh -s workflow'));
  } else {
    out.push(pass('gh-scope', 'Permission to push workflows', scopes === undefined ? 'not reported by gh (assumed)' : 'workflow scope present'));
  }
  return out;
}

export function checkFlutterProject(cwd) {
  try {
    const config = assertFlutterProject(cwd);
    const bundleId = getFlutterBundleId(cwd);
    return pass('flutter-project', 'Flutter project', `${getFlutterAppName(cwd)}${config.version ? ` v${config.version}` : ''}${bundleId ? ` · ${bundleId}` : ''}`);
  } catch (err) {
    return fail('flutter-project', 'Flutter project', err.message.split('\n')[0], err.hint ?? 'run flutter-remote from the folder that holds pubspec.yaml, lib/ and ios/');
  }
}

/** Repo state: is it a git repo, on a branch, with or without local changes. */
export function checkRepository(cwd) {
  if (!has('git')) return [];
  const top = sh('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (!top.ok) return [warn('git-repo', 'Git repository', 'not a git repository yet', 'nothing to do: flutter-remote up runs git init for you')];
  const out = [pass('git-repo', 'Git repository', top.out)];

  const branch = sh('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd });
  out.push(branch.ok
    ? pass('git-branch', 'On a branch', branch.out)
    : fail('git-branch', 'On a branch', 'HEAD is detached, so there is no branch to push', 'git switch main   (or: git switch -c my-branch)'));

  const dirty = sh('git', ['status', '--porcelain'], { cwd });
  const count = dirty.out ? dirty.out.split('\n').length : 0;
  out.push(count
    ? warn('git-clean', 'Working tree', `${count} uncommitted change(s): flutter-remote up commits them before pushing`, 'git status   (commit or stash first if you do not want that)')
    : pass('git-clean', 'Working tree', 'clean'));
  return out;
}

export function checkRemote(cwd) {
  if (!has('gh') || !sh('git', ['rev-parse', '--git-dir'], { cwd }).ok) return [];
  const repo = sh('gh', ['repo', 'view', '--json', 'nameWithOwner,visibility', '-q', '.nameWithOwner + " " + .visibility'], { cwd, timeout: 15000 });
  if (!repo.ok || !repo.out) {
    return [warn('gh-remote', 'GitHub repository', 'none yet', 'nothing to do: flutter-remote up creates one (add --public for free macOS minutes)')];
  }
  const [name, visibility] = repo.out.split(' ');
  return [visibility === 'PUBLIC'
    ? pass('gh-remote', 'GitHub repository', `${name} (public: free macOS minutes)`)
    : warn('gh-remote', 'GitHub repository', `${name} is private: macOS runner minutes count 10× against your quota`, 'make the repo public, or use a separate public repo with --public')];
}

/** Are the flutter-remote files in this repo current, outdated, or edited? */
export function checkScaffold(cwd) {
  const states = manifest().map(({ dest, source }) => {
    const path = join(cwd, dest);
    return { dest, state: classify(existsSync(path) ? readFileSync(path, 'utf8') : undefined, render(source)) };
  });
  const by = (s) => states.filter((x) => x.state === s);
  if (by('missing').length === states.length) {
    return warn('scaffold', 'flutter-remote files', 'not added yet', 'nothing to do: flutter-remote up adds them (or run flutter-remote init)');
  }
  const edited = [...by('modified'), ...by('foreign')];
  if (edited.length) {
    return warn('scaffold', 'flutter-remote files', `${edited.length} file(s) edited by you are kept as they are: ${edited.map((e) => e.dest).join(', ')}`, 'flutter-remote init --force   (replaces them with this version)');
  }
  const stale = [...by('missing'), ...by('outdated'), ...by('legacy')];
  return stale.length
    ? warn('scaffold', 'flutter-remote files', `${stale.length} file(s) from an older version`, 'nothing to do: flutter-remote up updates them (or run flutter-remote init)')
    : pass('scaffold', 'flutter-remote files', 'up to date');
}

/** TURN relay credentials live in the repository's Actions secrets. */
export function checkTurn(cwd) {
  if (!has('gh')) return [];
  const secrets = sh('gh', ['secret', 'list'], { cwd, timeout: 15000 });
  if (!secrets.ok) return [];
  return [/FLUTTER_REMOTE_TURN_KEY_ID/.test(secrets.out)
    ? pass('turn', 'TURN relay (optional)', 'configured in repository secrets')
    : warn('turn', 'TURN relay (optional)', 'not configured: fine on most networks; helps behind strict firewalls', 'flutter-remote turn --key-id <id> --key-token <token>')];
}

/** Everything `doctor` reports, in display order, grouped. */
export function runAllChecks(cwd) {
  return [
    { group: 'This computer', checks: [checkNode(), checkGit(), ...checkGitHub()] },
    { group: 'This project', checks: [checkFlutterProject(cwd), ...checkRepository(cwd), ...checkRemote(cwd), checkScaffold(cwd), ...checkTurn(cwd)] },
  ];
}

/** The checks `up` needs to pass before it touches git or GitHub. */
export function runUpChecks(cwd, { needsFlutterProject = true } = {}) {
  const checks = [checkNode(), checkGit(), ...checkGitHub()];
  if (needsFlutterProject) checks.push(checkFlutterProject(cwd));
  checks.push(...checkRepository(cwd).filter((c) => c.id === 'git-branch'));
  return checks;
}
