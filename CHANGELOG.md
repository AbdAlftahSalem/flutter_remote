# Changelog

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
