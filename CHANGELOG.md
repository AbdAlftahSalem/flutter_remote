# Changelog

## 0.2.4

### Fixed
- **The phone kept flashing black, and taps felt slow** (serve-sim's default page). serve-sim sends the Simulator as full-size JPEGs (1206×2622, about 230 KB each on an iPhone 17 Pro), 12–16 per second, even when nothing on the screen moves: 22–30 Mbit/s through the tunnel, measured on a GitHub macOS runner on 2026-11-01. Most connections cannot carry that, so the frames queue up. What you see falls seconds behind what you tap. And whenever one frame takes longer than 2 s, serve-sim's viewer covers the phone with its dark "Connecting..." overlay until the next frame lands. The gate now serves `<helper>/stream.mjpeg` itself (`stream-relay.cjs`), from one shared connection to serve-sim:
  - frames are scaled so the longest side is at most 960 px and re-encoded at quality 0.6 (FFmpeg, from the `ffmpeg-static` the runner already installs). That is about 8× less data on a moving screen;
  - identical frames (serve-sim's idle re-sends) are dropped. A still screen costs about one frame a second, enough that the viewer never dims;
  - at most 24 frames a second, but the last frame of a burst always goes out;
  - on a slow connection the newest frame replaces older ones instead of queueing behind them.

  In the tests, on a link throttled to 8 Mbit/s, a change on the screen showed after 10.3 s before this change and in under 1.5 s after it. `FLUTTER_REMOTE_STREAM_RELAY=0` turns the relay off.
- **`?player=webrtc` stuck on "Connected, waiting for video feed..."** on real networks. A lost video packet was never sent again, and a keyframe of a full-size frame is ~100 packets. On a path that drops 3 % of UDP packets, Chrome decoded 3 frames in 11 s. The peer now resends lost packets when Chrome asks for them (NACK), paces keyframe bursts, and encodes at the same 960 px. Same lossy path: full frame rate, no frames lost.
- `--max-dimension`, `--fps` and `--quality` (and the workflow inputs `max_dimension`, `video_fps`, `video_quality`) were accepted but did nothing. They now set what the browser receives, in both players. The new defaults are 960 / 24 / 0.6; use `--max-dimension 0` for full size.
- The WebRTC encoder showed each picture two frames late (FFmpeg holds piped frames back). When serve-sim goes quiet, the last picture is now pushed through at once.
- The WebRTC player sends finger moves the moment they happen, instead of once per display frame. Finger down/up go on a reliable channel, so a lost "up" can no longer leave a finger on the screen. The peer drops moves that arrive after their "up".
- The H.264 encoder probe ran `ffmpeg` from PATH (not installed on the runner) and logged a misleading fallback. VideoToolbox is now opt-in (`FLUTTER_REMOTE_VIDEOTOOLBOX=1`), and libx264 is the default the tests prove.

### Added
- Tests: `test/e2e/relay.e2e.test.mjs` (8 tests, part of `npm test`). In `npm run test:real-ui`, serve-sim's real page on an 8 Mbit/s link (a screen change must show within 1.5 s, and the phone never dims). `npm run test:lossy` (Linux, sudo) is the WebRTC player under 3 % UDP loss in a network namespace. It fails without NACK (5 frames in 10 s) and passes with it.

## 0.2.3

### Fixed
- **Taps and typing never reached the Simulator** (the stream was live, but clicking the phone did nothing and serve-sim's Event Log stayed at 0). Two bugs, both hidden by the test stand-in:
  - The gate injects the browser client into serve-sim's own preview page. That page has no `#flutter-remote-container`, so the client mounted on `document.body` and laid a transparent full-page input overlay (z-index 10) over serve-sim's phone. Every click on the phone hit the overlay, never serve-sim's own view. On serve-sim's page the client now stays out of the way, and serve-sim's own viewer handles video and input (its input socket is already tunnelled by the gate).
  - The clicks the overlay captured went through WebRTC to the runner, which sent them to `ws://127.0.0.1:3200/ws` as JSON text. serve-sim has no `/ws`: its input socket is `/helper/<udid>/ws`, and it takes binary frames (a tag byte, then JSON: 3 = touch, 6 = key, 11 = scroll). serve-sim closed the connection, so every event was dropped. The peer now connects to the real socket (from serve-sim's reported `wsUrl`, or derived from the stream path) and translates pointer, keyboard, scroll and paste into serve-sim's frames. The legacy v1 client (`FLUTTER_REMOTE_TRANSPORT=v1`) relayed serve-sim's frames to the same dead path; those now pass through to the real socket too.
- The synthetic serve-sim used by the tests now speaks the real protocol (`/helper/<udid>/ws`, binary frames, bare `/ws` refused) and serves a page shaped like serve-sim's UI, so these bugs fail the suite instead of passing it.

### Added
- `?player=webrtc` on the session link opens the WebRTC player full-window on top of serve-sim's UI (low-latency H.264 video, input through the peer).

## 0.2.2

### Fixed
- The 0.2.1 package on npm also contained the old pre-0.2.0 modules (`src/cli.js`, `src/commands`, `src/lib`, `src/webrtc`, … about 380 KB of dead code), because it was packed from a folder that still had them on disk. 0.2.2 ships only the files in git.
- `npm publish` now refuses to run when `bin/` or `src/` has uncommitted or ignored files (`prepublishOnly`).
- `main` now carries the version that is on npm (the 0.2.1 bump was published but never pushed to `main`).

## 0.2.1

- Version bump only (published to npm on 2026-10-25).

## 0.2.0

### Fixed
- The black-screen fix (0.1.2) now reaches existing projects with a plain `flutter-remote up`. Before, `gate.cjs` changed without a version bump, so only `init --force` updated it. Scaffolded files now carry a content hash, so no version number has to be remembered.
- The software H.264 path that actually ran lacked `repeat-headers` (a copy of the FFmpeg arguments had drifted); there is now one argument builder.
- `benchmark` against a live session never worked (it called the Actions run URL over plain HTTP); it now reads the runner metrics through the gate with the session token.
- `--r2` printed "Uploaded" without uploading; it now says R2 upload is not supported yet.
- Spinner lines no longer garble with the status line that follows them.
- `flutter-remote turn` passes secrets to `gh` through stdin, not the command line.

### Added
- Preflight before `up`: Node, Git, GitHub CLI, login, the `workflow` token scope, Flutter project, branch. Every problem is listed at once, each with the command that fixes it, before anything is pushed.
- `doctor` rewritten around the same checks: grouped, a fix under each problem, exit code 3 when something blocks `up`.
- Clear errors everywhere: `Error:` plus a `Fix:` line; exit codes 0/1/2/3; `FLUTTER_REMOTE_DEBUG=1` for stack traces.
- `up` shows numbered steps and elapsed time; `--version`/`-v`, `-h`, "did you mean" for mistyped commands.
- Files flutter-remote no longer ships are removed from `.github/flutter-remote/` when untouched.
- End-to-end test suite (real CLI, gate, WebRTC peer, headless Chrome) and a manual macOS runner E2E workflow.

### Changed
- Source layout: `src/cli` (commands), `src/core` (shared helpers), `src/runner` (exactly what lands in the app's `.github/`).
- The browser client is a real file (`client/flutter-remote-client.js`) instead of a template string inside `gate.cjs`.

### Removed
- Dead code never used at runtime: `src/media` (an older copy of the peer media code), `src/signaling`, `src/webrtc`, `src/session`, `src/input`, `src/metrics`, `src/observability`, `src/simulator`, `src/config`, `src/shared`, and `client/` (never served).
- `HardwareH264Encoder.cjs`/`SoftwareH264Encoder.cjs` and `createVideoEncoder` (unused; `VideoEncoder` covers both paths).
- The old unit/string tests, which tested the dead copies rather than the code that runs.
