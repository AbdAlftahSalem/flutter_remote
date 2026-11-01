# flutter-remote

> Run your Flutter app in a **real iOS Simulator** from Windows, Linux or macOS, and use it in your browser. No Mac needed.

[![npm version](https://img.shields.io/npm/v/flutter-remote.svg?color=cb3837)](https://www.npmjs.com/package/flutter-remote)
[![CI](https://github.com/AbdAlftahSalem/flutter_remote/actions/workflows/ci.yml/badge.svg)](https://github.com/AbdAlftahSalem/flutter_remote/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

`flutter-remote up` pushes your project to GitHub, builds it on a GitHub-hosted macOS runner, boots the iOS Simulator, and gives you a private link. Open it in Chrome, Edge or Firefox and tap, swipe and type into your app live.

It is not Flutter Web and not a recording: it is your real iOS build in Apple's Simulator, streamed over WebRTC.

## Quick start (3 steps)

1. **Install** (Node.js 20+, Git and the GitHub CLI are the only requirements):

   ```bash
   npm install -g flutter-remote
   gh auth login            # once; pick "HTTPS" and allow the "workflow" scope
   ```

2. **Check** that everything is ready (each problem comes with the command that fixes it):

   ```bash
   cd my_flutter_app
   flutter-remote doctor
   ```

3. **Run**:

   ```bash
   flutter-remote up --public
   ```

   `--public` creates a **new public** GitHub repository, where macOS runner minutes are free. It only applies when the project has no GitHub repository yet: an existing repository keeps its visibility. Private repositories work too, but their runs use your GitHub Actions minutes.

What you see:

```text
[1/5] Checking prerequisites
✓ Node.js, Git, GitHub CLI and project look good

[2/5] Pushing your project to GitHub
✓ wrote .github/workflows/flutter-remote.yml
✓ Committed 18 changed file(s) on main
✓ Pushed main to you/my_flutter_app

[3/5] Starting the macOS runner
✓ Workflow registered
✓ Runner started: https://github.com/you/my_flutter_app/actions/runs/123

[4/5] Building the app and starting the simulator (the first run takes a while; later runs are faster thanks to caching)
✓ Simulator is live

[5/5] Open the simulator

  ● Your Flutter app is live in the iOS Simulator

  https://xxxx.trycloudflare.com/?k=…

  Anyone with this link can use the simulator. Stop it with: flutter-remote down
```

The link opens in your browser automatically (`--no-open` to skip).

## Commands

| Command | What it does |
|---|---|
| `flutter-remote up` | Push, build on macOS, boot the Simulator, open the live link (default command) |
| `flutter-remote doctor` | Check Node, Git, GitHub CLI login and permissions, the project and the repo; prints a fix for every problem |
| `flutter-remote status` | Show the current session, runner state and live link |
| `flutter-remote down` | Stop the runner (`--all` stops every flutter-remote run) |
| `flutter-remote init` | Add or update the workflow files in your project (`--force` overwrites your edits) |
| `flutter-remote upload <Runner.app>` | Upload a prebuilt simulator app to a GitHub release, then run it with `up --app-release` |
| `flutter-remote benchmark` | Measure the live session, or the H.264 encoder locally with `--local` |
| `flutter-remote turn` | Save TURN relay credentials (for strict firewalls) as repository secrets |

`flutter-remote --help` lists every option; `flutter-remote --version` prints the version.

### Options for `up`

| Option | Default | Description |
|---|---|---|
| `--public` | off | When creating the repository, make it public (free macOS minutes). Has no effect on an existing repository |
| `--minutes <n>` | `10` | How long the session stays open (1–350) |
| `--device <name>` | `iPhone 17 Pro` | Simulator device |
| `--runner <label>` | `macos-26` | macOS runner label (must be Apple Silicon) |
| `--flutter-version <v>` | from `pubspec.yaml`, else `stable` | Flutter SDK version or channel |
| `--flavor <name>` / `--target <file>` | none | Flutter flavor and entry point |
| `--dart-define <K=V>` | none | Build-time values (repeatable) |
| `--codec <codec>` | `mjpeg` | How serve-sim captures the Simulator: `mjpeg`, `h264` or `auto` (= `mjpeg`) |
| `--transport <mode>` | `webrtc` | `webrtc`, or `http` for the older injected client |
| `--tunnel-protocol <p>` | `quic` | `quic` or `http2` (falls back to `http2` automatically) |
| `--max-dimension <px>` | `960` | Longest side of the picture sent to the browser (`0` = full size, e.g. 1206×2622 on an iPhone 17 Pro). Smaller = less lag on slow connections |
| `--fps <n>` | `24` | Most frames per second sent to the browser |
| `--quality <q>` | `0.6` | Picture quality, `0.05`–`1` |
| `--app-file <path>` | none | Run a prebuilt simulator `.app` (or `.zip`/`.tar.gz`) instead of building |
| `--app <url>` / `--app-release <name>` | none | Run a prebuilt app from a URL or a release asset |
| `--no-cache` | off | Force a clean native rebuild |
| `--agent` | off | Expose the agent-device proxy for AI agents |
| `--export` | off | Save the built `.app` as a workflow artifact |
| `--repo <name>` / `--message <msg>` | app name / timestamp | Repository name when creating one; commit message |

### Exit codes

`0` success · `1` failure · `2` wrong usage (bad command or flag) · `3` a prerequisite is missing (`doctor` tells you which).

## Troubleshooting

Start with `flutter-remote doctor`. Common cases:

| You see | Do this |
|---|---|
| `GitHub login: gh is not logged in` | `gh auth login` |
| `Permission to push workflows` fails, or `git push` is refused for `.github/workflows` | `gh auth refresh -s workflow` |
| `On a branch: HEAD is detached` | `git switch main` |
| Black screen in the browser | Update: `npm i -g flutter-remote@latest`, then `flutter-remote up` (files from older versions are upgraded automatically). If it persists, attach `webrtc-peer.log` from the Action log to an issue. |
| The app shows, but taps and typing do nothing (serve-sim's Event Log stays at 0) | Fixed in 0.2.3: `npm i -g flutter-remote@latest`, then `flutter-remote up` again. On an older version, open DevTools (F12) → Console on the session page and run `document.getElementById('flutter-remote-input-overlay')?.remove()`. If the Event Log then counts taps but the app still does not react (Xcode 27 runners), see serve-sim's `repair-input`. |
| The phone flashes black or lags behind your taps | Fixed in 0.2.3 (the stream is scaled to 960 px and paced to your connection). On a slow connection try `--max-dimension 720 --fps 15`; for full size `--max-dimension 0`. |
| `npx github:AbdAlftahSalem/flutter_remote up` prints nothing | The first `npx` of a GitHub package clones and installs it silently, which can take a little while, then runs. Wait for it, or install once with `npm i -g github:AbdAlftahSalem/flutter_remote` and run `flutter-remote up`. |
| `...edited by you, so it was kept` | You changed a generated file. `flutter-remote init --force` restores it. |
| GitHub minutes used up | Minutes are free on public repositories. Make the existing one public (`gh repo edit --visibility public`), or run from a copy of the project with no remote using `flutter-remote up --public`, or wait for the monthly reset. Either way the code becomes public. |

Set `FLUTTER_REMOTE_DEBUG=1` to print stack traces.

## How it works

```text
your computer                          GitHub macOS runner
─────────────                          ───────────────────────────────────────────────
flutter-remote up ──push + dispatch──▶ flutter-remote.yml
                                         ├─ flutter build ios --simulator
                                         ├─ iOS Simulator ──▶ serve-sim (preview UI, MJPEG, input socket /helper/<udid>/ws)
                                         ├─ webrtc-peer.cjs  (MJPEG → H.264 → WebRTC video, input channels)
                                         ├─ gate.cjs         (token auth, injects the browser client)
                                         └─ cloudflared      (public https link)
browser ◀────────────── serve-sim's UI: its video + its input socket, through the gate ──▶
        ◀────────────── ?player=webrtc: WebRTC video + DataChannels (tap, swipe, keys) ─▶
```

The link opens serve-sim's own preview UI (device list, tools, event log); taps and keys go from it straight to serve-sim's input socket through the gate. Add `?player=webrtc` to the link for the full-window WebRTC player; its input is translated by `webrtc-peer.cjs` into serve-sim's frames.

The files that run on the runner are copied into your project under `.github/` by `init`/`up`. Each one carries a header with a content hash, so a newer flutter-remote upgrades the files it wrote, keeps the ones you edited, and is not confused by Windows line endings.

### Security

- Every session gets a new random 24-byte token. The link carries it once (`?k=`); the gate swaps it for an `HttpOnly` cookie and removes it from the URL.
- Requests without the token get a `403` page; WebSocket upgrades without it are refused.
- The token is never committed to git; TURN credentials are stored as repository secrets and sent to GitHub through stdin.

## Development

```text
bin/flutter-remote.js        CLI entry (prints errors with a "Fix:" line)
src/cli/                     argument parsing, help, one file per command
src/core/                    git, gh, preflight checks, scaffold, errors, terminal UI
src/runner/                  everything that runs on the macOS runner (copied into the app repo)
  workflow/flutter-remote.yml   → .github/workflows/flutter-remote.yml
  flutter-remote/**             → .github/flutter-remote/**  (gate, browser client, WebRTC peer)
test/e2e/                    end-to-end tests (real processes, real Chrome)
test/runner/                 full test on a real macOS runner + Simulator
test/support/                process harness, synthetic serve-sim, browser helpers
docs/                        architecture and history
```

```bash
npm ci
npm test              # all local E2E: CLI, scaffold, gate, browser streaming (needs Google Chrome)
npm run test:cli      # CLI + scaffold only (no browser)
npm run check         # every file parses
```

The tests are end-to-end only: they start the real CLI, the real gate and WebRTC peer, a synthetic serve-sim that streams FFmpeg test video, and a real headless Google Chrome, and they check that real video frames arrive. The iOS Simulator part runs in `.github/workflows/e2e-runner.yml` (manual; see [docs/testing.md](docs/testing.md)).

## License

MIT © AbdAlftah Salem
