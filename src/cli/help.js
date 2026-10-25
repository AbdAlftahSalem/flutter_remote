import { bold, dim, cyan } from '../core/ui.js';

export const HELP = `
${bold('flutter-remote')} — run Flutter iOS applications on a real iOS Simulator on GitHub macOS runners and stream interactively to your browser

${bold('USAGE')}
  flutter-remote <command> [options]

${bold('COMMANDS')}
  up        Push Flutter project, build on macOS runner, and open live simulator ${dim('(default)')}
  init      Scaffold .github/workflows/flutter-remote.yml and auth gate
  status    Show active session details, runner state, and simulator stream URL
  down      Cancel the runner job and shut down the remote simulator ${dim('(--all for every session)')}
  doctor    Check prerequisites (Flutter project, pubspec, git, GitHub auth)
  benchmark Measure the live session, or the H.264 encoder locally ${dim('(--local)')}
  upload    Upload a prebuilt simulator .app to this repository's release ${dim('(--r2 for R2)')}
  r2        Configure Cloudflare R2 credentials ${dim('(--status to inspect)')}
  turn      Configure WebRTC TURN credentials in repository secrets

${bold('GLOBAL OPTIONS')}
  -h, --help             Show this help
  -v, --version          Show the installed version

${bold('OPTIONS (flutter-remote up)')}
  --minutes <n>          Session duration in minutes            ${dim('default 10, max 350')}
  --device <name>        iOS Simulator device name              ${dim('default "iPhone 17 Pro"')}
  --runner <label>       macOS runner image (must be ARM64)     ${dim('default macos-26')}
  --flutter-version <v>  Flutter SDK version or channel         ${dim('default: auto-detected or stable')}
  --build-mode <mode>    debug                                  ${dim('default debug (simulator only supports debug)')}
  --flavor <name>        Flutter flavor to build
  --target <file>        Target main entrypoint Dart file
  --dart-define <K=V>    Define environment config values       ${dim('(can be repeated)')}
  --codec <codec>        Stream codec: mjpeg | h264 | auto      ${dim('default mjpeg (stable, no black screen)')}
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
  ${cyan('flutter-remote doctor')}            ${dim('# check everything before your first run')}
  ${cyan('flutter-remote down')}
`;
