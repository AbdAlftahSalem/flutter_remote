import { realpathSync } from 'node:fs';
import { sh, shx } from './proc.js';
import { FlutterRemoteError } from './errors.js';

/**
 * True only when cwd is itself the top-level repository root.
 */
export function isRepo(cwd) {
  const r = sh('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (!r.ok) return false;
  try {
    return realpathSync(r.out) === realpathSync(cwd);
  } catch {
    return false;
  }
}

export function init(cwd) {
  shx('git', ['init', '-b', 'main'], { cwd });
}

export function currentBranch(cwd) {
  const r = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  return r.ok && r.out !== 'HEAD' ? r.out : 'main';
}

export function headSha(cwd) {
  return shx('git', ['rev-parse', 'HEAD'], { cwd });
}

export function isDirty(cwd) {
  return sh('git', ['status', '--porcelain'], { cwd }).out.length > 0;
}

export function hasCommits(cwd) {
  return sh('git', ['rev-parse', '--verify', 'HEAD'], { cwd }).ok;
}

export function commitAll(cwd, message) {
  shx('git', ['add', '-A'], { cwd });
  const r = sh('git', ['commit', '-m', message], { cwd });
  if (!r.ok && !/nothing to commit/i.test(r.out + r.err)) {
    const noIdentity = /tell me who you are|user\.email/i.test(r.err + r.out);
    throw new FlutterRemoteError(`git commit failed: ${(r.err || r.out).split('\n')[0]}`, {
      hint: noIdentity
        ? 'git config --global user.name "Your Name" && git config --global user.email you@example.com'
        : 'run git status to see what is wrong, fix it, then run flutter-remote up again',
    });
  }
}

/** Paths with uncommitted changes (staged, unstaged or untracked). */
export function changedFiles(cwd) {
  const out = sh('git', ['status', '--porcelain'], { cwd }).out;
  return out ? out.split('\n').map((line) => line.slice(3)) : [];
}

export function push(cwd, branch) {
  const r = sh('git', ['push', '-u', 'origin', branch], { cwd });
  if (r.ok) return;
  const text = r.err || r.out;
  const workflowScope = /workflow/i.test(text) && /scope|permission|refusing/i.test(text);
  throw new FlutterRemoteError(`git push to origin/${branch} failed: ${text.split('\n').find((l) => l.trim()) ?? ''}`, {
    hint: workflowScope
      ? 'gh auth refresh -s workflow   (GitHub needs the "workflow" permission to accept .github/workflows files)'
      : /rejected|non-fast-forward|fetch first/i.test(text)
        ? `git pull --rebase origin ${branch}, then run flutter-remote up again`
        : 'run git push yourself to see the full error',
  });
}

/** Standard Flutter .gitignore */
export const GITIGNORE = `.dart_tool/
.packages
build/
.flutter-plugins
.flutter-plugins-dependencies
.pub-cache/
.pub/
ios/Pods/
ios/.symlinks/
ios/Flutter/Flutter.framework
ios/Flutter/Flutter.podspec
*.log
.DS_Store
Thumbs.db
.env*.local
`;
