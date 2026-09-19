import { init } from './commands/init.js';
import { up } from './commands/up.js';
import { status } from './commands/status.js';
import { down } from './commands/down.js';
import { doctor } from './commands/doctor.js';
import { upload } from './commands/upload.js';
import { r2Setup } from './commands/r2.js';
import { turn } from './commands/turn.js';
import { bold, dim, cyan, green } from './lib/ui.js';

const HELP = `
${bold('flutter-remote')} — run Flutter iOS applications on a real iOS Simulator on GitHub macOS runners and stream interactively to your browser

${bold('USAGE')}
  flutter-remote <command> [options]

${bold('COMMANDS')}
  up        Push Flutter project, build on macOS runner, and open live simulator ${dim('(default)')}
  init      Scaffold .github/workflows/flutter-remote.yml and auth gate
  status    Show active session details, runner state, and simulator stream URL
  down      Cancel the runner job and shut down the remote simulator ${dim('(--all for every session)')}
  doctor    Check prerequisites (Flutter project, pubspec, git, GitHub auth)
  upload    Upload a prebuilt simulator .app to this repository's release ${dim('(--r2 for R2)')}
  r2        Configure Cloudflare R2 credentials ${dim('(--status to inspect)')}
  turn      Configure WebRTC TURN credentials in repository secrets

${bold('OPTIONS (flutter-remote up)')}
  --minutes <n>          Session duration in minutes            ${dim('default 10, max 350')}
  --device <name>        iOS Simulator device name              ${dim('default "iPhone 17 Pro"')}
  --runner <label>       macOS runner image (must be ARM64)     ${dim('default macos-26')}
  --flutter-version <v>  Flutter SDK version or channel         ${dim('default: auto-detected or stable')}
  --build-mode <mode>    debug                                  ${dim('default debug (simulator only supports debug)')}
  --flavor <name>        Flutter flavor to build
  --target <file>        Target main entrypoint Dart file
  --dart-define <K=V>    Define environment config values       ${dim('(can be repeated)')}
  --codec <codec>        Stream codec: mjpeg | auto             ${dim('default mjpeg (stable, no black screen)')}
  --tunnel-protocol <p>  quic | http2                           ${dim('default quic (better on lossy networks)')}
  --app-file <path>      Run a prebuilt local .app or archive
  --app <url>            Run a prebuilt simulator .app from URL
  --app-release <name>   Run an asset from flutter-remote-build release
  --mode <m>             build | app                            ${dim('default build')}
  --agent                Enable agent-device proxy for AI agents
  --export               Download the built .app as artifact
  --no-cache             Force a clean native rebuild
  --public               Create/push to public repository       ${dim('(free unlimited macOS minutes)')}
  --repo <name>          Custom repository name when creating
  --message <msg>        Git commit message
  --no-open              Do not automatically open the browser

${bold('EXAMPLES')}
  ${cyan('flutter-remote up --public --minutes 45')}
  ${cyan('flutter-remote up --device "iPhone 16 Pro"')}
  ${cyan('flutter-remote up --build-mode debug')}
  ${cyan('flutter-remote up --flavor staging --target lib/main_staging.dart')}
  ${cyan('flutter-remote up --dart-define API_URL=https://api.example.com')}
  ${cyan('flutter-remote up --agent')}             ${dim('# live stream + agent-device remote control')}
  ${cyan('flutter-remote up --app-file ./Runner.app')}
  ${cyan('flutter-remote doctor')}
  ${cyan('flutter-remote down')}
`;

const NEEDS_VALUE = new Set([
  'minutes', 'device', 'runner', 'flutter-version', 'build-mode', 'flavor', 'target',
  'dart-define', 'codec', 'fps', 'quality', 'max-dimension', 'app-file', 'app',
  'app-release', 'mode', 'repo', 'message', 'account-id', 'access-key-id', 'secret-access-key',
  'bucket', 'key-id', 'key-token', 'tunnel-protocol',
]);

export function parseArgs(argv) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
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
      if (value === undefined) throw new Error(`--${key} requires a value`);
      if (key === 'minutes' || key === 'fps' || key === 'max-dimension') {
        flags[key] = Number(value);
      } else if (key === 'quality') {
        flags[key] = parseFloat(value);
      } else if (key === 'dart-define') {
        if (!flags['dart-define']) flags['dart-define'] = [];
        if (Array.isArray(flags['dart-define'])) {
          flags['dart-define'].push(value);
        } else {
          flags['dart-define'] = [flags['dart-define'], value];
        }
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

export async function main(argv) {
  const { command, flags } = parseArgs(argv);

  if (flags.help || flags.h || command === 'help') {
    console.log(HELP);
    return;
  }

  if (flags.minutes !== undefined && (!Number.isFinite(flags.minutes) || flags.minutes < 1 || flags.minutes > 350)) {
    throw new Error('--minutes must be between 1 and 350 (GitHub hosted runner maximum)');
  }
  if (flags.transport && !['http', 'webrtc'].includes(flags.transport)) {
    throw new Error(`--transport must be "http" or "webrtc", got "${flags.transport}"`);
  }
  if (flags['tunnel-protocol'] && !['quic', 'http2'].includes(flags['tunnel-protocol'])) {
    throw new Error(`--tunnel-protocol must be "quic" or "http2", got "${flags['tunnel-protocol']}"`);
  }
  if (flags.codec && !['mjpeg', 'h264', 'auto'].includes(flags.codec)) {
    throw new Error(`--codec must be "auto", "mjpeg", or "h264", got "${flags.codec}"`);
  }
  if (flags['build-mode'] && !['debug', 'profile', 'release'].includes(flags['build-mode'])) {
    throw new Error(`--build-mode must be "debug", "profile", or "release", got "${flags['build-mode']}"`);
  }
  if (flags.mode && !['build', 'app'].includes(flags.mode)) {
    throw new Error(`--mode must be "build" or "app", got "${flags.mode}"`);
  }
  if (typeof flags.app === 'string' && !/^https?:\/\//.test(flags.app)) {
    throw new Error(
      `--app requires an accessible HTTP/HTTPS URL, got "${flags.app}".\n` +
      `A local file path will not work — use --app-file <path> instead.`
    );
  }

  const cwd = process.cwd();
  const commands = { up, init, status, down, doctor, upload, r2: r2Setup, turn };
  const handler = commands[command];
  if (!handler) {
    throw new Error(`Unknown command "${command}". Run: flutter-remote --help`);
  }

  await handler(cwd, flags);
}
