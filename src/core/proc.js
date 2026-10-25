import { spawnSync, spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { FlutterRemoteError } from './errors.js';

function resolveCommand(cmd) {
  if (cmd === 'gh' && process.platform === 'win32') {
    if (hasInPath('gh')) return 'gh';
    const candidates = [
      'C:\\Program Files\\GitHub CLI\\gh.exe',
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'GitHub CLI', 'gh.exe') : null,
      process.env.ProgramFiles ? join(process.env.ProgramFiles, 'GitHub CLI', 'gh.exe') : null,
    ].filter(Boolean);
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
  }
  return cmd;
}

/** Look a command up on PATH ourselves (no dependency on `which`/`where`). */
function hasInPath(cmd) {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      try {
        if (statSync(candidate).isFile()) return true;
      } catch {
        // not in this directory
      }
    }
  }
  return false;
}

/**
 * Run a command and capture output. Never throws.
 */
export function sh(cmd, args = [], opts = {}) {
  const resolved = resolveCommand(cmd);
  const r = spawnSync(resolved, args, {
    encoding: 'utf8',
    windowsHide: true,
    ...opts,
  });

  return {
    ok: r.status === 0,
    code: r.status,
    out: (r.stdout ?? '').trim(),
    err: (r.stderr ?? '').trim(),
  };
}

/**
 * Run a command and throw error on non-zero exit code.
 */
export function shx(cmd, args = [], opts = {}) {
  const r = sh(cmd, args, opts);
  if (!r.ok) {
    const firstLine = (r.err || r.out || `exit code ${r.code}`).split('\n').find((l) => l.trim()) ?? '';
    throw new FlutterRemoteError(`\`${cmd} ${args.join(' ')}\` failed: ${firstLine}`, {
      hint: `run it yourself to see the full output: ${cmd} ${args.join(' ')}`,
    });
  }
  return r.out;
}

/**
 * Check whether a command exists in system PATH or standard locations (cross-platform).
 */
export function has(cmd) {
  if (hasInPath(cmd)) return true;
  if (cmd === 'gh' && process.platform === 'win32') {
    return resolveCommand('gh') !== 'gh';
  }
  return false;
}

/**
 * Open a URL in the user's default browser cross-platform.
 */
export function open(url) {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '""', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

/**
 * Sleep for the specified number of milliseconds.
 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
