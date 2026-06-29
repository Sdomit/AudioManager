# Plan — Mini Controller

A small, always-on-top "desk knob" panel: two rotary knobs (sound + mic),
mute toggles, quick-switch of the Windows default speaker/mic, summoned by a
global shortcut, and mirrored to a phone as a remote control surface.

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
