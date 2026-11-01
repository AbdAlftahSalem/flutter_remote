# Changelog

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
