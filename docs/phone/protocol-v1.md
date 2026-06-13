# Phone Wireless Audio — Signaling Protocol v1

JSON messages over a TLS WebSocket (`wss://<lan-ip>:<port>/ws`). This protocol is
client-agnostic: the desktop treats a browser page and a future native app identically.
Media itself never flows over this socket — it travels in a standard WebRTC
DTLS-SRTP session negotiated here.

## Envelope rules

- Every message is a JSON object with `"v": 1` and `"type": "<kebab-case>"`.
- Unknown **fields** are ignored (forward compatibility).
- Unknown **type** → `error{code:"unsupported"}`; the connection stays open.
- `v` other than `1` → `error{code:"version", supported:[1]}` followed by close.
- The first frame from the phone MUST be `hello`. Anything else (or >1 KB of bytes
  before a valid `hello`) → close.
- Text frames only. One JSON object per frame.

## Message reference

Direction: P→D = phone to desktop, D→P = desktop to phone.

| Dir | `type` | Payload | Notes |
|---|---|---|---|
| P→D | `hello` | `session: string`, `token: string`, `client: {kind: "browser"\|"app", os: string, ua: string, ver: string}`, `caps: {codecs: ["opus"]}`, `name?: string` | `name` is the user-editable friendly device name. Token verified against the session; 5 failed attempts invalidate the session. `client.kind` is informational only. |
| D→P | `hello-ack` | `state: string`, `accept_required: bool`, `server: {name: string, app_ver: string}` | Sent on successful hello. `accept_required=true` until the desktop user accepts this device. |
| D→P | `accepted` | `{}` | Desktop user clicked Accept. Phone may now send `offer`. |
| D→P | `rejected` | `reason: string` | Desktop user rejected; server closes after sending. |
| P→D | `offer` | `sdp: string` | Phone always offers (it owns the mic track). Also used for renegotiation after `live` (reconnect, track restart, ptime change). |
| D→P | `answer` | `sdp: string` | Desktop answers; shapes Opus fmtp (`useinbandfec=1`, ptime per latency mode). |
| both | `candidate` | `candidate: string`, `sdpMid: string\|null`, `sdpMLineIndex: number\|null` | Trickle ICE. Host candidates only (no STUN/TURN configured). |
| D→P | `latency` | `mode: "fastest"\|"balanced"\|"stable"` | Informational for the phone UI; the authoritative jitter depth is applied desktop-side. May trigger a desktop-initiated renegotiation request in future minors. |
| P→D | `stats` | `micLevel: number (0..1)`, `visible: bool`, `batterySaver?: bool` | Optional, 1 Hz. Drives the desktop "we hear you" pre-mixer meter and warnings. |
| both | `bye` | `reason: string` | Graceful close. Examples: `"user-stop"`, `"session-removed"`, `"shutdown"`. |
| D→P | `error` | `code: string`, `message: string` | See error codes below. Fatal codes are followed by close. |

### Error codes

| `code` | Meaning | Fatal |
|---|---|---|
| `version` | Unsupported protocol major. Payload includes `supported: [1]`. | yes |
| `unsupported` | Unknown message type. | no |
| `bad-token` | Token mismatch for the session. | yes (after 5 attempts the session is invalidated) |
| `unknown-session` | Session ID not in the registry (expired or removed). | yes |
| `busy` | Session already has a live peer (single-peer rule). | yes |
| `rejected` | Desktop user declined the device. | yes |
| `malformed` | Frame is not valid JSON or violates envelope rules. | yes |

## Handshake sequence (happy path)

```
Phone                                   Desktop
  │  ──── wss connect ────────────────▶ │
  │  ──── hello{session,token,…} ─────▶ │  verify token, mark ClientConnected
  │  ◀──── hello-ack{accept_required} ─ │  UI shows pending device
  │            (user clicks Accept)     │
  │  ◀──── accepted ─────────────────── │  session → Accepted; input "phone:<sid>" added
  │  ──── offer{sdp} ─────────────────▶ │
  │  ◀──── answer{sdp} ──────────────── │
  │  ◀─/─▶ candidate (trickle, both) ─  │
  │  ═════ WebRTC DTLS-SRTP media ════▶ │  state → live; audio reaches mixer
  │  ──── stats (1 Hz) ───────────────▶ │
```

