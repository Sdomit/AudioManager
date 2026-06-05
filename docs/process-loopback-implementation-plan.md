# Process Loopback Implementation Plan

> Planning document. No code is implemented as part of this branch.
> Source of truth for execution order is GitHub milestone **Per-App Audio Capture**
> and the issues listed below. This file is the human-readable index.
>
> **Line refs below were captured pre-#27–#29 (amvc merge) and may drift a few lines.**
> Verified against current `main`: `graph.rs:31`, `mixer.rs:271`, `mixer.rs:411` still hold;
> `ensure_input_name` moved `lib.rs:158 → :159`. Re-confirm all refs at execution time.

## Implementation status — 2026-06-05 (branch `feature/process-loopback-input`)

**Delivered — MVP-A + MVP-B complete.** Verified: `cargo test` (68 lib tests),
`npx tsc --noEmit`, `npm test` (105 tests). Built against the `wasapi` 0.23
crate (system loopback + per-process via `new_application_loopback_client`);
shared-mode `autoconvert` delivers stereo f32 at the bus rate, so **no rate gate
and no resampler are needed for loopback** (the surround/rate guards apply only
to cpal device inputs).

| Issues | What landed |
|---|---|
| #11 | `InputSourceSpec` seam; `ensure_input_source` accepts synthetic ids |
| #12,#13,#14,#15 | `audio::loopback` — system + per-process WASAPI capture, wired into `mixer::start`, dropped/joined with the engine |
| #16,#17,#18 | `audio::session` enumeration, `list_audio_sessions` IPC + TS, frontend source-kind/name derivation |
| #19 | input DevicePicker offers "System sound" + live apps (`includeLoopbackSources`) |
| #21 | stable `app:<image>` ids resolved to a live PID at build time |
| #7,#8,#23 | CI (windows-latest Rust + Linux frontend), repo templates/labels, macOS/Linux research |

**Deferred — optional / post-MVP / tangential (not blocking the feature):**
- **#20 resampler** — affects only cpal *device* inputs at a mismatched rate
  (loopback is unaffected via `autoconvert`). RT-sensitive; warrants hardware
  verification. Current behavior: a clear `EngineError` on mismatch.
- **#22 shared capture per source** — pure efficiency (two buses capturing the
  same source open two WASAPI clients, which works today). A capture-manager
  refactor of the working ownership path; deferred to avoid unverifiable churn.
- **#9 / #10 virtual-cable app-labeling + guided setup** — largely superseded by
  direct loopback; the existing AMVC/CableNotice UI already covers cable setup.

**Not yet done:** a live-audio smoke test (`npm run tauri dev` on Windows with
playback) — the capture paths are compile- and unit-verified but not yet
exercised against real device audio.

## Purpose

Capture audio from a **specific Windows application** (Chrome tab, game, Discord) directly,
without forcing users to manually re-route each app through a virtual cable. On Windows this
uses the **WASAPI Process Loopback API** (`ActivateAudioInterfaceAsync` with
`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`), which `cpal` does not expose.

The current input model is keyed by an opaque `device_id: String` and the mixer reads each
input from a ring buffer whose producer side is source-agnostic. Two chokepoints bind that
string to a real cpal device. Generalize those, feed the ring from a Windows loopback
capture thread, and per-app capture drops in with a small blast radius.

**Two capture modes share this machinery.** *System loopback* (`sys:default`) captures the
whole default render endpoint — everything Windows plays — and is the smaller, lower-OS-bar
build (Win10 1803+, no session enumeration, no picker). *Process loopback* (`proc:<pid>`)
captures one app and needs the newer API plus a session list and picker. The product MVP
"system sound → virtual cable" is satisfied by system loopback **alone**; per-app is the
richer follow-on. Both ride the same id seam and the same source-blind ring buffer.

## Non-goals

