# flutter-remote WebRTC Implementation Plan

## Goal

Eliminate the 1–2 second tap/keyboard input lag by replacing the
`Browser → Cloudflare → gate.cjs proxy → serve-sim /ws → Simulator`
round-trip with a direct WebRTC DataChannel connection that bypasses
the Cloudflare HTTP proxy entirely.

**Video streaming stays as MJPEG** (stable on virtualized runners, zero black-screen drops).
Only **HID input** (taps, keyboard, scroll) moves to WebRTC DataChannel.

```
Before (every tap):
  Browser → Cloudflare (~80ms) → gate.cjs → serve-sim /ws → Simulator
  Total: ~200–400ms round-trip

After (every tap):
  Browser → WebRTC DataChannel (UDP / Cloudflare TURN) → webrtc-peer.cjs → serve-sim /ws → Simulator
  Total: ~30–80ms round-trip
```

---

## Prerequisites

1. Run `flutter-remote turn --key-id <id> --key-token <token>` once.
   This stores two GitHub Secrets in the repository:
   - `FLUTTER_REMOTE_TURN_KEY_ID`
   - `FLUTTER_REMOTE_TURN_KEY_TOKEN`
   These are used by `gate.cjs` to fetch ephemeral Cloudflare Realtime TURN credentials via the Cloudflare Calls REST API.

2. If `flutter-remote turn` has NOT been run, the system falls back gracefully to:
   - Free STUN (`stun:stun.cloudflare.com:3478`) for direct P2P attempts.
   - Standard WebSocket over HTTP proxy if WebRTC does not connect.
   - **Zero breakage — fully backward compatible.**

---

## Architecture & Data Flow

```
+-------------------------------------------------------------------------+
|                                BROWSER                                  |
|                                                                         |
|   +-----------------------------------------------------------------+   |
|   |  serve-sim frontend (React)                                     |   |
|   |  Touch / Mouse / Keyboard Events                                |   |
|   +-----------------------------------------------------------------+   |
|            |                                                            |
|     (monkey-patched WebSocket)                                          |
|            |                                                            |
|       [rtcReady?]                                                       |
|       /         \                                                       |
|   (YES)         (NO / connecting / fallback)                            |
|     |                     |                                             |
|  WebRTC DataChannel   HTTP WebSocket (/ws)                              |
+-----|---------------------|---------------------------------------------+
      | (UDP direct/TURN)   | (TCP / Cloudflare)
      |                     |
+-----|---------------------|---------------------------------------------+
      |                     |
      |             +-------v-------+
      |             |   gate.cjs    | (Port 3199)
      |             |  auth & proxy |
      |             +-------+-------+
      |                     |
+-----v---------------------|---------------------------------------------+
|  MACOS RUNNER             |                                             |
|                           |                                             |
|  +--------------------+   |                                             |
|  |  webrtc-peer.cjs   |   |                                             |
|  |  (Port 3201)       |   |                                             |
|  +---------+----------+   |                                             |
|            |              |                                             |
|      (local loopback)     |                                             |
|            |              |                                             |
|            +-------> +----v----+                                        |
|                      |serve-sim| (Port 3200)                            |
|                      +----+----+                                        |
|                           |                                             |
|                      +----v----+                                        |
|                      |Simulator|                                        |
|                      +---------+                                        |
+-------------------------------------------------------------------------+
```

---

## Files Implemented

```
templates/
  gate.cjs               [MODIFIED]  Added /ice-config (Calls REST API), /signal route, HTML <head> injection
  webrtc-peer.cjs        [CREATED]   Server-side DataChannel bridge using node-datachannel + ws
  flutter-remote.yml     [MODIFIED]  Added TURN secrets env, install node-datachannel & ws, start webrtc-peer

src/commands/
  init.js                [MODIFIED]  Scaffolds webrtc-peer.cjs alongside gate.cjs
  turn.js                [MODIFIED]  Configures Cloudflare Realtime TURN credentials

test/
  webrtc.test.js         [CREATED]   Unit tests for webrtc-peer, gate routes, and script injection
  workflow.test.js       [MODIFIED]  Template version 12 assertions
```

---

## Key Technical Specifications

### 1. Cloudflare Calls Realtime TURN Credentials
Cloudflare Calls TURN (`turn.cloudflare.com`) requires calling the REST API to generate ephemeral ICE servers:
```http
POST https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers
Authorization: Bearer ${keyToken}
Content-Type: application/json

{"ttl": 86400}
```
`gate.cjs` fetches this once per session, caches it in memory, and serves it to the browser via `GET /ice-config`.

### 2. Node.js Global Module Resolution
When `npm install -g node-datachannel ws` is run on the runner:
- `NODE_PATH="$(npm root -g)"` is exported before running `webrtc-peer.cjs` so `require('node-datachannel')` and `require('ws')` resolve properly.

### 3. Early Script Injection in `<head>`
`gate.cjs` intercepts `GET /` and injects:
```html
<script src="/__flutter-remote/webrtc-hid.js"></script>
```
immediately after `<head>`. This guarantees `window.WebSocket` is monkey-patched before `serve-sim` client bundles initialize.

### 4. Warmup & Zero-Latency Fallback
`webrtc-hid.js` maintains the original WebSocket connection active. While WebRTC ICE negotiation is in progress (first 200–500ms), all HID messages are routed through the original WebSocket. Once `dataChannel.readyState === 'open'`, it switches immediately to WebRTC. If WebRTC fails, it stays on WebSocket with zero interruption.
