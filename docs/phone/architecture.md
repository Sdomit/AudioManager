# Phone Wireless Audio — Architecture

Feature contract for using a phone as a wireless AudioManager input source over local WiFi.
Tracking issue: #45. This document is the Phase 0 (#39) deliverable, together with
[protocol-v1.md](protocol-v1.md) and [decisions.md](decisions.md).

## Goal

A phone joins AudioManager as a normal mixer input: the user scans a QR code, grants
microphone access in the browser, and the phone's mic streams into the mixer with the same
gain / mute / metering / routing controls as any other input. Audio stays on the LAN — no
cloud relay in the media path.

- MVP client is a **browser page** served by the desktop app itself (no install).
- A **native app wrapper** (Capacitor reusing the same client core) is a planned follow-up,
  not part of the MVP. The architecture below is shaped so that swap is shell-only.

## Component overview

```
PHONE (browser now / Capacitor later)              DESKTOP (Tauri)
┌──────────────────────────────┐                   ┌─────────────────────────────────────┐
│ ui/   React shell (swappable)│                   │ React UI: PhonePairingSheet (QR,    │
│ core/ framework-free TS:     │                   │  accept), InputRow "phone" kind     │
│  machine.ts / signaling.ts / │                   └──────────────┬──────────────────────┘
│  transport.ts / capture.ts   │                                  │ invoke IPC
└──────┬──────────────┬────────┘                   ┌──────────────▼──────────────────────┐
       │ WSS /ws      │ WebRTC DTLS-SRTP (Opus)    │ lib.rs phone_* commands             │
       │ (JSON v1)    │                            └──────┬──────────────────┬───────────┘
┌──────▼──────────────▼─────────────────────┐      ┌──────▼─────────┐ ┌──────▼───────────┐
│ net/server.rs — ONE axum HTTPS server     │      │ net/ (tokio rt)│ │ audio/remote.rs  │
│  GET /  → rust-embed of dist-phone        │─────▶│ session.rs     │▶│ shared-feed mgr  │
│  /ws    → signaling                       │      │ webrtc_peer.rs │ │ fan-out→ringbuf  │
│  TLS: rcgen self-signed, persisted        │      │ jitter.rs      │ └──────┬───────────┘
└───────────────────────────────────────────┘      └────────────────┘        │ Consumer<f32>
                                                   ┌─────────────────────────▼───────────┐
                                                   │ mixer.rs RemotePhone arm — same     │
                                                   │ shape as loopback::subscribe_*      │
                                                   └──────────────────────────────────────┘
```

Modules to be created:

| Module | Role |
|---|---|
| `src-tauri/src/net/mod.rs` | Dedicated tokio runtime (lazy `OnceLock`), server start/stop, LAN IP enumeration |
| `src-tauri/src/net/tls.rs` | Generate-or-load self-signed cert (rcgen, persisted PEM) |
| `src-tauri/src/net/session.rs` | Pairing session registry, token verification, expiry |
| `src-tauri/src/net/server.rs` | axum HTTPS router: phone client static files + `/ws` signaling |
| `src-tauri/src/net/signaling.rs` | Protocol v1 message types (serde) + dispatch |
| `src-tauri/src/net/webrtc_peer.rs` | webrtc-rs peer, Opus track receive, reader task |
| `src-tauri/src/net/jitter.rs` | Reorder buffer + Opus decode + PLC + latency modes |
| `src-tauri/src/audio/remote.rs` | Shared feed manager bridging network → mixer rings |
| `src/phone/core/` | Framework-free phone client logic (protocol, signaling, transport, capture, state machine) |
| `src/phone/ui/` | React shell for the browser client |

## Data path

```
phone mic
→ getUserMedia (mono, 48 kHz, EC/NS/AGC configurable, off by default)
→ browser Opus encoder (20 ms frames; 10 ms negotiated in Fastest mode)
→ SRTP over LAN UDP (host ICE candidates only, no STUN/TURN)
→ webrtc-rs TrackRemote.read()  [tokio task]
→ jitter buffer (seq reorder; gap → Opus PLC; over-depth → drop-oldest)
→ Opus decode to 48 kHz mono f32
→ LinearResampler (48 kHz → bus rate, identity skip when equal)
→ ring producer per subscriber (lock-free SPSC, same shape as loopback)
→ mixer output callback pop()  [realtime thread, unchanged]
```

