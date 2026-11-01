# Testing

Every test is end-to-end: it starts real processes and talks to them over real
sockets. There are no mocks or stubs of flutter-remote code.

The one stand-in is **serve-sim**, because the iOS Simulator exists only on
macOS: `test/support/synthetic-serve-sim.mjs` is a separate process that serves
what serve-sim 0.1.48 serves: a preview page shaped like serve-sim's UI (fills the
window, no `#flutter-remote-container`, its own device view that sends taps and
keys), a live MJPEG stream made by FFmpeg (`testsrc2`, 390×844) at
`/helper/<udid>/stream.mjpeg`, and the input socket at `/helper/<udid>/ws` that
takes serve-sim's binary frames and refuses a bare `/ws`, as the real one does.
An earlier stand-in accepted JSON on `/ws` and had a container div, so the suite
passed while taps never reached a real Simulator (fixed in 0.2.3).

## Local suites (Linux, macOS, Windows)

| Suite | Command | What it proves |
|---|---|---|
| `test/e2e/cli.e2e.test.mjs` | `npm run test:cli` | The real binary: help, version, "did you mean", flag errors with fixes and exit codes, preflight stops `up` before touching anything, `doctor` on real projects and repos (missing gh, detached HEAD, dirty tree, no ios/), `upload`/`r2`/`turn` errors, `benchmark --local` with the runner's real encoder |
| `test/e2e/scaffold.e2e.test.mjs` | `npm run test:cli` | `init` writes every runner file with a hashed header; re-run is a no-op; edits are kept until `--force`; 0.1.x files upgrade; stale files removed; a real `core.autocrlf=true` checkout is not seen as edits; the scaffolded gate runs from the app repo |
| `test/e2e/gate.e2e.test.mjs` | `npm run test:gate` | gate + peer + synthetic serve-sim: health, 403 without token, `?k=` → HttpOnly cookie, script injection, served client parses, ICE config, MJPEG through the gate, WebSocket upgrades to serve-sim and peer (the Connection: Upgrade fix), metrics, v1 mode, refusing to start without a token |
| `test/e2e/stream.e2e.test.mjs` | `npm run test:stream` | headless **Google Chrome** opens the gate link: on serve-sim's own UI no overlay covers the phone and its own tap reaches serve-sim; with `?player=webrtc` H.264 video arrives (codec checked in `getStats`), 390×844, not black, keeps moving, negotiated from the offer, tap, key and scroll reach serve-sim as serve-sim's frames (a key exactly once), reload reconnects, two viewers at once |

| `test/e2e/real-serve-sim-ui.e2e.test.mjs` | `FLUTTER_REMOTE_REAL_SERVE_SIM=1 npm run test:real-ui` (opt-in, downloads serve-sim from npm; `=0.1.49` picks a version) | serve-sim's **real** preview UI (its own React viewer, taken from its npm package) behind the real gate and peer: a click on its phone and a key reach serve-sim as its own frames; with `?player=webrtc` a tap and a key reach it exactly once. Fails on 0.2.2 (the overlay takes the click). |

`npm test` runs the first four (about 25 s). The stream suite needs Google Chrome
(`channel: chrome`; set `FLUTTER_REMOTE_E2E_CHROME=/path/to/chrome` to use
another build) and FFmpeg (installed with `ffmpeg-static`).

Proof that these tests catch the real bugs: with the pre-fix `PeerSession.cjs`
the stream suite fails with a black screen; without the `Connection: Upgrade`
line in the gate, both WebSocket tests fail; with the 0.2.2 client and
`ServeSimConsumer.cjs`, the serve-sim UI tap test and the player tap and scroll
tests fail.

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
