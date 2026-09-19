# Flutter Remote — WebRTC V2

## Full Architecture Rewrite & Production-Grade Implementation Specification

> **Status:** Architecture Rewrite
> **Priority:** Critical
> **Goal:** Replace the current streaming/control architecture with a production-grade, low-latency, resilient remote iOS Simulator platform.

---

# 1. Objective

Rebuild the internal architecture of `flutter_remote` so that a user can run:

```bash
flutter-remote up --public
```

and get a highly responsive browser-based iOS Simulator session.

The system must prioritize:

1. Very low interaction latency.
2. Smooth video streaming.
3. Reliable touch / drag / scroll / keyboard input.
4. Automatic WebRTC reconnection.
5. TURN fallback.
6. Network-loss recovery.
7. Clean session lifecycle.
8. No unnecessary browser WebSockets.
9. No blocking relationship between video and input.
10. Observable latency and connection health.
11. Compatibility with GitHub Actions macOS runners.
12. Clean separation between signaling, transport, media, input, authentication and session management.
13. Backward-compatible CLI behavior wherever practical.
14. No dependency on the current implementation architecture.

The implementation may completely restructure:

```text
gate.cjs
webrtc-peer.cjs
workflow
browser client
signaling
session lifecycle
transport
video pipeline
input pipeline
```

Do NOT preserve bad architecture merely for compatibility.

---

# 2. Core Architecture

The new architecture must use separate planes.

```text
                         ┌─────────────────────────┐
                         │         Browser         │
                         │                         │
                         │  React/Vanilla Client   │
                         │                         │
                         │ ┌────────┐ ┌─────────┐ │
                         │ │ Video  │ │  Input  │ │
                         │ │ Engine │ │  Engine │ │
                         │ └───┬────┘ └────┬────┘ │
                         └─────┼────────────┼──────┘
                               │            │
                         WebRTC Media   WebRTC Data
                               │            │
                               ▼            ▼
                    ┌──────────────────────────┐
                    │     WebRTC Gateway       │
                    │                          │
                    │ Session Manager           │
                    │ Peer Manager              │
                    │ ICE Manager               │
                    │ DataChannel Manager        │
                    │ Metrics                   │
                    └────────────┬─────────────┘
                                 │
                    localhost / Unix socket
                                 │
                                 ▼
                    ┌──────────────────────────┐
                    │       Simulator Host     │
                    │       macOS Runner       │
                    │                          │
                    │ serve-sim / capture       │
                    │ Simulator                 │
                    └──────────────────────────┘
```

---

# 3. Separate the System Into Planes

The implementation MUST logically separate these systems.

## 3.1 Signaling Plane

Responsible only for:

* session authentication
* WebRTC offer
* WebRTC answer
* ICE candidates
* connection state
* reconnect negotiation

It must NOT transport:

* touch events
* keyboard events
* video frames
* simulator control data

Signaling may use HTTPS/WebSocket.

---

# 3.2 Control Plane

WebRTC DataChannels.

Responsible for:

* touch
* mouse
* drag
* scroll
* keyboard
* text input
* special keys
* orientation
* optional simulator commands
* heartbeat

No control event should depend on the video pipeline.

---

# 3.3 Media Plane

WebRTC video.

Responsible only for:

* simulator frames
* frame timing
* bitrate
* resolution
* FPS
* adaptive quality

Input must NEVER wait for media.

---

# 3.4 Session Plane

Responsible for:

* session creation
* session ID
* authentication
* lifecycle
* timeout
* cleanup
* runner termination
* reconnect
* metrics

---

# 3.5 Observability Plane

Responsible for:

* RTT
* ICE state
* packet loss
* bitrate
* FPS
* dropped frames
* input latency
* reconnect count
* TURN usage
* browser CPU
* server CPU
* memory

---

# 4. New Internal Project Structure

Do not continue with a flat architecture.

Use a structure similar to:

```text
src/
├── cli/
│   ├── commands/
│   ├── prompts/
│   └── config/
│
├── session/
│   ├── SessionManager.js
│   ├── SessionState.js
│   ├── SessionStore.js
│   └── SessionLifecycle.js
│
├── signaling/
│   ├── SignalingServer.js
│   ├── SignalingClient.js
│   ├── OfferHandler.js
│   ├── IceHandler.js
│   └── SignalingProtocol.js
│
├── webrtc/
│   ├── PeerManager.js
│   ├── PeerConnection.js
│   ├── IceManager.js
│   ├── TurnManager.js
│   ├── DataChannelManager.js
│   ├── MediaManager.js
│   └── WebRTCState.js
│
├── input/
│   ├── InputRouter.js
│   ├── TouchController.js
│   ├── MouseController.js
│   ├── KeyboardController.js
│   ├── ScrollController.js
│   └── InputProtocol.js
│
├── simulator/
│   ├── SimulatorManager.js
│   ├── SimulatorInputBridge.js
│   ├── SimulatorCapture.js
│   └── ServeSimAdapter.js
│
├── gateway/
│   ├── GatewayServer.js
│   ├── AuthMiddleware.js
│   ├── RateLimiter.js
│   └── HealthController.js
│
├── media/
│   ├── CapturePipeline.js
│   ├── VideoEncoder.js
│   ├── FrameController.js
│   └── AdaptiveBitrate.js
│
├── metrics/
│   ├── MetricsCollector.js
│   ├── LatencyTracker.js
│   ├── WebRTCMetrics.js
│   └── SessionMetrics.js
│
└── shared/
    ├── constants.js
    ├── errors.js
    ├── logger.js
    ├── validation.js
    └── utils.js
```