The realtime mixer path is untouched: an empty ring already plays silence
(`pop().unwrap_or(0.0)`, mixer.rs), so a disconnected phone is silent by construction —
no special-casing in the audio thread.

### Latency budget

| Stage | Fastest | Balanced | Stable |
|---|---|---|---|
| Phone capture + encode frame | ~20–35 ms | ~30–45 ms | ~30–45 ms |
| LAN transit | <5 ms | <5 ms | <5 ms |
| Jitter buffer depth | 1 frame (~10–20 ms) | 3 frames (~60 ms) | 6 frames (~120 ms, adaptive) |
| Ring fill + output buffer | ~20–30 ms | ~20–30 ms | ~20–30 ms |
| **Total (target)** | **≈60–80 ms** | **≈90–110 ms** | **≈150+ ms** |

Targets from #45: 50–100 ms normal, 20–50 ms excellent, 100–150 ms acceptable for speech,
200 ms+ rejected. Phase 4 (#43) measures real numbers with a click-track/recorder method
and tunes depths.

## Remote Input contract (Rust)

### Source identity

New synthetic ID namespace: `phone:<session-id>` (uuid v4, simple hex form — no dashes,
no `:` in the payload). It joins the existing synthetic namespaces `sys:`, `proc:`,
`app:` and is added to `is_reserved_id` so a hostile cpal device name cannot shadow it.

```rust
// source.rs
pub const PHONE_PREFIX: &str = "phone:";

pub enum InputSourceSpec {
    Device { name: String },
    Process { pid: u32, include_tree: bool },
    ProcessByName { image_name: String, include_tree: bool },
    SystemLoopback,
    RemotePhone { session_id: String },   // NEW
}
```

The string ID threads unchanged through graph routing (`InputChannel.device_id`), IPC,
presets, and the frontend — exactly like the loopback IDs.

### Feed manager (`audio/remote.rs`)

Mirrors the `loopback.rs` shared-capture-manager pattern, with one inversion: samples are
**pushed** by the network side rather than pulled by a capture thread the manager owns.

```rust
pub const PHONE_CHANNELS: u16 = 1;   // mono; mixer's (1,2) arm duplicates to stereo

/// Mixer side (sync, called during engine build).
/// NEVER fails for an unknown session: registers a passive feed keyed
/// "phone:<sid>@<rate>" that emits nothing until the session connects.
pub fn subscribe_phone(
    session_id: &str,
    expected_rate: u32,
    peak_slots: Arc<Vec<InputSlotShared>>,
    slot_index: usize,
) -> Result<(Consumer<f32>, u16, RemoteSubscription), EngineError>;
// RemoteSubscription is RAII; last drop for a key removes the feed.

/// Network side (sync, called from tokio tasks).
pub(crate) fn push_decoded_48k(session_id: &str, samples: &[f32], block_peak: f32);
pub(crate) fn set_session_state(session_id: &str, state: RemoteState);
pub fn session_states() -> Vec<(String, RemoteState)>;   // surfaced via get_system_status
```

Internals: `Mutex<HashMap<String /* sid@rate */, RemoteFeed>>` in a `OnceLock`;
`RemoteFeed { subs: Vec<Subscriber>, resampler: LinearResampler }`;
`Subscriber { id, producer, peak, index }`. Lock order is map → subs, one-way, and the
realtime audio thread touches neither lock (it only pops rings). Sample sanitization
(finite check) and peak metering (`store_max`) follow loopback.rs exactly.

### Mixer integration

One new arm in the engine-build branch of `mixer::start()`, next to the loopback arms:

```rust
InputSourceSpec::RemotePhone { session_id } => {
    let (consumer, ch, sub) = remote::subscribe_phone(
        session_id, out_sample_rate.0, Arc::clone(&shared_for_thread), i)?;
    consumers.push((consumer, ch as usize));
    remote_subscriptions.push(sub);   // dropped on engine teardown
}
```

Everything downstream — per-input gain, mute, sends, metering, recording taps, the
8-input-per-bus limit — works unchanged because the phone is just another ring consumer.

### Source lifecycle

Session states (desktop-side, owned by `net/session.rs`, mirrored to UI):

```
Created ──QR scanned, WS hello ok──▶ ClientConnected ──▶ PendingAccept
   │                                                        │ user Accept
   │ 10 min unused                                          ▼
   ▼                                  Accepted/Live ◀──── (auto add_input "phone:<sid>")
Expired                                  │    ▲
                                 WS/RTC drop  │ re-hello + re-offer (same session+token)
                                         ▼    │
                                     Reconnecting ──2 min grace──▶ Disconnected
```

- While `Reconnecting`/`Disconnected`, the input stays in the graph and plays silence;
  the UI shows a badge. No engine rebuild on connection flaps.
- A preset saved with a `phone:` input loads fine when the session no longer exists:
  the preset path does not validate against live sessions; the input appears silent with
  a Disconnected badge and a dedicated `phone_session_absent` load warning (this also
  fixes the pre-existing bogus "input unavailable" warning that `build_load_warnings`
  emits for all synthetic IDs).
- Removing the input (or the session) tears down the peer and frees the feed via RAII.

## App-readiness invariants (the contract that makes a native app a drop-in)

1. **The desktop never branches on client kind.** It sees a TLS WebSocket speaking
   protocol v1, then a standard WebRTC offer. `hello.client.kind` (`"browser"` | `"app"`)
   is informational/logging only.
2. **`src/phone/core/` is framework-free.** Zero imports from React, Vite env, or layout
   concerns — only WebRTC / WebSocket / getUserMedia APIs, which a Capacitor WebView
   provides identically. A future Capacitor project imports `core/` unchanged and supplies
   its own shell plus native mic-keepalive.
3. **The protocol is versioned.** Every message carries `v: 1`; unknown majors are
   rejected with `error{code:"version"}` (see protocol-v1.md). A native app can ship
   against a pinned version and negotiate.
4. **Renegotiation is first-class.** `offer` after `live` is legal; reconnect re-uses the
   same session + token. The native app's background/foreground transitions ride the same
   path as a browser tab refresh.

## Build & packaging layout

- Phone client: separate Vite config `vite.phone.config.ts`, entry `phone.html`, output
  `dist-phone/`. The main Tauri `frontendDist: ../dist` is untouched.
- Desktop embeds `dist-phone/` via `rust-embed` (debug builds read the folder live from
  disk — that is the dev loop) and serves it at `GET /` on the phone server.
- `tauri.conf.json` `beforeBuildCommand` becomes `pnpm build && pnpm build:phone`.
- Server: one axum HTTPS listener, default port 47800 (fallback 47801–47809), bound on
  LAN interfaces, TLS from a persisted self-signed cert (see decisions.md).

## MVP acceptance criteria (voice streaming quality)

The MVP is done when, on a normal home WiFi network (desktop wired or on 5 GHz):

1. Pairing: QR scan → cert interstitial accepted once → phone page loads → desktop shows
   the pending phone → user accepts → phone appears as a mixer input. Under 60 seconds
   for a first-time user following the user guide.
2. Audio: speech into the phone is heard on the routed bus with no audible artifacts at
   default (Balanced) mode on a healthy network; gain, mute, meter, sends, and recording
   taps behave identically to other inputs.
3. Latency: Balanced ≤ ~110 ms end-to-end measured; Fastest ≤ ~80 ms; never 200 ms+ on a
   healthy LAN (the #45 hard ceiling).
4. Robustness: WiFi blip of ≤ 10 s recovers automatically (Reconnecting → live) without
   touching the mixer graph; phone screen lock surfaces a clear "capture stopped" state
   rather than silent failure.
5. Security: a device without the QR token cannot connect a session; tokens expire after
   10 minutes unpaired; tokens never appear in logs; a second peer cannot hijack a live
   session.
6. Cleanup: stopping from either side removes or visibly disconnects the input — no stale
   sources, no leaked threads/tasks (verified by repeated connect/disconnect cycles).

## Future: native phone app (out of MVP scope)

Browsers suspend `getUserMedia` capture when the screen locks or the tab backgrounds
(hard block on iOS WebKit; OEM-dependent on Android). The MVP mitigates with a wake lock
and a visible "keep screen on" warning — that is an accepted limitation.

The planned fix is a **Capacitor wrapper** around the same client:

- Reuses `src/phone/core/` verbatim (invariant 2 above).
- iOS: `UIBackgroundModes: audio` + `AVAudioSession` keeps the mic live under lock.
- Android: foreground service (`FOREGROUND_SERVICE_MICROPHONE`) survives lock/Doze.
- The TLS interstitial ceremony disappears (native WebView grants mic permission
  directly).
- Desktop side needs zero changes (invariant 1).

Details and the consumption recipe land in `docs/phone/capacitor-notes.md` during
Phase 5 (#44).