## State machines

### Desktop session (`net/session.rs`)

```
Created ──hello ok──▶ ClientConnected ──▶ PendingAccept ──accept──▶ Accepted/Live
   │                        │                   │ reject                │   ▲
   │ 10 min unused          │ ws drop           ▼                       │   │ re-hello +
   ▼                        ▼               (closed)             ws/rtc drop│ re-offer ok
Expired ◀──────── (gc) Disconnected ◀──────2 min grace────── Reconnecting ─┘
```

- `Reconnecting` starts when the WS or the ICE connection drops while `Accepted`.
- During `Reconnecting`/`Disconnected` the mixer input stays in the graph and plays
  silence; no engine rebuild.
- Re-pairing after `Expired`/removal requires a fresh QR (new session + token).

### Phone client (`src/phone/core/machine.ts`)

```
idle ──open ws──▶ connecting ──ws open──▶ hello-sent ──hello-ack──▶ waiting-accept
                                                                        │ accepted
                      ┌────────────── reconnecting ◀──ws/rtc lost──┐    ▼
                      │ backoff: 1s,2s,4s,…max 15s                 │ negotiating
                      └──ws open → re-hello → accepted-fast path───┤    │ ICE connected
                                                                   └── live
any state ──rejected / bad-token / unknown-session / bye──▶ ended (terminal, show reason)
```

- On `reconnecting`, the client re-sends `hello` with the **same** session + token; the
  desktop replies `hello-ack` and, if previously accepted, `accepted` immediately
  (no second user confirmation), and the client sends a fresh `offer`.
- `ended` is terminal: the user must re-scan a QR (or tap a "rejoin" link if the session
  still exists and the token is still in `location.hash`).

## Reconnect & renegotiation rules

1. A session survives WS drops for 2 minutes (`Reconnecting` grace), then `Disconnected`;
   GC may expire it later. Timings are desktop-owned constants.
2. Re-`hello` with the same session + token while `Reconnecting` resumes the session.
   A re-`hello` while a peer is still live → `error{code:"busy"}` (single-peer rule).
3. `offer` after `live` is legal renegotiation — same flow as initial negotiation. The
   desktop always answers. This is the path used by reconnects, future ptime changes,
   and the native app's background/foreground transitions.
4. ICE restarts are expressed as a new `offer` with `iceRestart: true` semantics
   (the desktop does not initiate; the phone owns recovery).

## Versioning policy

- This document defines **major 1**. Breaking changes (renamed/removed fields, changed
  semantics) bump the major and get a new `protocol-v2.md`.
- Additive changes (new optional fields, new message types the peer may ignore) are
  minor and do NOT bump `v`. Receivers must tolerate unknown fields and unknown types
  (`error{code:"unsupported"}` is non-fatal by design).
- The desktop advertises nothing in advance: the phone sends `v:1` and the desktop either
  speaks it or rejects with `supported:[…]`, letting a future client downgrade.

## Security requirements (normative)

Implemented in Phase 1:

- Pairing URL format: `https://<lan-ip>:<port>/#s=<session>&t=<token>` — credentials live
  in the **fragment**, which browsers never send in HTTP request lines, so they cannot
  appear in server/access logs.
- Token: uuid v4 (122 bits). 5 consecutive failures invalidate the session; a correct
  token clears the strike count so a second LAN device cannot grief a session by burning
  attempts across reconnects. Never logged; SDP bodies and candidates log at debug only.
- Unused sessions expire 10 minutes after creation. Accepted sessions live until removed
  by the user or app exit.
- One live peer per session. Multi-phone = multiple sessions, each its own QR + accept.
- Pre-hello byte cap (2 KB) on the first frame; first frame must be a valid `hello`.
- The desktop user must explicitly accept each new device before any media is negotiated.

Deferred to Phase 5 (#44) — see `decisions.md`:

- Constant-time token comparison (Phase 1 uses ordinary equality on the 122-bit token).
- WS handshake rate limit per source IP.
- Idle WS timeout on authenticated-but-silent sockets.