Browser:

```text
client/
├── src/
│   ├── app/
│   ├── session/
│   ├── webrtc/
│   ├── video/
│   ├── input/
│   ├── ui/
│   ├── metrics/
│   └── utils/
│
└── public/
```

---

# 5. WebRTC Architecture

Use a single `RTCPeerConnection` per browser session.

Recommended structure:

```text
RTCPeerConnection
│
├── video transceiver
│
├── DataChannel: input
│
├── DataChannel: control
│
└── DataChannel: telemetry
```

Do NOT create a new PeerConnection for every reconnect attempt without properly closing the previous one.

---

# 6. DataChannels

Use different channels for different semantics.

## 6.1 Input Channel

```text
input
```

For:

* touch
* pointer
* drag
* scroll

Properties:

```js
{
  ordered: false,
  maxRetransmits: 0
}
```

Reason:

Old pointer events have no value.

If:

```text
move #100
move #101
move #102
```

and #100 is delayed, do not block #101 and #102.

---

# 6.2 Keyboard Channel

```text
keyboard
```

Reliable:

```js
{
  ordered: true
}
```

Keyboard events must preserve order.

---

# 6.3 Control Channel

```text
control
```

Reliable and ordered.

Used for:

* session commands
* orientation
* resize
* quality requests
* reconnect
* client capabilities

---

# 6.4 Telemetry Channel

```text
telemetry
```

Low priority.

Used for:

* ping
* RTT
* statistics
* client performance

---

# 7. Input Protocol

Use a versioned binary-friendly protocol.

Every event must contain:

```json
{
  "v": 2,
  "type": "pointer",
  "seq": 10291,
  "ts": 1726730000123,
  "event": "down",
  "pointerId": 1,
  "x": 0.45,
  "y": 0.62"
}
```

Coordinates MUST be normalized:

```text
x = 0.0 → 1.0
y = 0.0 → 1.0
```

This prevents dependency on browser resolution.

---

# 8. Pointer Events

Support:

```text
pointerdown
pointermove
pointerup
pointercancel
```

For iOS simulator:

```text
touch
drag
swipe
long press
multi-touch where possible
```

Use Pointer Events in browser rather than relying only on mouse events.

---

# 9. Pointer Move Optimization

Never send every browser `pointermove` blindly.

Use:

```text
requestAnimationFrame
```

and coalescing.

Example:

```text
Browser produces:

1000 pointermove events/sec

↓

Input engine

↓

coalesce

↓

60–120 meaningful events/sec

↓

WebRTC
```

Never queue an unlimited input backlog.

---

# 10. Backpressure

Every DataChannel must monitor:

```js
bufferedAmount
```

Configure:

```js
bufferedAmountLowThreshold
```

For pointer events:

If the channel is congested:

```text
DROP OLD MOVE EVENTS
```

Never block the UI waiting for WebRTC.

---

# 11. Keyboard Input

Support:

```text
keydown
keyup
input
compositionstart
compositionupdate
compositionend
```

Do not depend exclusively on `keydown`.

Text input should support:

```text
Arabic
English
Chinese
emoji
paste
IME
```

where simulator tooling permits.

---

# 12. Clipboard

Add optional clipboard synchronization.

Browser:

```text
paste
```

↓

Control channel

↓

Simulator bridge

Use explicit permission and never silently read clipboard contents.

Only transfer clipboard contents after a user action.

---

# 13. Video Architecture

The video path must be independent of input.

Preferred architecture:

```text
Simulator
   ↓
Capture
   ↓
Video encoder
   ↓
WebRTC video track
   ↓
Browser <video>
```

Do NOT use:

```text
MJPEG → browser → canvas
```

as the primary production path.

MJPEG remains fallback only.

---

# 14. WebRTC Video

Prefer hardware/video acceleration available on the runner.

Primary codec:

```text
H264
```

Fallback:

```text
VP8
```

Only use codecs actually supported by the runtime.

The implementation must detect codec availability rather than assuming it.

---

# 15. Adaptive Video Quality

Do not hardcode:

```text
720p @ 20 FPS
```

as the only configuration.

Start around:

```text
720p
30 FPS
```

and dynamically adapt.

Possible levels:

```text
LOW
MEDIUM
HIGH
```

Example:

```text
LOW:
480p / 15 FPS

MEDIUM:
720p / 24 FPS

HIGH:
1080p / 30 FPS
```

Adapt based on:

* RTT
* packet loss
* available bitrate
* frame drops
* browser performance

---

# 16. Do Not Adapt Input Based on Video

