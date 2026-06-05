# Streaming DSP & Latency Implementation Plan

> Planning document. No code is implemented as part of this commit.
> Source of truth for execution order is GitHub issues **#32–#38** on branch
> `codex/streaming-dsp-latency-roadmap`. This file is the human-readable index
> and the deep-dive for the foundation issue **#32**.
>
> Line refs captured against branch `codex/streaming-dsp-latency-roadmap` at
> tip `98754ab` (per-input DSP infrastructure). Re-confirm at execution time.

## Roadmap index (#32 — #38)

| # | Title | Depends on | Notes |
|---|---|---|---|
| 32 | Expose realtime DSP chains in API and UI | — | **Foundation.** Config model + live-update path + IPC + UI + preset migration. Everything else reuses its seams. |
| 33 | Stream Voice preset + protected B1 chain | #32 | One-click HPF→gate→EQ→comp→limiter on B1; final limiter at ~-1 dBFS. |
| 34 | Stereo controls: pan, balance, mono, phase, center | #32 | Per-input/per-send pan, mono sum, L/R swap, phase invert, mid/side. Rides #32's config + IPC + atomic-update pattern. |
| 35 | Latency modes, buffer controls, dropout telemetry | — | `Stable`/`Low`/`Ultra Low`; CPAL fixed buffer; ring-fill/underrun/overrun counters. Engine/buffer layer, independent of #32. |
| 36 | Sample-rate conversion + clock-drift upgrade | — | Benchmark linear vs `rubato`; drift-aware ratio from ring-fill trend. Resampler layer, independent. |
| 37 | Noise-suppression spike: gate / RNNoise / WebRTC APM | #32 (gate) | Research-first; prototype one path behind a feature flag; decide deps before shipping. |
| 38 | Streaming meters: RMS, LUFS, true peak | — | Bus analysis + `too quiet`/`healthy`/`too hot` advice. Analysis off the RT path. |

Critical path: **#32 → #33**. #34/#35/#36/#38 parallelize after #32 lands the
config + IPC + atomic-update pattern. #37 is a spike that gates a heavy
dependency decision and should run before any RNNoise/WebRTC code is merged.

Does not renumber the roadmap phases in `docs/ROADMAP.md` — slots alongside them.

---

# Issue #32 — Expose realtime DSP chains in API and UI

## Purpose

The backend already ships the DSP primitives — `DspChain`, `NoiseGate`,
`BiquadFilter`, `Compressor`, `Limiter` (`src-tauri/src/audio/dsp/`, landed in
`98754ab`). But `mixer::start` builds **empty** per-input chains
(`src-tauri/src/audio/mixer.rs:438`) and there is no way to configure, apply,
persist, or live-update them. #32 adds a serializable DSP config model, a
lock-free live-update path into the running audio callback, IPC commands, React
controls, and preset persistence with backward compatibility.

## Scope

- Serializable DSP config types for **input-level** and **bus-level** chains.
- Effects covered: high-pass, gate/expander, parametric EQ, compressor, limiter
  — enable flag + parameters per effect.
- Apply chains safely on engine rebuild, with clamped params and predictable
  defaults.
- A live-update path that does **not** lock, allocate, or block inside the audio
  callback.
- React controls in the input and bus detail surfaces.
- Persist DSP settings in presets with migration / backward compatibility.
- Focused tests: config clamping, preset migration, command behavior, atomic
  update.

## Non-goals (deferred to later issues)

