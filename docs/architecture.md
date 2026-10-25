# Architecture

flutter-remote has three runtimes. Each has one folder, and nothing is copied
between them by hand.

| Runtime | Where it runs | Source |
|---|---|---|
| CLI | the developer's computer (Windows, Linux, macOS) | `bin/`, `src/cli/`, `src/core/` |
| Runner bundle | the GitHub macOS runner | `src/runner/` (copied into the app repo by `init`/`up`) |
| Browser client | the viewer's browser | `src/runner/flutter-remote/client/` (served by the gate) |

## CLI (`src/cli`, `src/core`)

```text
bin/flutter-remote.js     entry: runs main(), prints "Error:" + "Fix:" and exits with err.exitCode
src/cli/index.js          dispatch, --help, --version, "did you mean"
src/cli/args.js           argv parsing + flag validation (usage errors, exit 2)
src/cli/help.js           help text
src/cli/commands/*.js     one file per command
src/core/errors.js        FlutterRemoteError {message, hint, exitCode}; EXIT codes
src/core/preflight.js     every check doctor prints and up enforces (each with a fix)
src/core/scaffold.js      manifest of runner files, hashed headers, safe upgrade
src/core/proc.js          sh / shx / has / open / sleep (cross-platform process helpers)
src/core/git.js gh.js     git and GitHub CLI wrappers (errors carry fixes)
src/core/ui.js            colors, numbered steps, spinner with elapsed time
src/core/session.js       the session file (.git/flutter-remote-session.json)
src/core/flutter-project.js app-validator.js ghrelease.js r2.js
```

Rules: commands only talk to the outside world through `src/core`; every
user-facing failure is a `FlutterRemoteError` with a one-line fix; nothing
under `src/core` prints except `ui.js`.

## Runner bundle (`src/runner`)

```text
src/runner/workflow/flutter-remote.yml  → .github/workflows/flutter-remote.yml
src/runner/flutter-remote/              → .github/flutter-remote/   (1:1)
  runtime.cjs          env config + crash guards (shared by gate and peer)
  gate.cjs             auth gate: ?k= token → HttpOnly cookie, proxies serve-sim,
                       WebSocket upgrades (/signal → peer), injects the client
  client/flutter-remote-client.js   browser client (WebRTC video + input channels)
  client/legacy-hid.js              v1 client (FLUTTER_REMOTE_TRANSPORT=v1)
  webrtc-peer.cjs      MJPEG from serve-sim → H.264 → RTP over WebRTC; input → serve-sim /ws
  peer/
    PeerSession.cjs        one browser: offer/answer, H.264 negotiated from the offer
    DataChannelRouter.cjs  input / keyboard / control / telemetry channels
    ServeSimConsumer.cjs   reads serve-sim's MJPEG stream, forwards input
    mjpeg.cjs              JPEG splitter (also used by `benchmark`)
    VideoEncoder.cjs       FFmpeg H.264 encoder (VideoToolbox or libx264)
    ffmpegArgs.cjs         the single FFmpeg argument builder
    BaseVideoEncoder.cjs   process supervision, NAL parsing, access units
    KeyframeController.cjs RtpPacketizer.cjs EncoderDetector.cjs
    AdaptiveQualityController.cjs Metrics.cjs
```

Scaffold headers: each copied file starts with
`// flutter-remote:managed sha256=<hash of the body>`. On the next `up`/`init`:
untouched files are upgraded, edited files are kept (warning), files from 0.1.x
(`template-version: N`) are upgraded, files no longer shipped are removed if
untouched. Line endings are normalized first, so Windows checkouts are fine.

## Data flow on the runner

```text
iOS Simulator → serve-sim :3200 ──MJPEG──▶ webrtc-peer :3201 ──H.264/RTP──┐
                     ▲  /ws (input)              ▲ /signal (WebSocket)       │
                     └────────── gate :3199 ─────┘                            │
                                   ▲ cloudflared (https)                      │
browser ──── page + client.js + signaling ──────┘                             │
browser ◀──────────────────────── WebRTC video + DataChannels ◀───────────────┘
```

## Tests

See [testing.md](testing.md).