Important:

Video degradation must NEVER disable input.

If:

```text
video packet loss = high
```

input remains active.

---

# 17. WebRTC Connection State Machine

Implement explicit states:

```text
IDLE
CONNECTING
SIGNALING
CHECKING
CONNECTED
DEGRADED
RECONNECTING
FAILED
CLOSED
```

Transitions must be deterministic.

---

# 18. Connection Failure Detection

Monitor:

```js
connectionState
iceConnectionState
iceGatheringState
signalingState
```

Also implement application-level heartbeat.

Example:

```text
ping
 ↓
pong
```

every:

```text
2 seconds
```

Timeout:

```text
6 seconds
```

Then mark connection degraded.

---

# 19. Automatic Reconnection

When connection fails:

```text
CONNECTED
   ↓
FAILED
   ↓
RECONNECTING
   ↓
new PeerConnection
   ↓
new offer
   ↓
new ICE negotiation
   ↓
CONNECTED
```

Use exponential backoff:

```text
500ms
1s
2s
4s
8s
max 10s
```

Reset backoff after stable connection.

---

# 20. ICE Servers

Support:

```text
STUN
TURN UDP
TURN TCP
TURN TLS
```

Priority:

```text
host
srflx
relay
```

But never assume host candidates work from the browser.

---

# 21. TURN

TURN must be supported as a first-class transport.

Configuration:

```text
TURN_URL
TURN_USERNAME
TURN_CREDENTIAL
```

Prefer temporary credentials.

Do not hardcode credentials into frontend source.

---

# 22. TURN Security

Never expose a permanent TURN secret to the browser.

Use:

```text
time-limited credentials
```

generated server-side.

Example concept:

```text
timestamp
+
shared secret
→ temporary username/password
```

---

# 23. ICE Restart

If:

```text
ICE disconnected
```

try ICE restart before destroying the entire session.

If that fails:

```text
new PeerConnection
```

---

# 24. Signaling Protocol

Use explicit message types.

```json
{
  "type": "offer",
  "sessionId": "...",
  "generation": 3,
  "payload": {}
}
```

Supported:

```text
hello
offer
answer
ice-candidate
ice-complete
restart
connected
disconnect
error
ping
pong
```

Every message should include:

```text
version
sessionId
generation
timestamp
```

---

# 25. Signaling Generations

Every PeerConnection generation gets:

```text
generation = 1
generation = 2
generation = 3
...
```

Ignore stale signaling messages.

Example:

```text
generation 4 active

incoming generation 2

→ ignore
```

This prevents race conditions during reconnects.

---

# 26. Authentication Gate

The gate should authenticate:

```text
session ID
token
expiry
```

before allowing signaling.

Never rely on obscurity of the session URL.

---

# 27. Session Token

Use cryptographically random tokens.

Minimum:

```text
32 bytes
```

encoded safely.

Tokens must:

* expire
* be single-session
* be rotated on reconnect where appropriate
* never appear in logs

---

# 28. Remove WebSocket Input Fallback During Normal Operation

Current architecture uses WebSocket and then redirects `send()` into WebRTC.

Remove this pattern.

Do NOT:

```js
ws.send = ...
```

or monkey-patch WebSocket methods.

Instead:

```text
Browser Input Engine
        ↓
WebRTC InputChannel
        ↓
WebRTC Gateway
        ↓
Simulator Input Adapter
```

---

# 29. WebSocket Fallback

WebSocket may exist only as an explicit fallback transport.

Architecture:

```text
WebRTC available
    ↓
use WebRTC

WebRTC unavailable
    ↓
fallback to WebSocket
```

The transport must be represented by an interface:

```ts
interface InputTransport {
  connect(): Promise<void>
  send(event): void
  close(): void
  isConnected(): boolean
}
```

Implement:

```text
WebRTCInputTransport
WebSocketInputTransport
```

---

# 30. Transport Selection

Use:

```text
TransportManager
```

Logic:

```text
try WebRTC
 ↓
timeout
 ↓
fallback WebSocket
```

Do not use both simultaneously for the same input stream.

---

# 31. Simulator Adapter

Do not let WebRTC code know anything about `serve-sim`.

Create:

```text
SimulatorInputAdapter
```

Interface:

```ts
interface SimulatorInputAdapter {
  pointer(event): Promise<void>
  keyboard(event): Promise<void>
  clipboard(text): Promise<void>
}
```

Then implement:

```text
ServeSimInputAdapter
```

This makes replacing `serve-sim` later possible without rewriting WebRTC.

---

# 32. serve-sim Integration

`serve-sim` should be treated as an external simulator adapter.

Never spread `serve-sim` assumptions throughout the code.

Only one module should know:

```text
/ws
capture protocol
input protocol
ports
```

---

# 33. Local IPC

Prefer:

```text
localhost
```

or Unix domain sockets where practical.

Do not expose internal simulator endpoints publicly.

Public exposure should be:

```text
Gateway only
```

---

# 34. Cloudflare Tunnel

Cloudflare Tunnel should expose only:

