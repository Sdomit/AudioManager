# Phone Wireless Audio — Decision Log

Decisions for issues #39–#45, with rejected alternatives and revisit triggers.
See [architecture.md](architecture.md) for the overall design and
[protocol-v1.md](protocol-v1.md) for the wire protocol.

## D1 — Secure context: runtime self-signed TLS (rcgen)

**Problem.** `getUserMedia` requires a secure context. `http://<lan-ip>` blocks the mic
on every mobile browser, so plain HTTP is a non-starter.

**Decision.** Generate a self-signed certificate at first run with `rcgen`, persist the
PEM pair under `app_local_data_dir/phone/`, serve via `axum-server` (rustls). SANs cover
all LAN IPv4s. The phone user accepts the browser interstitial once per phone per cert
(iOS Safari: *Show Details → visit this website*; Android Chrome: *Advanced → Proceed*),
after which the origin is a secure context and the mic prompt works.

**Rejected.**
- Plain HTTP — mic blocked, dead end.
- USB/`adb` localhost tunnel — defeats "wireless".
- Plex-style public domain + real certs (`*.x.plex.direct`) — needs cloud DNS + cert
  infra; contradicts the no-cloud constraint; heavy for an MVP.
- Installing a local CA on the phone (mkcert-style) — worse UX than one interstitial.

**Revisit if** an iOS release regresses interstitial-accepted origins to non-secure
(test in Phase 1/2 acceptance). Fallback: manual cert trust profile; long-term: native
app (no interstitial at all).

## D2 — WebRTC stack: `webrtc` crate (webrtc-rs) 0.17

**Decision.** Pure-Rust webrtc-rs: tokio-native, full ICE/DTLS/SRTP, `TrackRemote::read()`
hands us RTP packets directly, and it builds cleanly under MSVC (`ring`-based crypto — no
cmake/NASM/openssl). Receiver-side-only cost; the shape (receive one Opus track) is its
best-trodden path (WHIP/WHEP servers).

**Rejected.**
- `str0m` — leaner, but sans-IO: we would own the UDP driver, timers, and DTLS event
  loop; default crypto is aws-lc-rs (cmake+NASM on Windows). More code, no functional
  gain at one peer. **Kept as fallback** — the swap is localized to `net/webrtc_peer.rs`
  because the jitter buffer and decode are ours either way.
- `datachannel-rs` (libdatachannel) — vendored C++ build (cmake, openssl) on Windows;
  worst build story.

**Revisit if** webrtc-rs shows connection-setup bugs or unmaintainable latency in
Phase 2/4 measurements.

## D3 — Opus decode: `audiopus` 0.3.0-rc.0

**Decision.** `audiopus` + `audiopus_sys` ship a prebuilt static libopus for Windows
MSVC (no cmake), support PLC (`decode(None, …)`) and in-band FEC, and are proven in
production (songbird/serenity). Decode happens in our jitter feeder task, not inside
the WebRTC stack.

**Fallback.** `opus` 0.3.1 (builds libopus from source; requires cmake on the build
machine). The **first commit of Phase 2 is a build spike** proving whichever crate links
on this machine before any feature code lands.

## D4 — Tokio hosting: one dedicated lazy runtime

**Decision.** `net/mod.rs` owns a `OnceLock<tokio::runtime::Runtime>` (2 worker threads,
named "phone-net"), independent of Tauri's runtime so `net/` is unit-testable without a
Tauri app handle.

Sync/async bridging is trivial by construction:
- Mixer-side `remote::subscribe_phone` is pure sync (mutex + hashmap; never awaits,
  never blocks on the network) — safe to call during engine build.
- Network-side `push_decoded_48k` is sync (mutex + lock-free ring push) — safe to call
  from tokio tasks.
- The only true async init (server bind) confirms success back to the sync IPC thread
  via an mpsc ready-channel — the same spawn-and-confirm pattern `loopback.rs` uses.

## D5 — Jitter buffer: own implementation, mode-driven depth

**Decision.** `net/jitter.rs`: `BTreeMap<u16 /*seq*/, Vec<u8>>` reorder buffer with
wraparound-aware comparisons, drained by a 20 ms tick feeder task. Gap → Opus PLC
(`decode(None)`); depth above target + hysteresis → drop-oldest. The RTP payload of an
Opus stream IS the Opus frame — no depacketization framework needed.

