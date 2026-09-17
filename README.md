# Flutter Remote (`flutter-remote`)

> Run, test, and interact with real **Flutter iOS applications** on a genuine **Apple iOS Simulator** hosted on GitHub macOS runners — directly from Chrome, Edge, or Firefox on **Windows, Linux, or macOS**.

[![npm version](https://img.shields.io/npm/v/flutter-remote.svg?color=cb3837)](https://www.npmjs.com/package/flutter-remote)
[![npm downloads](https://img.shields.io/npm/dm/flutter-remote.svg)](https://www.npmjs.com/package/flutter-remote)
[![CI](https://github.com/AbdAlftahSalem/flutter_remote/actions/workflows/ci.yml/badge.svg)](https://github.com/AbdAlftahSalem/flutter_remote/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Platform: Cross-Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey.svg)](https://github.com/AbdAlftahSalem/flutter_remote)

---

## Overview

**Flutter Remote** allows any developer — especially those on Windows or Linux who do not own a Mac or physical iPhone — to:
1. Push their Flutter project to GitHub.
2. Automatically compile a native iOS Simulator application on GitHub's hosted macOS ARM64 runners.
3. Boot an iOS Simulator, install the application, and launch it via `xcrun simctl`.
4. Stream the live Simulator display and send touch/gesture events interactively in the web browser.

This is **NOT** Flutter Web, a static video, or an HTML mock. It is a **real Apple iOS Simulator** executing your compiled Flutter iOS app in real time.

---

## Architecture

```text
                 Developer (Windows / Linux / macOS)
                                 │
                                 │ flutter-remote up
                                 ▼
                          Local CLI
                                 │
                                 │ GitHub API (gh)
                                 ▼
                         GitHub Repository
                                 │
                                 ▼
                         GitHub Actions
                                 │
                                 ▼
                        macOS ARM64 Runner
                                 │
                  ┌──────────────┴──────────────┐
                  │                             │
             Flutter SDK                      Xcode
                  │                             │
                  └──────────────┬──────────────┘
                                 │ flutter build ios --simulator
                                 ▼
                           iOS Simulator
                          (xcrun simctl)
                                 │
                                 ▼
                             serve-sim
                                 │
                                 ▼
                         Auth Gate Proxy
                           (gate.cjs)
                                 │
                                 ▼
                           Secure Tunnel
                           (cloudflared)
                                 │
                                 ▼
                         Web Browser (User)
               (Tap, Drag, Swipe, Scroll, Type)
```

---

## Prerequisites

### On Your Local Machine
- **Node.js** >= 20.0.0
- **Git**
- **GitHub CLI (`gh`)** logged in (`gh auth login`)

> [!NOTE]
> You do **NOT** need macOS, Xcode, CocoaPods, or an iPhone locally.
> Local Flutter installation is completely optional.

---

## Installation

Install globally via npm:

```bash
npm install -g flutter-remote
```

Or run directly with npx:

```bash
npx flutter-remote up --public
```

---

## Quick Start

Navigate to your Flutter project root and run:

```bash
cd my_flutter_app
flutter-remote up --public
```

### Expected Output:

```text
Preparing Flutter project & repository
✓ git init (initialized git repository)
✓ Committed changes on main
✓ Pushed branch main to user/my_flutter_app
✓ Pushed flutter-remote workflow & gate to GitHub
✓ GitHub Actions workflow registered

Dispatching GitHub macOS runner job
✓ Runner started: https://github.com/user/my_flutter_app/actions/runs/123456789
✓ Simulator is live and streaming!

  ● Flutter iOS Simulator is live

  https://xxxxxx.trycloudflare.com/?k=AbCdEfGh123456789

  Anyone with this link can interact with the iOS Simulator from their browser.
  Stop it with: flutter-remote down
```

The browser will open automatically and display the interactive iOS Simulator.

---

## Supported Browser Interactions

The browser interface streams the iOS Simulator display with full bidirectional control:
- **Tap / Click:** Tap buttons, list items, tabs, and form controls.
- **Drag & Swipe:** Page transitions, carousels, drawers, and modal sheets.
- **Smooth Scrolling:** Scroll lists, grids, and Flutter CustomScrollViews.
- **Keyboard Input:** Type text into Flutter `TextField` and `TextFormField` widgets.
- **Navigation:** Back gestures, AppBar actions, and tab bars.
- **Real Flutter Engine:** Native skia/impeller rendering directly from the iOS Simulator.

---

## Commands

| Command | Description |
|---|---|
| `flutter-remote up` | Build Flutter app on macOS runner and open live browser stream |
| `flutter-remote status` | Show current session info, runner state, and live stream URL |
| `flutter-remote down` | Terminate the remote runner and close the simulator stream |
| `flutter-remote doctor` | Diagnose environment, Flutter project, git, and GitHub auth |
| `flutter-remote init` | Scaffold workflow and gate proxy files into your project |
| `flutter-remote upload` | Upload a prebuilt `.app` bundle archive to GitHub release |
| `flutter-remote r2` | Configure Cloudflare R2 credentials for prebuilt app hosting |
| `flutter-remote turn` | Set WebRTC TURN relay credentials in repository secrets |

---

## CLI Options Reference (`flutter-remote up`)

| Option | Default | Description |
|---|---|---|
| `--minutes <n>` | `10` | Duration to hold simulator session open (1 to 350 min) |
| `--device <name>` | `iPhone 17 Pro` | Simulator device name (auto-falls back if runner differs) |
| `--runner <label>` | `macos-26` | GitHub macOS runner label (must be ARM64 for serve-sim) |
| `--flutter-version <v>` | `stable` | Flutter SDK version or channel (e.g. `3.29.0`) |
| `--build-mode <mode>` | `debug` | Flutter build mode (`debug`, `profile`, `release`) |
| `--flavor <name>` | _none_ | Flutter flavor (e.g. `staging`, `production`) |
| `--target <file>` | _none_ | Target entrypoint Dart file (e.g. `lib/main_dev.dart`) |
| `--dart-define <K=V>` | _none_ | Pass build-time environment variables (repeatable) |
| `--codec <codec>` | `mjpeg` | Stream codec (`mjpeg` or `h264`) |
| `--fps <n>` | `30` | MJPEG streaming frame rate |
| `--quality <n>` | `0.7` | MJPEG image quality (0.05 to 1.0) |
| `--max-dimension <n>` | `900` | Max captured dimension in pixels (keeps stream snappy) |
| `--app-file <path>` | _none_ | Run a prebuilt `.app` directory or archive directly |
| `--app <url>` | _none_ | Download and run a prebuilt simulator `.app` from URL |
| `--public` | `false` | Push to public GitHub repo (unlimited free macOS minutes) |
| `--no-cache` | `false` | Bypass cache and force a complete native rebuild |
| `--no-open` | `false` | Do not automatically open the browser window |
| `--agent` | `false` | Enable `agent-device` proxy for AI coding agent control |
| `--export` | `false` | Download compiled `.app` bundle as workflow artifact |

---

## Build Caching

`flutter-remote` computes a native build fingerprint:
- Hashes `pubspec.yaml`, `pubspec.lock`
- Hashes all source files in `lib/`, `assets/`, and `ios/`
- Combines with runner image, Flutter version, build mode, flavor, and dart-defines

When code and dependencies have not changed, the compiled `.app` is restored from cache, booting the simulator in seconds without rebuilding!

---

## Security Model

1. **Gate Token Authentication**:
   - Every session generates a cryptographically secure, high-entropy 24-byte base64url gate token.
   - The token is passed directly into the URL (`?k=<token>`) and exchanged by `gate.cjs` for an `HttpOnly` cookie.
   - Unauthenticated requests receive an immediate `401 Unauthorized`.
2. **No Secret Leaks**:
   - Tokens and credentials are never stored in git history.
   - Tokens are never printed in GitHub Actions build logs.
3. **Public Repository Warning**:
   - If `--public` is used on a new repository, `flutter-remote` alerts you that project source code will be publicly visible on GitHub.

---

## Troubleshooting & Diagnostics

Run diagnostics at any time from your Flutter project directory:

```bash
flutter-remote doctor
```

```text
Flutter Remote Doctor

  ✓ Flutter project (crypto)
  ✓ pubspec.yaml (v1.0.0+1)
  ✓ iOS project directory (bundle: com.example.crypto)
  ✓ Git installed
  ✓ GitHub CLI installed
  ✓ GitHub authenticated (@myusername)
  ✓ Node.js >= 20 (v22.18.0)
  ✓ .github/workflows/flutter-remote.yml
  ✓ .github/flutter-remote/gate.cjs
  ✓ GitHub remote (myusername/crypto)
  ✓ Local Flutter (optional)
```

---

## Limitations

- **Simulator Build Only**: Builds are compiled with `flutter build ios --simulator --no-codesign`. Device-only IPAs cannot be executed inside the iOS Simulator.
- **GitHub Runner Limits**: GitHub Actions hosted runners enforce a maximum job execution time of 360 minutes (6 hours). `flutter-remote` caps sessions at 350 minutes.
- **macOS Provisioning**: GitHub macOS runners typically take 30–60 seconds to spin up on initial dispatch.

---

## License

MIT © AbdAlftah Salem