```text
HTTPS/WSS gateway
```

Do not expose:

```text
serve-sim
simulator websocket
internal peer port
```

---

# 35. Tunnel Independence

WebRTC media should not depend on the Cloudflare tunnel after signaling if direct ICE connectivity is established.

The tunnel is primarily:

```text
authentication
signaling
fallback
```

not the permanent media transport.

---

# 36. Critical Architectural Goal

Current:

```text
Browser
 ↓
Cloudflare
 ↓
Gate
 ↓
MJPEG / WebSocket
 ↓
serve-sim
 ↓
Simulator
```

Target:

```text
Browser
 │
 ├──────── HTTPS/WSS ────────► Signaling Gateway
 │
 └──────── WebRTC ───────────► Simulator WebRTC Gateway
                                │
                                ▼
                             Simulator
```

This removes unnecessary hops from the realtime path.

---

# 37. Session Lifecycle

Implement:

```text
CREATING
BOOTING_SIMULATOR
STARTING_CAPTURE
STARTING_GATEWAY
STARTING_TUNNEL
READY
ACTIVE
DEGRADED
RECONNECTING
STOPPING
STOPPED
FAILED
```

---

# 38. Startup Sequence

Correct order:

```text
1. Create session
2. Generate credentials
3. Boot simulator
4. Wait for simulator readiness
5. Start capture
6. Start simulator adapter
7. Start WebRTC gateway
8. Start signaling
9. Start tunnel
10. Publish session URL
11. Browser connects
12. WebRTC negotiation
13. Video starts
14. Input enabled
15. Session READY
```

Do not expose READY before WebRTC is actually usable.

---

# 39. Browser Startup

Browser should show:

```text
Connecting...
```

then:

```text
Simulator starting...
```

then:

```text
Establishing secure connection...
```

then:

```text
Connected
```

Input should only become active after:

```text
WebRTC DataChannel = OPEN
video track = LIVE
```

---

# 40. First Frame Optimization

First frame should arrive as soon as possible.

Do not wait for:

* full metrics initialization
* optional services
* non-critical UI
* analytics
* debug logs

Critical path only:

```text
WebRTC
Video
Input
```

---

# 41. Video Element

Use:

```html
<video autoplay playsinline></video>
```

Avoid unnecessary canvas rendering.

If canvas is required for scaling/input coordinates, use it only for input overlay.

Preferred:

```text
video element
+
transparent input layer
```

---

# 42. Input Coordinate Mapping

Input overlay must calculate:

```text
browser coordinate
→ displayed video coordinate
→ source video coordinate
→ normalized simulator coordinate
```

Correctly handle:

* aspect ratio
* letterboxing
* fit
* device rotation
* browser resize

---

# 43. Orientation

Support:

```text
portrait
landscape
```

Orientation changes must trigger:

```text
video resize
input coordinate recalculation
```

without reconnecting WebRTC.

---

# 44. Resize

Do not recreate the PeerConnection when browser dimensions change.

Only update:

```text
preferred video dimensions
```

---

# 45. Metrics

Expose a debug panel:

```text
Connection: Connected
ICE: Connected
Transport: WebRTC
Candidate: relay
RTT: 82ms
FPS: 29
Bitrate: 2.4 Mbps
Packet Loss: 0.4%
Input RTT: 31ms
Frames Dropped: 3
Reconnects: 0
```

Allow hiding the panel in production.

---

# 46. Input Latency Measurement

Every input event:

```text
client timestamp
server receive timestamp
simulator send timestamp
```

Measure:

```text
client → server
server → simulator
```

For visual latency:

```text
input timestamp
→ next frame timestamp
```

Track:

```text
P50
P95
P99
```

---

# 47. Logging

Use structured logs.

Example:

```json
{
  "level": "info",
  "event": "webrtc.connected",
  "sessionId": "...",
  "generation": 3,
  "ice": "connected",
  "timestamp": 1726730000000
}
```

Never log:

* tokens
* TURN passwords
* cookies
* clipboard contents
* user secrets

---

# 48. Log Levels

Support:

```text
ERROR
WARN
INFO
DEBUG
TRACE
```

Default:

```text
INFO
```

Debug mode:

```text
DEBUG
```

Trace should be opt-in.

---

# 49. Health Endpoints

Implement:

```text
/healthz
/readyz
/metrics
```

Health:

```text
process alive
```

Ready:

```text
gateway usable
```

Metrics:

```text
Prometheus-compatible if practical
```

---

# 50. Internal Health

Track:

```text
simulator
serve-sim
webrtc
signaling
capture
tunnel
```

A session is not healthy if any critical dependency fails.

---

# 51. Resource Monitoring

Track:

```text
CPU
RAM
GPU where available
network
```

Especially important on GitHub-hosted macOS runners.

Warn when:

```text
RAM > 80%
CPU > 85%
```

Critical:

```text
RAM > 90%
```

---

# 52. Backpressure Everywhere

Never allow unlimited queues.

Every queue needs:

```text
max size
drop policy
timeout
```

For input:

```text
drop old pointer moves
```

For keyboard:

```text
preserve order
```

For video:

```text
drop stale frames
```

---

# 53. Frame Queue

Never allow:

```text
frame 1
frame 2
frame 3
...
frame 500
```

to accumulate.

If the browser cannot consume frames:

```text
drop stale frames
```

Always prioritize:

```text
latest frame
```

for interactive simulator streaming.

---

# 54. Error Handling

Every subsystem must use typed errors:

```text
SessionError
SignalingError
WebRTCError
SimulatorError
CaptureError
TransportError
AuthenticationError
TunnelError
```

Do not silently swallow errors.

Avoid:

```js
catch (_) {}
```

unless explicitly documented.

---

# 55. Cleanup

On any session termination:

```text
1. Stop input
2. Close DataChannels
3. Close PeerConnection
4. Stop capture
5. Stop serve-sim
6. Stop simulator
7. Stop tunnel
8. Close signaling
9. Remove temporary files
10. Clear session memory
```

Cleanup must be idempotent.

Calling:

```text
cleanup()
cleanup()
cleanup()
```

must be safe.

---

# 56. Signal Handling

Handle:

```text
SIGINT
SIGTERM
SIGHUP
```

Gracefully.

GitHub Actions cancellation must not leave:

* simulator
* Node process
* cloudflared
* serve-sim
* WebRTC peer

running.

---

# 57. Browser Reconnect

If browser refreshes:

```text
old browser connection
```

should not kill simulator session immediately.

Allow a grace period:

```text
30–60 seconds
```

Then reclaim the session.

---

# 58. Session Reattachment

Support:

```text
sessionId
+
reconnect token
```

Browser can reconnect to an existing simulator without restarting Flutter.

This is important for:

* browser refresh
* network switch
* temporary Wi-Fi failure
* tab crash

---

# 59. Multiple Browser Connections

By default:

```text
1 active controller
```

Optional future:

```text
1 viewer
+
1 controller
```

Do not allow two controllers to send input simultaneously unless explicitly implemented.

---

# 60. Security

Implement:

```text
Origin validation
CSRF protection where relevant
Rate limiting
Token expiration
Session isolation
Input validation
Message size limits
```

Reject malformed WebRTC signaling.

---

# 61. Message Size Limits

Set hard limits.

Example:

```text
signaling message: 1 MB
input event: 16 KB
clipboard: configurable reasonable limit
```

Never accept unlimited payloads.

---

# 62. Rate Limiting

Per session:

```text
signaling
input
clipboard
control
```

must have limits.

Do not rate-limit normal pointer interaction so aggressively that dragging becomes broken.

Use adaptive/coalescing rather than simply rejecting valid input.

---

# 63. Dependency Strategy

Do not use:

```text
@latest
```

in production workflow dependencies.

Pin important dependencies:

```text
serve-sim
node-datachannel
ws
cloudflared
Node
Flutter
```

Use Renovate/Dependabot later if desired.

---

# 64. GitHub Actions

The workflow should be simplified.

Separate:

```text
prepare
simulator
capture
gateway
tunnel
build
run
cleanup
```

Avoid one massive shell script when a reusable script/module can perform the work.

---

# 65. Workflow Environment

Use explicit environment variables:

```text
SESSION_ID
SESSION_TOKEN
SIMULATOR_UDID
GATEWAY_PORT
SIGNALING_PORT
MEDIA_PORT
INPUT_PORT
```

Do not hardcode internal ports in multiple files.

Centralize configuration.

---

# 66. Configuration

Create:

```text
src/config/
```

with:

```js
DEFAULT_CONFIG
ENV_CONFIG
SESSION_CONFIG
WEBRTC_CONFIG
MEDIA_CONFIG
```

Configuration priority:

```text
CLI
>
environment
>
config file
>
defaults
```

---

# 67. Browser Client Build

Do not make the browser depend on Node-only APIs.

Keep browser code clean:

```text
WebRTC
DOM
Pointer Events
Keyboard Events
Fetch
WebSocket signaling
```

---

# 68. Browser State Management

Use a simple explicit state machine.

Do not introduce a huge framework unless necessary.

State:

```text
session
connection
video
input
metrics
errors
```

must be separated.

---

# 69. UI States

Must support:

```text
Loading
Connecting
Connected
Degraded
Reconnecting
Disconnected
Session Expired
Session Error
```

---

# 70. Error Recovery UX

Example:

```text
Connection lost.

Reconnecting...
Attempt 2/5
```

If recovery succeeds:

```text
Connection restored.
```

Do not reload the entire browser page.

---

# 71. Performance Requirements

Target:

```text
Input P50 < 50ms
Input P95 < 100ms
```

when network conditions allow.

Target:

```text
30 FPS
```

under normal runner conditions.

Video should degrade gracefully under poor networks.

---

# 72. Network Quality Levels

Detect:

```text
EXCELLENT
GOOD
FAIR
POOR
```

based on measured metrics.

Do not infer quality only from ping.

Use:

```text
RTT
packet loss
jitter
bitrate
frames dropped
```

---

# 73. Poor Network Behavior

