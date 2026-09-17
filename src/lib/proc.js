import { spawnSync, spawn } from 'node:child_process';

/**
 * Run a command and capture output. Never throws.
 */
export function sh(cmd, args = [], opts = {}) {
  const isWin = process.platform === 'win32';
  // On Windows, if running a batch file or built-in, use shell if needed, but spawnSync works directly for .exe/.cmd
  const r = spawnSync(cmd, args, {
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
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.code})\n${r.err || r.out}`);
  }
  return r.out;
}

/**
 * Run a command with inherited stdio so user sees live output.
 */
export function run(cmd, args = [], opts = {}) {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    windowsHide: true,
    ...opts,
  });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with code ${r.status}`);
  }
}

/**
 * Check whether a command exists in system PATH (cross-platform).
 */
export function has(cmd) {
  const checker = process.platform === 'win32' ? 'where.exe' : 'which';
  return sh(checker, [cmd]).ok;
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
