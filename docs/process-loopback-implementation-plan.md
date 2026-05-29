# Process Loopback Implementation Plan

> Planning document. No code is implemented as part of this branch.
> Source of truth for execution order is GitHub milestone **Per-App Audio Capture**
> and the issues listed below. This file is the human-readable index.

## Purpose

Capture audio from a **specific Windows application** (Chrome tab, game, Discord) directly,
without forcing users to manually re-route each app through a virtual cable. On Windows this
uses the **WASAPI Process Loopback API** (`ActivateAudioInterfaceAsync` with
`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`), which `cpal` does not expose.

The current input model is keyed by an opaque `device_id: String` and the mixer reads each
input from a ring buffer whose producer side is source-agnostic. Two chokepoints bind that
string to a real cpal device. Generalize those, feed the ring from a Windows loopback
capture thread, and per-app capture drops in with a small blast radius.

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

## MVP path

`#7, #11, #12, #13, #14, #16, #17, #18, #19`

User picks an app from a live list and captures it into a bus at the same sample rate.
Tier 0 (#9, #10) and Tier 1 (#15) ship in parallel. F-track is post-MVP.

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
- #15
- #23
```

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
| `cpal` 0.15 does not expose WASAPI loopback | High | New `audio/loopback.rs` against the `windows` crate (#12, #13). |
| Capture sample rate ≠ bus sample rate | Medium | MVP gates with clear `EngineError`; #20 adds `rubato` later. |
| PIDs are not stable across reboots — presets break | Medium | #21 persists stable image-name keys (`app:chrome.exe`) and resolves PIDs on load. |
| OS version below Windows 10 2004 (build 19041) lacks the API | Medium | #12 OS-version gate; graceful error; documented requirement. |
| Per-bus engines each open their own capture for the same PID | Low | #22 introduces a shared capture manager keyed by PID. |
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

1. `src-tauri/src/lib.rs:158` `ensure_input_name` — rejects ids not in
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
4. **Keep each issue in a small PR when feasible.** Phase 0 → Phase 5 in order; only
   parallel/optional items (#9, #10, #15, #23) may run alongside.
5. **Run the validation suite** above before every commit. Hook results into CI (#7).
6. **Stop parallel git operations** on this clone while a feature branch is live —
   branches and HEAD have shifted ~6× during this planning session due to parallel
   activity. One driver per clone.