- No Stream Voice one-click preset or B1 protection UI (**#33**).
- No pan/balance/mono/phase/mid-side (**#34**) — though the config struct should
  leave room so #34 is additive, not a refactor.
- No latency modes, buffer sizing, or dropout telemetry (**#35**).
- No resampler quality change (**#36**).
- No RNNoise / WebRTC APM (**#37**).
- No LUFS / true-peak meters (**#38**).
- No new bus types, no arbitrary user-ordered chains — the effect set and order
  are fixed in #32 (see architecture).

## Architecture

### The crux: lock-free live update into the audio callback

Today `dsp_chains: Vec<DspChain>` is **local to the output-stream closure**
(`mixer.rs:438`) — built once, never reachable from the IPC thread. The
acceptance criterion "live-update path that does not lock, allocate, or block
inside the audio callback" rules out rebuilding `Box<dyn DspEffect>` chains and
handing them across a channel (that allocates, and dropping the old chain on the
RT thread frees memory on the RT thread).

**Chosen design — fixed effect slots driven by atomic parameter blocks**, an
exact extension of the existing `InputSlotShared` gain/mute atomics
(`mixer.rs:41`) read once per block (`mixer.rs:476`).

- Each input owns a **fixed** ordered chain, allocated once before the stream
  plays (allocation off the RT path is fine): `HPF → Gate → EQ(N bands) →
  Compressor → Limiter`. No `Vec` growth at runtime; effects are toggled, never
  added or removed.
- Add `InputDspShared` to the `Arc<Vec<InputSlotShared>>` family: a `generation`
  counter plus, per effect, an `AtomicBool enabled` and `AtomicU32` (f32 bits)
  parameter fields.
- **Biquad coefficients are precomputed on the IPC thread** (HPF + each EQ band)
  and published as five `AtomicU32` each (`b0,b1,b2,a1,a2`). The RT thread loads
  coefficients — no `sin/cos` in the callback. Gate/comp/limiter one-pole
  attack/release coefficients are likewise precomputed off-thread; their
  per-sample math is already transcendental-free.
- **Publish protocol (seqlock, not a plain dirty flag).** A coefficient set spans
  multiple atomics, so the callback must never observe a half-published mix (a
  torn HPF/EQ set can destabilize an IIR filter). The IPC thread publishes as a
  seqlock: store `generation` to an **odd** value (`Release`), write all
  param/coefficient field atomics (`Relaxed`), then store `generation` to the
  next **even** value (`Release`). The callback, once per block: load `generation`
  (`Acquire`); if it is **odd** (publish in flight) it keeps its previous local
  config for this block — **no spinning, no lock**. Otherwise it reads the fields
  (`Relaxed`) and re-loads `generation` (`Acquire`), accepting the new values only
  if that second read is unchanged and even; a mismatch means a publish raced, so
  it again keeps the previous config and retries next block. Only the
  `generation` publish/observe uses `Release`/`Acquire`; field atomics stay
  `Relaxed`. *(A double/triple-buffered immutable snapshot with an atomic
  published index is an acceptable alternative.)*
- On accepting a new config, the callback calls `reset()` on any slot whose
  `enabled` just flipped false→true (clears stale envelope/filter state so
  re-enabling does not pop). Steady state: one `Acquire` load per block,
  unchanged per-sample cost.
- **Effect setters are a step-2 prerequisite.** `BiquadFilter`, `NoiseGate`,
  `Compressor`, and `Limiter` currently expose only constructors + `set_enabled`.
  Step 2 adds in-place setters (or thin fixed-slot wrappers) so the per-block
  reload updates private params/coefficients **without reconstructing** the
  effect — reconstruction would discard filter history / envelope state and pop.

This is lock-free, allocation-free, and block-free, and reuses the proven
once-per-block atomic-load pattern. `DspEffect::is_enabled()` already exists
(`dsp/mod.rs:16`) and gates each slot.

Bus-level chains use the same mechanism on `MixerSharedMeters`
(`mixer.rs:64`): a `BusDspShared` block processed **post-sum, pre-clip** (just
before the existing clamp at `mixer.rs:557`), so #33's final B1 limiter drops in
without further plumbing.

### Config model (serde, pure data)

New `src-tauri/src/audio/dsp/config.rs`:

```rust
#[derive(Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct DspConfig {       // per-input chain
    pub hpf: HpfConfig,
    pub gate: GateConfig,
    pub eq: EqConfig,        // fixed MAX_EQ_BANDS, each enable+freq+gain+q
    pub compressor: CompressorConfig,
    pub limiter: LimiterConfig,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct BusDspConfig { pub limiter: LimiterConfig, /* room for #33 */ }
```

Each sub-config carries `enabled: bool` + params + `Default`, and a `clamp()`
that bounds every parameter to a safe range (frequencies to a fixed audible
window, ratios ≥ 1, gains to a sane dB window, compressor makeup as a ±24 dB
trim, times ≥ 0). Clamp runs on the IPC thread before the atomics are stored, so
the RT thread always sees valid values. The config is sample-rate independent;
**step 2 must additionally clamp each frequency to `< Nyquist` (mandatory)** when
the engine sample rate is known, before computing coefficients. EQ uses a fixed
`MAX_EQ_BANDS` (4 for #32 — mud / box / presence / sibilance) with per-band
enable flags to keep the slot count fixed; the serde shape is a `Vec` that
`clamp()` pads/truncates to exactly that many bands.

### Server-side storage

- Per-input: add `dsp: DspConfig` to `InputChannel` (`graph.rs:30`),
  `#[serde(default)]` so existing graph/preset data deserializes.
- Per-bus: add `dsp: BusDspConfig` to the bus config held in `BusRuntime`
  (`state.rs:17` → `bus.config`).

### IPC commands (follow the `set_input_gain` pattern, `lib.rs:653`)

- `set_input_dsp(device_id, DspConfig) -> Result<Vec<InputChannel>, EngineError>`
- `set_bus_dsp(bus_id, BusDspConfig) -> Result<(), EngineError>`
- Getters fold into existing `list_inputs` / `get_system_status` payloads.

Each command: lock `inner`, clamp the config, store it on the graph/bus config,
then — if that bus has a live `engine` — push params into the engine's atomics
and bump the generation counter. **No engine rebuild**, exactly like
`set_input_gain` calling `engine.update_gain` (`lib.rs:675`). New engine method
`update_input_dsp(device_id, &DspConfig)` / `update_bus_dsp(&BusDspConfig)`
mirrors `update_gain` / `update_bus_volume` (`mixer.rs:125` / `mixer.rs:136`).
On rebuild (`rebuild_bus`, `lib.rs:145`), `mixer::start` seeds the atomics from
the stored config so effects survive a device change.

Register all new commands in the `invoke_handler!` list (`lib.rs:1257` area).

### Frontend

- `src/types/engine.ts`: mirror `DspConfig` / `BusDspConfig` and sub-types
  alongside `InputChannel` (`engine.ts:102`) and `BusStatus` (`engine.ts:74`);
  add optional `dsp?` fields.
- `src/utils/`: `setInputDsp` / `setBusDsp` wrappers (invoke), matching the
  existing gain/bus wrappers.
- UI: a `DspPanel` component mounted in `InputDetail.tsx` after the Master
  section (~line 144) and in `BusDetail.tsx` after Master (~line 154). Per-effect
  enable toggle + sliders, with debounced `set_input_dsp` / `set_bus_dsp` calls
  (same debounce discipline as the gain sliders). Defaults render a flat,
  bypassed chain.

### Preset persistence + migration

- Add `#[serde(default)] dsp: DspConfig` to `PresetInputV2` (`presets.rs:51`) and
  `#[serde(default)] dsp: BusDspConfig` to `PresetBusV2` (`presets.rs:59`).
- **No schema bump.** Adding `serde(default)` fields is backward compatible:
  existing V2 files (no `dsp` key) load as `DspConfig::default()` (flat,
  bypassed). `build_preset_v2` writes the live config; `apply_preset_state`
  applies it. V1→V2 migration (`presets.rs:395`) is unaffected — migrated presets
  get default DSP. A test asserts an old V2 fixture loads with bypassed defaults.

## Review decisions (Codex, 2026-06-05)

- **Architecture approved** with the seqlock publish protocol amendment above
  (P1). Fixed slots, atomics read once per block, bus post-sum/pre-clip — correct
  realtime-safe shape.
- **P2:** effect setter/wrapper APIs are an explicit step-2 prerequisite (the
  current effects expose only constructors + `set_enabled`).
- **Q1 — EQ bands:** `MAX_EQ_BANDS = 4` (not 3) for a broadcast voice chain.
- **Q2 — preset schema:** no V3 bump; `#[serde(default)] dsp` on V2 is approved;
  keep the old-V2 fixture test.
- **Params:** compressor `makeup_db` widened to ±24 dB (acts as a trim). Nyquist
  frequency clamp in step 2 is mandatory. Effect order accepted; #34 inserts
  stereo/pan/MS post-EQ, pre-comp.

## Sub-step / PROMPT order

Each step is one focused commit; run the validation suite before each.

1. **Config model** — `dsp/config.rs`: `DspConfig`, `BusDspConfig`, sub-configs,
   `Default`, `clamp()`. Unit tests for clamping. (Rust only, no wiring.)
   **— delivered `b49a600` + review fixups (4 bands, ±24 dB makeup); 11 tests.**
2. Split because Codex was live-editing `mixer.rs` (bulk `pop_slice` rework):
   - **2a — effect setters** — in-place `set_coeffs` on the four effects +
     off-thread `*::compute` coefficient helpers, state-preserving.
     **— delivered `feda015`; 9 tests.**
   - **2b-core — seqlock module** — `dsp/live.rs`: `InputDspShared` /
     `BusDspShared` (seqlock publish), `InputDspSlots` / `BusDspSlots`
     (fixed-slot chains), Nyquist-clamped publish, reload-on-change with
     reset-on-reenable. **— delivered `324e719`; 6 tests incl. concurrent
     no-tear stress.**
   - **2b-wiring — GATED on `mixer.rs`** — construct the shared `Arc` + slots in
     `mixer::start`, call `reload_if_changed` + `process` in the callback,
     engine `update_input_dsp` / `update_bus_dsp`. Waits for Codex's bulk-drain
     change to land so it rebases on top.
3. **Server storage** (`dsp` on `InputChannel` + `BusConfig`/`BusStatus`,
   `AudioGraph::set_input_dsp`) **— delivered `df3611b`; 7 tests.**
   **IPC commands** (`set_input_dsp` / `set_bus_dsp`, seed atomics on
   `rebuild_bus`, register handlers) **— GATED**: they call the engine
   `update_*_dsp` methods from 2b-wiring.
4. **TS types** (`engine.ts`) **— delivered `e276ea6`.** Invoke wrappers
   (`setInputDsp` / `setBusDsp`) wait on the step-3 commands.
5. **UI** — `DspPanel` in `InputDetail` + `BusDetail`, debounced. Waits on the
   step-3 commands + step-4 wrappers.
6. **Presets** — `serde(default)` dsp fields, build/apply, old-file-loads test.
   **— delivered `c6c08a5`; 3 tests.**
7. **Docs + verification** — update this file's status, `cargo test` / `tsc` /
   `npm test` counts, manual `npm run tauri dev` smoke (audible effect change
   with no dropout).

Steps 1–3 are the backend foundation #33/#34 build on; 4–6 complete the
end-to-end criteria; 7 closes the issue.

**Delivered (collision-free):** 1, 2a, 2b-core, 3-storage, 4-types, 6.
**Gated on Codex committing `mixer.rs`:** 2b-wiring → 3-IPC → 4-wrappers → 5-UI → 7.

## Testing and validation commands

Run before every commit and before opening a PR:

```bash
pnpm exec tsc --noEmit
cargo check  --manifest-path src-tauri/Cargo.toml
cargo test   --manifest-path src-tauri/Cargo.toml
cargo fmt    --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
git diff --check
```

Manual smoke (`npm run tauri dev`, Windows, with playback): toggle gate/HPF/comp
on a live input and on B1, confirm the change is audible and the meters move with
**no dropouts or clicks** while sliders are dragged (exercises the live-update
path under continuous generation bumps).

## Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Param reload in the callback introduces a click/zipper | Medium | Reload only on generation change; `reset()` on re-enable; per-block (not per-sample) coefficient swap; smooth gain-like params if audible. |
| Biquad coefficient compute creeps into the RT thread | Medium | Precompute all coeffs (HPF + EQ bands) on the IPC thread; RT loads coeffs only. Enforce by keeping `sin/cos`/`tan` out of the callback. |
| Allocation sneaks into the RT path via chain rebuild | High | Fixed-slot chain allocated before `stream.play()`; effects toggled via atomics, never pushed/removed at runtime. |
| Unbounded params cause NaN/Inf or instability | Medium | `clamp()` on the IPC thread before storing; clamp frequencies < Nyquist, ratios ≥ 1, Q in a stable window; existing tap NaN/Inf guard remains. |
| Old presets break on load | Low | `serde(default)` dsp fields, no schema bump; explicit old-V2-fixture test. |
| EQ band count drift between serde Vec and fixed RT slots | Low | IPC pads/truncates to `MAX_EQ_BANDS`; band count is a constant, not user-extensible in #32. |
| Effect order disputes with #34 (stereo) placement | Low | #32 fixes order HPF→Gate→EQ→Comp→Limiter; #34 inserts pan/MS at a defined point (post-EQ, pre-Comp) additively. |

## Future start instructions

1. From the branch tip, confirm a clean tree (the AMVC device-toggle work is
   already its own commit; do not bundle DSP into it).
2. Land sub-steps 1→7 in order, one commit each, validation suite green before
   each commit.
3. **Codex-review-gated:** do not push until the plan and each step are reviewed.
4. Keep #33–#38 out of this issue; this branch's #32 commits establish the
   patterns they extend.