- No macOS or Linux implementation (research only — see #23).
- No new audio DSP (compressor / gate / limiter / HPF).
- No resampler in the MVP (same-rate gate only; #20 lifts later).
- No new bus types, no preset schema bump in the MVP path (#21 handles persistence later).
- No virtual driver / kernel-mode work.
- No telemetry, no licensing changes.

## Milestone

**Per-App Audio Capture** — <https://github.com/Sdomit/AudioManager/milestone/1>

Does not renumber roadmap phases 9–18 in `docs/ROADMAP.md`. Slots alongside them.

## Issue map (#7 — #23)

| # | Track | Title | Labels |
|---|---|---|---|
| 7  | A1 | CI pipeline for Windows validation                       | scope:infra, enhancement |
| 8  | A2 | Repo templates and planning labels                       | scope:infra, documentation |
| 9  | B1 | App-labeled inputs for virtual-cable workflow            | scope:ui, scope:audio, enhancement |
| 10 | B2 | Capture-an-app guided setup for virtual cable            | scope:ui, documentation, enhancement |
| 11 | C1 | Refactor input sources with InputSourceSpec **(keystone)** | scope:audio, enhancement |
| 12 | C2 | Loopback module skeleton and platform gating             | scope:audio, platform:windows, enhancement |
| 13 | C3 | Implement WASAPI process loopback capture                | scope:audio, platform:windows, enhancement |
| 14 | C4 | Wire process source into mixer rebuild path              | scope:audio, enhancement |
| 15 | C5 | Add system loopback source                               | scope:audio, platform:windows, enhancement |
| 16 | D1 | Enumerate Windows audio sessions                         | scope:audio, platform:windows, enhancement |
| 17 | D2 | IPC commands and TypeScript wrappers for app capture     | scope:ipc, scope:audio, enhancement |
| 18 | E1 | Input source metadata end-to-end                         | scope:ui, scope:audio, enhancement |
| 19 | E2 | AppPicker UI and add-app flow                            | scope:ui, enhancement |
| 20 | F1 | Resampler for capture-rate to bus-rate conversion        | scope:audio, enhancement |
| 21 | F2 | Persist app sources with stable image-name keys          | scope:audio, enhancement |
| 22 | F3 | Shared capture per PID fan-out                           | scope:audio, enhancement |
| 23 | F4 | Research macOS and Linux ProcessCapture                  | scope:audio, enhancement |

## MVP paths

Two independent MVPs, smallest first. Pick by what the product needs now.

**MVP-A — System loopback → bus/cable** (ship first; matches the stated product MVP):
`#7, #11(lite), #12, #15` + a one-line input entry in the existing DevicePicker.
Captures the whole system into a bus at the same sample rate. **No** session enumeration
(#16), **no** AppPicker (#19), **no** process COM body (#13). Lower OS bar (Win10 1803+).
Directly satisfies "system sound → virtual cable."

**MVP-B — Per-app process capture** (richer follow-on):
`#7, #11, #12, #13, #14, #16, #17, #18, #19`.
User picks an app from a live list and captures it into a bus at the same rate.
Requires Win10 2004+ (build 19041).

`#11(lite)` = the `InputSourceSpec` seam with `Device` + `SystemLoopback` variants only; the
`Process` variant and PID plumbing land with MVP-B. Tier 0 (#9, #10) ships in parallel.
F-track (#20–#22) is post-MVP.

## Recommended implementation order

```text
Phase 0: Planning and CI
- #7
- #8

Phase 1: Source model foundation
- #11

Phase 2: Platform skeleton
- #12
- #16
- #17

Phase 3: Metadata and UI selection
- #18
- #19

Phase 4: Real capture
- #13
- #14

Phase 5: Stabilization
- #20
- #21
- #22

Parallel / optional
- #9
- #10
- #15  <- MVP-A: pull up. Depends only on #11(lite) + #12; no link to #13/#16/#18/#19.
- #23
```

**MVP-A fast path:** `#11(lite) -> #12 -> #15` ships system loopback without touching
Phase 3/4. When system-first is the goal, lift #15 out of "parallel/optional" — it has no
dependency on the process-capture body, session enumeration, or the AppPicker.

Rationale for landing **#18/#19 before #13/#14**: with #11 + #12 + #16 + #17 in place,
sessions can be enumerated and the IPC + UI surface can be exercised end-to-end against a
**stubbed** loopback (returning `EngineError "not yet supported"`). That validates the
picker, the descriptor wire-up, the source metadata, and the error surfaces **without**
the WASAPI/COM body. #13 then implements the body behind a stable, exercised contract;
#14 is the wire-up flip from stub error to real audio.

## Branch strategy

| Branch | Purpose | Base |
|---|---|---|
| `main` | stable | — |
| `plan/process-loopback-implementation` | **this** docs-only branch | `main` |
| `feature/process-loopback-input` | implementation work (recreate from clean `main` when starting) | `main` |
| `feature/<issue-slug>` (optional) | one branch per issue when a clean isolation is preferred | `main` or `feature/process-loopback-input` |

Rules:
- Always fork from **clean `main`** at the moment work starts (do not fork from a stale
  local branch — it eats parallel commits).
- Stop parallel git operations on a clone while a feature branch is active. Drive git
  from one place.
- Keep `feature/process-loopback-input` as the integration trunk for the feature; merge
  per-issue branches into it before merging up to `main` if you split that finely.
- **The existing `plan/process-loopback-implementation` and `feature/process-loopback-input`
  branches predate the amvc merge (#27–#29) and are behind `main`.** Do **not** merge them
  up — `git diff main..<branch>` shows ~2700 deletions that are only the missing amvc work,
  not intended removals. `feature/process-loopback-input` currently has zero commits ahead.
  Treat this doc as the sole artifact; recreate the feature branch from current `main`.

## Commit strategy

- Conventional Commits — observed scopes: `audio`, `graph`, `ui`, `recorder`, `infra`,
  `docs`.
  - Implementation: `feat(audio): ...` / `feat(ui): ...` / `feat(ipc): ...`
  - Refactor with no behavior change: `refactor(audio): ...`
  - CI / templates: `chore(infra): ...` / `chore(ci): ...`
  - Docs: `docs(audio): ...`
- One issue per PR when feasible. Squash-merge with `Closes #N` in the body.
- Keep each commit on a feature branch focused. Do not bundle unrelated fixes.
- Never `--no-verify`, never `--force-with-lease` on `main`.

## Testing and validation commands

Run before every commit and before opening a PR:

```bash
pnpm exec tsc --noEmit
cargo check --manifest-path src-tauri/Cargo.toml
cargo test  --manifest-path src-tauri/Cargo.toml
cargo fmt   --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
git diff --check
```

Per-issue smoke tests (manual, `pnpm tauri dev`) live in the issue body's "Definition of
Done" / "Smoke test" sections. CI in #7 runs the automated subset on `windows-latest`.

Hardware-dependent capture paths are `#[cfg(windows)]`-gated; the `ProcessCapture` trait
allows a mock implementation for unit tests.

## Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| `cpal` 0.15 does not expose WASAPI loopback | High | New `audio/loopback.rs`. System loopback (#15): the `wasapi` crate ships a ready loopback example. Process loopback (#13): `windows` crate directly (needs `ActivateAudioInterfaceAsync` + `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`). |
| Capture sample rate ≠ bus sample rate | Medium | MVP gates with clear `EngineError`; #20 adds `rubato` later. |
| PIDs are not stable across reboots — presets break | Medium | #21 persists stable image-name keys (`app:chrome.exe`) and resolves PIDs on load. |
| Process loopback needs Win10 2004 (build 19041) | Medium | #13 OS-version gate; graceful error; documented requirement. **Per-mode**, not global. |
| Do NOT gate system loopback on 19041 | Low | #15 needs only Win10 1803 (build 17134). #12's gate is per-mode so MVP-A keeps the lower bar. |
| Per-bus engines each open their own capture for the same source | Low | #22 introduces a shared capture manager keyed by source id. **Applies to `sys:default` too** — two buses loopback-ing the default render open two clients. |
| Reserved id prefixes (`proc:`, `sys:`) collide with a real device name | Very low | #11 refuses such device ids at registration with an explicit error. |
| Parallel git activity loses branches (already observed this session) | Medium | "One driver" rule above; the planning branch + this doc preserve the design even if work branches vanish. |
| Adding the `windows` crate increases build time | Low | Pulled in only under `[target.'cfg(windows)'.dependencies]`. |
| Audio callback regressions during the #11 refactor | Medium | #11 is pure refactor; existing device tests must stay green; output callback is untouched. |

## Architecture notes

### The seam

- **Universal key:** `InputChannel.device_id: String`
  (`src-tauri/src/audio/graph.rs:31`) flows through graph routing, sends, gain, meters,
  recorder taps, IPC, and UI unchanged. Encode process sources as a synthetic id:
  **`proc:<pid>`**. System loopback: **`sys:default`**.
- **Ring buffer is source-blind:** the output callback pops `f32` from `consumers[i]`
  (`src-tauri/src/audio/mixer.rs:411`). A capture thread that fills the same ring needs no
  callback changes.

### The two chokepoints to generalize (covered by #11)

1. `src-tauri/src/lib.rs:159` `ensure_input_name` — rejects ids not in
   `list_input_devices()`. → `ensure_input_source` that also accepts `proc:` / `sys:` ids.
2. `src-tauri/src/audio/mixer.rs:271` `host.input_devices().find(name)` → branch on a
   typed `InputSourceSpec`.

### Keystone Rust type (introduced in #11)

```rust
// audio/source.rs
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputSourceSpec {
    Device { name: String },
    Process { pid: u32, include_tree: bool },
    SystemLoopback,
}
pub const PROC_PREFIX: &str = "proc:";
pub const SYS_LOOPBACK_ID: &str = "sys:default";
```

`InputSourceSpec::parse(id)` /`to_id()` round-trip the synthetic id scheme.
`MixerInput` / `MixerInputInfo` carry a `source: InputSourceSpec` derived from the id in
`rebuild_bus`; `mixer::start` matches on the variant.

### New module added in #12 (`#[cfg(windows)]` only)

`src-tauri/src/audio/loopback.rs` — `ProcessCapture` trait + Windows skeleton. Real
WASAPI body lands in #13. Reuse from `recorder.rs`: thread spawn-before-publish,
`stop_flag` + join teardown, `ActiveTap.push()` NaN/Inf/clamp sanitization, atomic
dropped/written counters.

Crate choice is per-mode: **system loopback (#15)** can use the `wasapi` crate's loopback
example for a fast path; **process loopback (#13)** needs the `windows` crate directly for
`ActivateAudioInterfaceAsync`. If both ship, `windows` covers both and avoids two deps —
decide at #12.

### Capture loop correctness (#13 / #15)

The Windows capture thread must handle, beyond the happy path:

- **Silent / idle render:** when nothing plays, `GetNextPacketSize` returns 0 — sleep
  ~5 ms and continue; do not busy-spin. The ring drains and the output callback pops
  `0.0` → silence. Correct; no priming needed.
- **`AUDCLNT_BUFFERFLAGS_SILENT`:** treat the packet as zeros regardless of buffer
  contents.
- **Mix format channels > 2** (surround render endpoint): MVP rejects with a clear
  `EngineError`, matching the existing mixer `> 2ch` guard; stereo downmix is later work.
- **Sample format:** shared-mode mix format is usually `IEEE_FLOAT` (f32, no conversion).
  Handle `WAVE_FORMAT_EXTENSIBLE` + float subformat; convert 16-bit PCM → f32 if seen;
  error on anything else.
- **Rate gate:** render mix rate must equal the bus/output rate (same hard error as cpal
  inputs, `mixer.rs:280`); #20 lifts this with a resampler.

### IPC surface (added in #17; no Tauri capabilities file needed)

- `list_audio_sessions() -> Result<Vec<AudioSessionInfo>, EngineError>`
- `add_process_input(pid, include_tree) -> Result<Vec<InputChannel>, EngineError>`
  (or generalize `add_input` to take a source descriptor).

### Frontend (#18 / #19)

- `InputSourceKind` already has `"app" | "system" | "loopback" | "virtual"` —
  no enum change.
- `iconForKind` already renders an app icon — no change.
- Backend `InputChannel` gains `source_kind` (+ optional `label`/`app_name`,
  serde-default for preset compat). Mirror in `src/types/engine.ts`.
  `adaptInput`/`inputKindFor` read `source_kind` directly.
- New AppPicker (or DevicePicker `kind:"app"` mode) backed by `list_audio_sessions`.

## Future start instructions

When implementation begins later:

1. **Verify state.** From clean `main`, with no in-progress merge/rebase/cherry-pick:
   ```bash
   git status --short --branch
   git checkout main
   git pull --ff-only origin main
   ```
2. **Recreate the feature branch from clean `main`:**
   ```bash
   git checkout -b feature/process-loopback-input
   ```
   Do **not** fork from a stale local branch.
3. **Start with Issue #11.** Do **not** start with #13. The keystone refactor is a
   pre-requisite for every other backend issue (#12, #13, #14, #15, #16). Without it,
   later PRs become much larger and more conflict-prone.
   - **Shipping MVP-A (system loopback) only?** Do `#11(lite)` — `Device` + `SystemLoopback`
     variants, skip the `Process` variant — then `#12 → #15`. Stop there; MVP-B adds the
     rest later on the same seam.
4. **Keep each issue in a small PR when feasible.** Phase 0 → Phase 5 in order; only
   parallel/optional items (#9, #10, #15, #23) may run alongside.
5. **Run the validation suite** above before every commit. Hook results into CI (#7).
6. **Stop parallel git operations** on this clone while a feature branch is live —
   branches and HEAD have shifted ~6× during this planning session due to parallel
   activity. One driver per clone.