If network deteriorates:

```text
1. Keep input alive
2. Reduce video bitrate
3. Reduce FPS
4. Reduce resolution
5. Maintain session
```

Do not immediately reconnect.

---

# 74. Severe Network Failure

If WebRTC fails:

```text
ICE restart
```

then:

```text
PeerConnection recreation
```

then:

```text
signaling reconnect
```

Only after those fail:

```text
fallback transport
```

---

# 75. Browser Visibility

If browser tab becomes hidden:

Do not automatically destroy session.

Optionally reduce video quality if desired.

When tab becomes visible:

```text
restore quality
```

---

# 76. Mobile Browser

The browser client should work on:

```text
Chrome
Safari
Edge
Firefox
```

where WebRTC APIs permit.

Touch must be first-class.

---

# 77. Desktop Browser

Support:

```text
mouse
trackpad
keyboard
wheel
```

---

# 78. Scroll

Normalize wheel input.

Support:

```text
wheel
trackpad
touch swipe
```

Do not send thousands of wheel events.

Coalesce them.

---

# 79. Drag

Dragging must not suffer from pointer event loss.

Use:

```text
pointer capture
```

during active drag.

Example:

```js
element.setPointerCapture(pointerId)
```

Release on:

```text
pointerup
pointercancel
```

---

# 80. Multi-Touch

Design the protocol so it supports:

```text
pointerId
```

from day one.

Do not hardcode one pointer.

---

# 81. Browser Refresh Recovery

When refreshing:

```text
local session metadata
```

can be retained temporarily.

Attempt session reattachment.

---

# 82. Testing Strategy

Create real integration tests.

Not just:

```text
file exists
string exists
port opens
```

Test behavior.

---

# 83. Unit Tests

Test:

```text
InputProtocol
CoordinateMapper
SessionStateMachine
ReconnectBackoff
TransportManager
InputCoalescer
Token validation
Message validation
```

---

# 84. WebRTC Tests

Test:

```text
offer/answer
ICE candidate exchange
DataChannel open
DataChannel reconnect
ICE restart
TURN relay
stale generation rejection
```

---

# 85. Input Integration Tests

Test:

```text
tap
double tap
drag
swipe
scroll
long press
keyboard
paste
orientation
multi-touch
```

---

# 86. Stress Tests

Generate:

```text
1000 pointer moves/sec
```

and verify:

```text
memory remains stable
queue remains bounded
latest event wins
```

---

# 87. Network Tests

Simulate:

```text
50ms latency
100ms latency
packet loss
jitter
temporary disconnect
Wi-Fi switch
```

The session should recover.

---

# 88. Memory Tests

Run:

```text
1 hour
```

session.

Verify:

```text
memory does not continuously increase
```

---

# 89. Long-Running Session

Test:

```text
30 min
1 hour
3 hours
```

where runner limits permit.

---

# 90. Reconnect Tests

Test:

```text
browser disconnect
browser refresh
network disconnect
network reconnect
ICE failure
TURN fallback
gateway restart
```

---

# 91. E2E Test

Final test:

```text
flutter-remote up --public
```

Then automatically:

```text
1. Open browser
2. Connect
3. Wait for first frame
4. Tap button
5. Verify app state changes
6. Drag
7. Scroll
8. Type text
9. Disconnect network
10. Reconnect
11. Continue interacting
```

---

# 92. Debug Diagnostics

Add:

```text
?debug=1
```

or equivalent.

Show:

```text
PeerConnection state
ICE state
ICE candidate type
RTT
bitrate
FPS
packet loss
input latency
reconnect count
```

---

# 93. Developer CLI

Add:

```bash
flutter-remote doctor
```

Output:

```text
Node ............... OK
Flutter ............ OK
Xcode .............. OK
Simulator .......... OK
serve-sim .......... OK
WebRTC ............. OK
TURN ................ OK
Cloudflare .......... OK
```

---

# 94. Debug Commands

Add:

```bash
flutter-remote doctor
flutter-remote status
flutter-remote logs
flutter-remote session inspect
```

Optional:

```bash
flutter-remote benchmark
```

---

# 95. Benchmark

Benchmark:

```text
first-frame latency
input RTT
video FPS
bitrate
CPU
RAM
```

Example:

```text
First frame: 1.82s
Input P50: 31ms
Input P95: 67ms
FPS: 29.7
Bitrate: 2.1 Mbps
Packet loss: 0.2%
```

---

# 96. Fallback Strategy

The system should degrade:

```text
WebRTC H264
   ↓
WebRTC VP8
   ↓
WebRTC lower quality
   ↓
WebSocket/MJPEG fallback
```

Never fail completely just because one codec is unavailable.

---

# 97. Architecture Rule

The implementation must follow:

```text
Transport ≠ Protocol
Protocol ≠ Simulator
Simulator ≠ Media
Media ≠ Input
Input ≠ Signaling
Session ≠ Connection
```

These boundaries are mandatory.

---

# 98. No Monkey Patching

Do not implement:

```js
ws.send = ...
```

Do not override:

```js
WebSocket.prototype
RTCPeerConnection.prototype
```

Do not monkey-patch third-party libraries.

---

# 99. No Hidden Global State

Avoid:

```js
let currentSocket
let currentPeer
let currentSession
```

as global mutable state.

Use:

```text
SessionManager
PeerManager
TransportManager
```

with explicit ownership.

---

# 100. Ownership Model

One session owns:

```text
Session
 ├── Simulator
 ├── Gateway
 ├── PeerConnection
 ├── InputTransport
 ├── MediaPipeline
 ├── Metrics
 └── CleanupController
```

When session dies, all children die.

---

# 101. Concurrency Safety

Protect against:

```text
double reconnect
double cleanup
stale ICE candidate
old socket
old peer
```

Use generation IDs and state transitions.

---

# 102. Race Condition Prevention

Never assume:

```text
event A always happens before event B
```

WebRTC is asynchronous.

Every handler must validate:

```text
sessionId
generation
state
```

before acting.

---

# 103. Timeouts

Every asynchronous operation needs a timeout.

Examples:

```text
simulator boot: 120s
serve-sim: 30s
signaling: 15s
WebRTC connection: 20s
TURN: 10s
first frame: 15s
```

---

# 104. AbortController

Use `AbortController` for operations that can be cancelled.

Especially:

```text
session startup
reconnect
shutdown
HTTP requests
```

---

# 105. Cleanup Guarantees

If startup fails halfway:

```text
simulator started
gateway started
tunnel failed
```

the system must automatically clean everything.

No orphan processes.

---

# 106. Process Management

Track child processes explicitly:

```text
PID
name
port
start time
```

On cleanup:

```text
SIGTERM
wait
SIGKILL if required
```

---

# 107. Port Management

Centralize port allocation.

Do not hardcode:

```text
3199
3200
3201
```

throughout the code.

Use:

```text
PortManager
```

---

# 108. Port Collision

If a port is busy:

```text
detect
log
select safe alternative
```

unless a fixed port is required by external integration.

---

# 109. Cloudflare Tunnel Improvements

Tunnel startup must:

```text
start
wait
verify
extract URL
publish status
```

If tunnel dies:

```text
detect
restart
update session URL if necessary
```

---

# 110. Do Not Trust Tunnel URL Alone

Before declaring session ready:

```text
HTTP health check
WebSocket signaling check
WebRTC gateway check
```

must pass.

---

# 111. Security Headers

Gateway should send appropriate:

```text
Content-Security-Policy
X-Content-Type-Options
Referrer-Policy
Permissions-Policy
```

Only allow required WebRTC/browser capabilities.

---

# 112. Permissions Policy

Only enable capabilities required for:

```text
camera if needed
microphone if needed
clipboard
```

Do not request unnecessary browser permissions.

---

# 113. Clipboard Security

Clipboard must be:

```text
user initiated
size limited
never logged
never persisted
```

---

# 114. Session Isolation

A user must never be able to:

```text
access another session
guess another session
send signaling to another session
```

Every request validates:

```text
session ID
token
```

---

# 115. Browser Token Handling

Avoid permanent token storage in:

```text
localStorage
```

where possible.

Prefer:

```text
memory
sessionStorage
short-lived tokens
```

depending on architecture.

---

# 116. API Versioning

Version the protocol:

```text
flutter-remote-protocol: 2
```

All messages include:

```json
{
  "version": 2
}
```

---

# 117. Backward Compatibility

CLI behavior should remain compatible:

```bash
flutter-remote up
flutter-remote up --public
```

Existing users should not need to understand WebRTC internals.

---

# 118. CLI Flags

Expose advanced configuration:

```bash
--transport webrtc
--codec auto
--fps 30
--max-dimension 720
--turn
--debug
```

But sensible defaults must work without flags.

---

# 119. Defaults

Recommended defaults:

```text
transport = webrtc
codec = auto
fps = 30
max-dimension = 720
adaptive-quality = true
reconnect = true
turn = enabled when configured
debug = false
```

---

# 120. MJPEG Fallback

Keep MJPEG implementation for reliability.

But clearly separate:

```text
LegacyMediaTransport
```

from:

```text
WebRTCVideoTransport
```

---

# 121. Migration Strategy

Do NOT delete the old implementation immediately.

Implement:

```text
v2/
```

alongside the current transport.

Then:

```text
feature flag
```

switches:

```text
FLUTTER_REMOTE_TRANSPORT=v2
```

---

# 122. Shadow Testing

When possible:

```text
V1
V2
```

can be compared in development.

Metrics:

```text
input latency
FPS
memory
CPU
connection failures
```

---

# 123. Production Switch

Once V2 is stable:

```text
V2 becomes default
```

V1 remains temporarily available as:

```text
legacy
```

for rollback.

---

# 124. Rollback

One environment variable should restore V1:

```text
FLUTTER_REMOTE_TRANSPORT=v1
```

No code changes required.

---

# 125. Documentation

Update:

```text
README.md
ARCHITECTURE.md
WEBRTC.md
TROUBLESHOOTING.md
DEVELOPMENT.md
```