Latency modes set the target depth: **Fastest = 1 frame, Balanced = 3 (default),
Stable = 6 with adaptive bump on PLC bursts**. The ring buffer is the final elasticity
stage (fill capped via `producer.len()`), the jitter buffer the authoritative control.
Phase 4 may additionally negotiate `ptime:10` in the answer SDP for Fastest mode
(10 ms frames; 5 ms only as an experiment if stable — per #43).

**Rejected.** Reusing webrtc-rs's interceptor/jitter machinery — designed for
playout-at-wall-clock, not feed-a-mixer-ring; less controllable for our latency modes.

## D6 — ICE: host candidates only (no STUN/TURN)

**Decision.** LAN-only by definition, so `iceServers: []` on the phone and default host
candidates on the desktop. Browsers will emit mDNS-obfuscated `.local` host candidates;
connectivity still establishes because the desktop's own host candidate reaches the
phone, and the desktop learns the phone's real address as a **peer-reflexive candidate**
from inbound STUN binding requests.

**Risks accepted.** Router AP/client isolation (common on guest WiFi) breaks the media
path while WS may still work — the pairing sheet must detect "WS up, ICE failed" and
show a specific guest-network/AP-isolation error (Phase 5 docs cover it). If prflx
discovery proves flaky on real routers (Phase 2 test), enable webrtc-rs's mDNS
resolution feature.

## D7 — Phone client build: separate Vite config + rust-embed

**Decision.** `vite.phone.config.ts` with entry `phone.html` building to `dist-phone/`,
embedded by `rust-embed` and served at `GET /`. Debug builds read the folder live from
disk (the dev loop). `beforeBuildCommand` becomes `pnpm build && pnpm build:phone`.

**Rejected.**
- Multi-entry rollup in the main vite config — entangles Tauri's `frontendDist` and
  ships phone assets inside the desktop bundle's dist.
- Tauri secondary window for the phone UI — the phone is a *remote* browser, not a
  local window; doesn't apply.
- Separate Node server for the phone page — second process to manage; axum already
  serves the signaling socket, static files are free.

## D8 — Source identity: `phone:<session-id>` synthetic namespace

**Decision.** Follows the established `sys:` / `proc:` / `app:` synthetic-ID pattern:
parseable from the string everywhere (graph, IPC, presets, frontend adapters), added to
`is_reserved_id` so device names cannot shadow it. Session IDs are uuid v4 simple-hex.

**Consequence handled.** Presets can reference sessions that no longer exist — by design
the preset loads, the input plays silence with a Disconnected badge, and
`build_load_warnings` gets a dedicated `phone_session_absent` warning (also fixing the
pre-existing bogus "unavailable" warning it emits for all synthetic IDs today).

## D9 — Phone always offers

**Decision.** The phone owns the mic track, so it creates the offer; the desktop answers
and shapes the Opus fmtp (`useinbandfec=1`, ptime per mode). Re-offer after `live` is the
single renegotiation path shared by reconnects, ptime changes, and the future native
app's background/foreground transitions. One direction = one code path to harden.

## D10 — Audio format: mono 48 kHz f32 end-to-end

**Decision.** Opus over WebRTC natively runs at 48 kHz; phone mics are mono; voice is the
use case. The feed declares `channels = 1` and the mixer's existing `(1, 2)` arm
duplicates to stereo buses — halving ring traffic with zero mixer changes. Browser audio
processing (echo cancellation, noise suppression, auto gain) defaults **off** — this is a
mic input into a mixer, not a call — but stays configurable per #41.

## D11 — Phasing: WebRTC path lands before mixer integration

**Decision.** Phase 2 delivers phone → desktop decoded **stats** (packet counts, decoded
peak as a "we hear you" meter) without touching the audio engine; Phase 3 connects the
decoded stream to the mixer. Rationale: an offer-only phone PR is untestable end-to-end,
and a client+receiver+mixer PR is too large to review. The seam (decoded 48 kHz frames)
is exactly the `push_decoded_48k` call, so Phase 3 swaps a stats sink for the real feed.
