import { usageError } from '../core/errors.js';

/** Flags that take a value (`--name value` or `--name=value`). */
const NEEDS_VALUE = new Set([
  'minutes', 'device', 'runner', 'flutter-version', 'build-mode', 'flavor', 'target',
  'dart-define', 'codec', 'fps', 'quality', 'max-dimension', 'app-file', 'app',
  'app-release', 'mode', 'repo', 'message', 'account-id', 'access-key-id', 'secret-access-key',
  'bucket', 'key-id', 'key-token', 'tunnel-protocol', 'frames', 'transport',
]);
const NUMERIC = new Set(['minutes', 'fps', 'max-dimension', 'frames']);
const SHORT = { h: 'help', v: 'version' };

/**
 * Parse argv into `{ command, flags }`. `flags._positional` holds the
 * positional arguments after the command.
 */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (/^-[a-z]$/i.test(arg) && SHORT[arg[1]]) {
      flags[SHORT[arg[1]]] = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    let key = arg.slice(2);
    let value;
    const eq = key.indexOf('=');
    if (eq !== -1) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    if (key.startsWith('no-')) {
      flags[key.slice(3)] = false;
      continue;
    }
    if (NEEDS_VALUE.has(key)) {
      value ??= argv[++i];
      if (value === undefined || (value.startsWith('--') && eq === -1)) {
        throw usageError(`--${key} needs a value`, `example: flutter-remote up --${key} <value>`);
      }
      if (NUMERIC.has(key)) {
        flags[key] = Number(value);
      } else if (key === 'quality') {
        flags[key] = parseFloat(value);
      } else if (key === 'dart-define') {
        flags['dart-define'] = [...(flags['dart-define'] ?? []), value];
      } else {
        flags[key] = value;
      }
      continue;
    }
    flags[key] = value ?? true;
  }

  flags._positional = positional.slice(1);
  return { command: positional[0] ?? 'up', flags };
}

const oneOf = (flag, value, allowed) => {
  if (value !== undefined && !allowed.includes(value)) {
    throw usageError(
      `--${flag} must be ${allowed.map((a) => `"${a}"`).join(' or ')}, got "${value}"`,
      `flutter-remote up --${flag} ${allowed[0]}`,
    );
  }
};

/** Validate flag values; throws a usage error with a fix on the first bad one. */
export function validateFlags(flags) {
  if (flags.minutes !== undefined && (!Number.isInteger(flags.minutes) || flags.minutes < 1 || flags.minutes > 350)) {
    throw usageError('--minutes must be a whole number from 1 to 350 (the GitHub-hosted runner limit)', 'flutter-remote up --minutes 30');
  }
  oneOf('transport', flags.transport, ['webrtc', 'http']);
  oneOf('tunnel-protocol', flags['tunnel-protocol'], ['quic', 'http2']);
  oneOf('codec', flags.codec, ['mjpeg', 'h264', 'auto']);
  oneOf('build-mode', flags['build-mode'], ['debug', 'profile', 'release']);
  oneOf('mode', flags.mode, ['build', 'app']);
  if (typeof flags.app === 'string' && !/^https?:\/\//.test(flags.app)) {
    throw usageError(
      `--app needs an http(s) URL, got "${flags.app}"`,
      'for a file on this computer use: flutter-remote up --app-file <path>',
    );
  }
}
