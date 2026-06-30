# Plan — Mini Controller

A small, always-on-top "desk knob" panel: two rotary knobs (sound + mic),
mute toggles, quick-switch of the Windows default speaker/mic, summoned by a
global shortcut, and mirrored to a phone as a remote control surface.

## Status — all phases implemented (feat/mini-controller)

| Phase | What | Commit |
|-------|------|--------|
| MC-1 | OS endpoint control (Core Audio: IPolicyConfig + IAudioEndpointVolume) | d727e6b |
| MC-2 | Knob + MiniPanel hybrid-target dock | (Knob/MiniPanel/knobTarget) |
| MC-3 | Always-on-top pop-out window (#mini route, runtime WebviewWindow) | (MiniWindow) |
| MC-4 | Global shortcut Ctrl+Alt+M → toggle window | e968775 |
| MC-5 | Phone remote (endpoint volume/mute, accepted-gated) | 87ad926 |
| — | MiniPanel polling hardening (drag race + hidden window) | e5a6960 |

**Verification — static:** `tsc --noEmit`, `cargo check`, `pnpm build:phone` all
green; MiniPanel + `#mini` route render-verified in a bare-Vite preview.

**Verification — LIVE on Windows 11 (`pnpm tauri dev` + real hardware):**
- ✅ Full app builds (1m42s) + launches; capability config valid, no startup crash.
- ✅ COM layer verified non-destructively via the extended `endpoint_ctl_smoke`
  (`cargo test -- --ignored`): enumerated 7 render + 4 capture endpoints with
  correct names/IDs/defaults, read real volumes, and every write path returned
  `Ok` — including **`IPolicyConfig::SetDefaultEndpoint`** (the undocumented vtable;
  called with the already-default id, so no system change). The feature's #1 risk
  is cleared.
- ✅ Global hotkey: the fallback chain registered live (Ctrl+Alt+M was taken on
  this machine → fell back to **Ctrl+Shift+F10**).

**Still needs an eyeball / interactive pass (the dev build isn't resolvable by the
computer-use name resolver, so I couldn't click it):** a knob drag audibly moving
system volume, the pop-out window floating always-on-top, and the phone remote
end-to-end (pair a phone, firewall 47800-47809). The data + COM paths underneath
all three are verified; what's unconfirmed is the on-screen interaction.

## Decision: knobs are hybrid-target

Each knob points at a **configurable target** — either a Windows OS audio
endpoint (system-wide volume, EarTrumpet-style) or an AudioManager mixer
channel (a bus or an input). User picks per knob; choice persists.

```ts
type KnobTarget =
  | { kind: "endpoint"; deviceId: string; direction: "render" | "capture" }
  | { kind: "bus"; busId: string }
  | { kind: "input"; inputId: string };
```

Defaults: knob A → default render endpoint, knob B → default capture endpoint.
The default-device dropdowns are independent of knob target and always switch
the real OS default.

## Architecture it builds on (verified)

- `AppState { inner: Mutex<AppInner> }` — `state.rs:34`. Holds buses, graph,
  recorders, metering taps.
- 69 commands via `tauri::generate_handler!` — `lib.rs:2441`. Command shape:
  `fn(state: tauri::State<AppState>, ...) -> Result<_, EngineError>`
  (`set_bus_volume` at `lib.rs:1227`).
- COM already bootstrapped (`CoInitializeEx` + `IMMDeviceEnumerator`) in
  `amvc_sync.rs:37`.
- `windows 0.62` with `Win32_Media_Audio` + `Win32_System_Com` already enabled
  (`Cargo.toml:54,63`). `IAudioEndpointVolume` is in-crate; `IPolicyConfig` is
  not (manual decl needed).
- Device enum: cpal-backed `list_input_devices` / `list_output_devices`,
  `DeviceInfo { id, name, default_sample_rate, channels, is_default }`
  (`audio/devices.rs`).
- Phone stack already complete: axum 0.8 `/ws` server on ports 47800–47810,
  TLS, trusted-device pairing, embedded phone SPA (`src/phone/` → `dist-phone/`),
  protocol `ClientMessage`/`ServerMessage` in `net/signaling.rs:18`.
- Plugins wired at `lib.rs:2381` (currently only `tauri-plugin-opener`).
- Single window `"main"`; capability `capabilities/default.json` grants `["main"]`.

## Phases

Each phase is independently shippable. Build order MC-1 → MC-5; stop and ship
after any phase.

### MC-1 — Backend: OS endpoint control (Core Audio)

New `src-tauri/src/audio/endpoint_ctl.rs`:

- `set_default_endpoint(id: &str, direction)` — **IPolicyConfig::SetDefaultEndpoint**
  for all three roles (eConsole, eMultimedia, eCommunications). `IPolicyConfig`
  is undocumented and absent from the `windows` crate → declare it manually with
  `#[windows::core::interface("...")]` + the known GUID. Proven pattern
  (EarTrumpet, AudioDeviceCmdlets, soundvolumeview).
- `get_endpoint_volume(id) -> { volume: f32, muted: bool }` and
  `set_endpoint_volume(id, v)` / `set_endpoint_mute(id, m)` — **IAudioEndpointVolume**
  (in-crate; activate from the `IMMDevice` for the id).
- `list_render_devices()` / `list_capture_devices()` returning id + name +
  is_default — extend `devices.rs` (cpal lacks "current default endpoint id";
  read it via `IMMDeviceEnumerator::GetDefaultAudioEndpoint`).
- Reuse the COM-init approach from `amvc_sync.rs`. Per-call `CoInitializeEx`
  with guard, or a shared init — match `amvc_sync.rs`.

IPC commands (wire into `generate_handler` at `lib.rs:2441`, mirror
`set_bus_volume`):
`audio_list_render_devices`, `audio_list_capture_devices`,
`audio_get_default_device`, `audio_set_default_device`,
`audio_get_endpoint_volume`, `audio_set_endpoint_volume`,
`audio_set_endpoint_mute`.

Frontend wrappers in `src/ipc/commands.ts`.

**Gate:** `cargo check` + `cargo test` + manual COM smoke (switch default
device, set volume, confirm in Windows sound settings).

### MC-2 — Frontend: Knob component + panel (in main window first)

- `src/components/audio-manager/Knob.tsx` — rotary SVG knob: arc fill +
  pointer-drag (vertical delta → value), wheel step, arrow-key step,
  `role="slider"` + `aria-valuenow`. The only new UI primitive.
- `knobTarget.ts` — `KnobTarget` type + read/write adapter:
  - read: endpoint → `audio_get_endpoint_volume`; bus/input → existing polled
    `state.buses` / `state.inputs`.
  - write: endpoint → `audio_set_endpoint_volume`; bus → `setBusVolume`; input →
    `setInputGain`.
  - mute: endpoint → `audio_set_endpoint_mute`; bus/input → existing muted flag.
- `MiniPanel.tsx` — two knobs, two mute buttons, two default-device dropdowns
  (render + capture), a small per-knob target picker. Polls values ~10 Hz.
- Per-knob target config persisted to `localStorage` (same idiom as
  `LS_BUS_VIEW_MODE`).
- Render inside the main window (collapsible dock or modal) first, so it is
  verifiable before any window plumbing.

**Gate:** `tsc --noEmit` + preview/manual.

### MC-3 — Always-on-top mini window

- Add window `"mini"` to `tauri.conf.json`: ~280×360, `alwaysOnTop: true`,
  `decorations: false`, `skipTaskbar: true`, `resizable: false`,
  `visible: false`.
- Add `"mini"` to `capabilities/default.json` windows list.
- Same JS bundle; hash route `#/mini` renders only `MiniPanel` (no separate
  vite entry).
- Show/hide/toggle via the Tauri JS window API (`WebviewWindow.getByLabel`).

**Gate:** `cargo check` + `tsc` + window smoke (open, stays on top, closes).

### MC-4 — Global shortcut

- Add `tauri-plugin-global-shortcut` to `Cargo.toml`; register in the builder
  chain at `lib.rs:2381`; add its permission to `capabilities/default.json`.
- Default combo `Ctrl+Alt+M` toggles the mini window (works while app
  unfocused). Rebind UI deferred (hardcode default first).

**Gate:** `cargo check` + unfocused-hotkey smoke.

### MC-5 — Phone remote control

Rides the existing phone stack — no new transport/pairing/TLS.

- Extend `net/signaling.rs` (additive, backward-compatible):
  - `ClientMessage::Control` with sub-ops: set endpoint/bus/input volume, set
    mute, set default device, request state.
  - `ServerMessage::State` snapshot push (current targets, volumes, mutes,
    device lists).
- Handle `Control` in `net/session.rs` / `net/server.rs` → call MC-1 endpoint
  functions and existing mixer commands. Reuse trusted-device gating.
- Phone client (`src/phone/`): add a "Remote" screen mirroring `MiniPanel`
  (knobs + mutes + device pickers), sending `Control` over the existing `/ws`.

**Gate:** `cargo check` + `tsc` + `pnpm build:phone` + phone test (firewall rule
47800–47809 per build env).

## Cross-cutting risks

1. `IPolicyConfig` manual COM decl — the one place needing exact GUID/vtable.
   Bounded; copy the established interface definition.
2. Two windows share one `AppState`; both poll, backend is the single source of
   truth — no sync logic needed.
3. Phone protocol bump — keep `Control`/`State` additive so older phone clients
   still pair (notes the existing protocol-v1 drift).

## Out of scope (v1)

- Per-app volume (mixer-style app sessions) — endpoint-level only.
- Knob rebinding of the global shortcut UI — fixed default first.
- Multi-monitor mini-window position memory.

## Critical review — known limitations (thinking differently)

Honest weaknesses found reviewing the finished feature:

1. **Polling, not push (biggest architectural smell).** Every open surface polls
   `IAudioEndpointVolume` ~4×/s, each call spinning up a fresh `IMMDeviceEnumerator`
   + `Activate`. Correct but wasteful, and four surfaces (dock, window, phone,
   Windows itself) can disagree transiently. The right design is an
   `IAudioEndpointVolumeCallback` push + a cached enumerator. Deferred — the
   hidden-window guard + 250 ms cadence keep it acceptable for v1.
2. **Hybrid target is over-built for its reach.** Only the dock uses bus/input
   targets; the pop-out and phone are endpoint-only. A leaner product is
   "mini controller = OS endpoints, mixer stays in the main app." Kept hybrid
   because it was explicitly requested, but it earns its complexity in 1 of 3
   surfaces.
3. ~~**IPolicyConfig is undocumented + live-unverified.**~~ RESOLVED — the
   hand-declared vtable was exercised against real hardware (no-op `SetDefaultEndpoint`
   returned `Ok` on Windows 11). No longer a risk.
4. **Phone can change volume/mute but NOT switch the default device** — a
   deliberate conservative choice (no `set-default-device` in the phone protocol),
   and control is strictly gated on an accepted session (gate confirmed by review).
5. ~~**Global hotkey is fixed (Ctrl+Alt+M), silent on conflict.**~~ FIXED — found
   live (Ctrl+Alt+M was taken), replaced with a fallback chain + `get_mini_hotkey`
   so the overlay shows the real combo. A full rebind UI is still a follow-up.

After live testing, (1) polling-vs-push is the only substantive item left to
revisit; it does not block a v1.