Document:

```text
architecture
protocol
ports
debugging
TURN
deployment
GitHub Actions
```

---

# 126. Developer Documentation

Document common failures:

```text
ICE failed
TURN unavailable
simulator unavailable
serve-sim unavailable
first frame timeout
input channel closed
Cloudflare tunnel failure
```

---

# 127. Acceptance Criteria

The rewrite is NOT complete until all are true.

## Connection

* WebRTC connects reliably.
* ICE reconnect works.
* TURN works.
* stale signaling is ignored.
* browser refresh can reconnect.

## Input

* tap works.
* drag works.
* swipe works.
* scroll works.
* keyboard works.
* Arabic text works where simulator permits.
* pointer events remain responsive under video congestion.

## Video

* first frame arrives quickly.
* video is smooth.
* frame queue remains bounded.
* adaptive quality works.
* video does not block input.

## Reliability

* temporary network failure recovers.
* browser refresh does not kill session.
* cleanup works.
* no orphan processes.
* no memory leak during long session.

## Security

* session tokens expire.
* sessions are isolated.
* internal ports are not public.
* secrets are not logged.

---

# 128. Performance Acceptance Targets

Under a reasonable network:

```text
First frame:
< 2 seconds after WebRTC readiness

Input P50:
< 50ms

Input P95:
< 100ms

Video:
≈ 30 FPS

Memory:
no continuous growth

Reconnect:
< 5 seconds under normal network recovery
```

These are targets, not guarantees under arbitrary network conditions.

---

# 129. Final Implementation Rule

The AI agent implementing this specification MUST NOT optimize for minimal code changes.

Optimize for:

```text
correctness
+
latency
+
reliability
+
observability
+
maintainability
+
security
```

If the current implementation conflicts with this architecture:

```text
replace it.
```

Do not preserve bad abstractions.

---

# 130. Final Desired Architecture

The final system should conceptually look like:

```text
                           INTERNET
                               │
                               │ HTTPS/WSS
                               ▼
                     ┌─────────────────────┐
                     │   Cloudflare Edge   │
                     └──────────┬──────────┘
                                │
                                ▼
                     ┌─────────────────────┐
                     │ Signaling / Gateway │
                     │                     │
                     │ Auth                │
                     │ Session             │
                     │ Signaling           │
                     │ Metrics             │
                     └──────────┬──────────┘
                                │
                     WebRTC ICE │
                                │
                 ┌──────────────┴──────────────┐
                 │                             │
                 ▼                             ▼
          DataChannel                       Video
          Input / Control                  WebRTC
                 │                             │
                 └──────────────┬──────────────┘
                                ▼
                     ┌─────────────────────┐
                     │ WebRTC Media/       │
                     │ Control Gateway     │
                     │                     │
                     │ PeerManager         │
                     │ InputRouter         │
                     │ MediaManager        │
                     │ Metrics             │
                     └──────────┬──────────┘
                                │
                         localhost IPC
                                │
                                ▼
                     ┌─────────────────────┐
                     │ Simulator Adapter   │
                     └──────────┬──────────┘
                                │
                                ▼
                     ┌─────────────────────┐
                     │   iOS Simulator     │
                     │                     │
                     │ Flutter Application │
                     └─────────────────────┘
```

---

# 131. Implementation Order

Implement in exactly this order:

```text
Phase 1
Protocol + configuration

Phase 2
SessionManager + lifecycle

Phase 3
Signaling rewrite

Phase 4
WebRTC PeerManager

Phase 5
DataChannel architecture

Phase 6
InputRouter

Phase 7
Simulator Adapter

Phase 8
Video WebRTC transport

Phase 9
Reconnect / ICE restart

Phase 10
TURN

Phase 11
Metrics

Phase 12
Browser UI

Phase 13
GitHub Actions rewrite

Phase 14
Fallback transport

Phase 15
E2E tests

Phase 16
Stress tests

Phase 17
Documentation

Phase 18
V2 becomes default
```

---

# 132. Definition of Done

Do not declare the task complete because:

```text
npm test passes
```

or:

```text
WebRTC connection opens
```

The task is complete only when:

```text
flutter-remote up --public
```

produces a browser session where:

1. iOS Simulator starts.
2. Flutter app launches.
3. First frame appears.
4. User can tap.
5. User can drag.
6. User can scroll.
7. User can type.
8. Input remains responsive.
9. Video remains smooth.
10. Temporary network failures recover.
11. Browser refresh reconnects.
12. TURN works when direct ICE fails.
13. Metrics show actual connection health.
14. Session cleanup is reliable.
15. Long-running session does not continuously leak memory.
16. No internal simulator endpoint is publicly exposed.
17. V1 fallback remains available during migration.

---

# FINAL PRINCIPLE

The purpose of V2 is not simply:

> "Make WebRTC work."

The purpose is:

> **Build a real remote iOS Simulator streaming platform where video, input, signaling and session management are independent, observable, recoverable and optimized for low latency.**

The implementation should be treated as a platform architecture, not as a small feature patch.
