# Testing

Every test is end-to-end: it starts real processes and talks to them over real
sockets. There are no mocks or stubs of flutter-remote code.

The one stand-in is **serve-sim**, because the iOS Simulator exists only on
macOS: `test/support/synthetic-serve-sim.mjs` is a separate process that serves
an HTML page, a live MJPEG stream made by FFmpeg (`testsrc2`, 390×844) and the
`/ws` input socket, the same three things serve-sim serves.

## Local suites (Linux, macOS, Windows)

| Suite | Command | What it proves |
|---|---|---|
| `test/e2e/cli.e2e.test.mjs` | `npm run test:cli` | The real binary: help, version, "did you mean", flag errors with fixes and exit codes, preflight stops `up` before touching anything, `doctor` on real projects and repos (missing gh, detached HEAD, dirty tree, no ios/), `upload`/`r2`/`turn` errors, `benchmark --local` with the runner's real encoder |
| `test/e2e/scaffold.e2e.test.mjs` | `npm run test:cli` | `init` writes every runner file with a hashed header; re-run is a no-op; edits are kept until `--force`; 0.1.x files upgrade; stale files removed; a real `core.autocrlf=true` checkout is not seen as edits; the scaffolded gate runs from the app repo |
| `test/e2e/gate.e2e.test.mjs` | `npm run test:gate` | gate + peer + synthetic serve-sim: health, 403 without token, `?k=` → HttpOnly cookie, script injection, served client parses, ICE config, MJPEG through the gate, WebSocket upgrades to serve-sim and peer (the Connection: Upgrade fix), metrics, v1 mode, refusing to start without a token |
| `test/e2e/stream.e2e.test.mjs` | `npm run test:stream` | headless **Google Chrome** opens the gate link: H.264 video arrives (codec checked in `getStats`), 390×844, not black, keeps moving, negotiated from the offer, tap and key reach serve-sim, reload reconnects, two viewers at once |

`npm test` runs all four (about 25 s). The stream suite needs Google Chrome
(`channel: chrome`; set `FLUTTER_REMOTE_E2E_CHROME=/path/to/chrome` to use
another build) and FFmpeg (installed with `ffmpeg-static`).

Proof that these tests catch the real bugs: with the pre-fix `PeerSession.cjs`
the stream suite fails with a black screen; without the `Connection: Upgrade`
line in the gate, both WebSocket tests fail.

## Runner suite (macOS runner, real iOS Simulator)

`test/runner/runner.e2e.test.mjs`, run by `.github/workflows/e2e-runner.yml`
(manual: Actions → "e2e (macOS runner)" → Run workflow). It creates a Flutter app
from `test/runner/fixture/main.dart` (a green screen that turns yellow on tap),
runs the real `flutter-remote up --public`, opens the printed link in Chrome,
waits for the green app, taps in the browser, and waits for yellow in the
Simulator. Then `flutter-remote down --all`.

Needs a repository secret `FLUTTER_REMOTE_E2E_TOKEN` (a GitHub token with `repo`
and `workflow` scopes). The fixture repository is public, so its macOS minutes
are free.
