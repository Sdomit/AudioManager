# PLAN — Record Node + Mixer Node (graph-based recording)

Status: proposed (plan only, not started)
Branch target: feature branch off `main`
Workflow: numbered phases, plan-first, Codex-review-gated, explicit staging, no push until review.

## Goal

Add two first-class graph nodes:

- **Record node** — a sink you plug one or many sources into; records to disk with
  full per-recording settings.
- **Mixer node** — plug multiple inputs, sum them, feed the Record node (and
  optionally a device). Can run **silent** (no output device) for record-only use.

## What already exists (reuse, do not rebuild)

Confirmed by codebase map (2026-06-30):

- **Recorder backend** is full-featured: `src-tauri/src/audio/recorder.rs`.
  - `RecordFormat` = Float32 / Int24 / Int16 (WAV via `hound`, hand-rolled int24).
  - `TapSpec` = `InputPre` / `InputPost` / `BusOut` (records one source).
  - `RecorderHandle` per recording; ring buffer per tap (~96k frames), writer thread,
    samples/bytes/dropped atomics, `stop()` finalizes WAV.
  - `RecorderSettings` JSON at `app_data_dir/recorder_settings.json` (dir + format).
  - 12 Tauri commands (`lib.rs:1650–1854`) + 12 TS wrappers (`commands.ts:235–278`).
  - `RecordingsPanel.tsx` UI: format dropdown, dir picker, active list, file browser.
- **Mixer runtime** = `src-tauri/src/audio/mixer.rs` `MixerEngine` (8 inputs max,
  per-input gain/mute/DSP via seqlock, per-input + bus metering, spectrum/LUFS).
  A **Bus already is a mixer node** (N inputs → 1 out). Recording a multi-input mix
  **already works**: route inputs → bus → record `BusOut` tap.
- **Graph UI model** = `src/components/audio-manager/graph.ts` (forward-looking DAG;
  `NodeKind` = input|bus|group|splitter|fx|meter; not yet wired to rendering).
- **Rendering** = `NodeView.tsx` (bipartite inputs→buses canvas, drag to route).
- **Persistence** = `PresetFileV2` (`presets/mod.rs`) already serializes full graph.

Net: the gap is mostly **presentation** (draggable Record/Mixer nodes) plus three real
backend extensions (silent mixer, compressed formats, per-node settings).

## Decisions (confirmed with user)

1. **Formats**: WAV (keep) **+ FLAC (lossless) + lossy (Opus/MP3)**.
2. **Mixer node**: can record **silently** (no output device) — needs optional-output bus.
3. **Settings**: **global default + per-node override**.
4. **UI**: **extend existing `NodeView`** (do not build a new DAG canvas yet).

## Node model

- **Mixer node** = a Bus with `output: Option<device>`.
  - `Some(device)` → normal audible bus (existing path).
  - `None` → **silent record bus**: a timer thread pumps summing at a nominal rate,
    feeds bus-out tap; no output stream opened.
- **Record node** = a sink wrapping exactly one `TapSpec`.
  - 1 input edge → direct tap (`InputPre`/`InputPost`, or `BusOut` if the source is a
    mixer).
  - **>1 input edge → backend auto-provisions a hidden silent mixer**, routes those
    inputs in, record node taps its `BusOut`. Lets the user "plug multiple inputs
    straight into the record node" while reusing the mixer summing path.
  - Explicit Mixer node is also available when the user wants visible shared faders/meter.

Edge rules (NodeView): `input → mixer`, `input → record`, `mixer → record`. Record node
has no output port. Cycles already rejected by `graph.ts`.

## Recording settings (full set)

### Per-node (override global default)
- Output directory
- Filename pattern — tokens `{date} {time} {timestamp} {node} {source} {uuid} {counter}`
- Container/format — WAV | FLAC | Opus | MP3
- Bit depth (WAV/FLAC) — 16 / 24 / 32f (32f = WAV only; FLAC max 24)
- Sample rate — follow-source / 44100 / 48000 / 96000 (resample if differs)
- Channels — stereo / mono (downmix)
- Lossy quality — Opus kbps, MP3 kbps or VBR quality
- FLAC compression level — 0–8
- Tap point (input source) — pre-gain / post-gain (existing `InputPre`/`InputPost`)

### Global-only
- Default directory + default format + per-format default quality
- Filename collision policy (counter suffix)
- Arm/record-on-start behavior

### Deferred (Phase R6, only if wanted)
- Auto-split by max size or max duration
- Disk-space guard (stop at N MB free)
- Container metadata tags (title/date)

## Phases

**Execution order (chosen): R4 → R3 → R2 → R1.** R1 (silent bus, RT refactor) is the
riskiest and nothing depends on it, so it ships last. Note: buses are a fixed enum set
(`BusId::B1…`) already rendered as `BusNode`, so the **Mixer node ≈ existing BusNode**;
the genuinely new UI piece is the **Record node**.

Each phase: implement → verify gate → Codex review → stage. No push until review passes.

### R1 — Backend: optional-output mixer ("silent record bus")
- `mixer.rs` / bus runtime: make output device `Option`. When `None`, drive summing
  from a monotonic timer thread at nominal rate; reuse existing per-input gain/mute/DSP,
  metering, and tap feed. `// ponytail:` nominal-rate timer clock; upgrade to device
  clock only if live monitoring of a silent bus is added.
- IPC: create bus with no output; `set_bus_output(busId, deviceOrNull)`.
- **Verify**: silent bus + 2 inputs → `BusOut` tap yields summed samples; no audio
  device opened; cargo + clippy green.

### R2 — Backend: format expansion (FLAC + Opus + MP3)

Split into a no-dep refactor (R2a, DONE) + one encoder per slice. Each encoder is a
`SampleSink` impl; the writer loop is untouched after R2a.

**R2a — `SampleSink` trait refactor (DONE, committed).**
- `trait SampleSink { write(f32); bytes_estimate()->u64; finalize()->u64 }` +
  `WavSink` (hound). `run_writer` is generic over `Box<dyn SampleSink>`. No new deps,
  behavior-preserving. cargo test 294 pass.

**Per-encoder dep findings (verified against current Cargo.toml):**
- **FLAC** → streaming needs `flac-bound` (binds libFLAC → C/CMake build dep). Pure-Rust
  `flacenc` buffers the whole stream in RAM (bad for long live takes) — rejected for the
  streaming sink. FLAC = lossless, self-contained container (no Ogg).
- **Opus** → `audiopus =0.3.0-rc.0` is ALREADY a dep (phone decode); its `Encoder` is
  usable. BUT: needs resample to 48 kHz (reuse `audio/resampler.rs`), 2.5–60 ms framing,
  AND an Ogg container to make a playable `.opus`/`.ogg` (new `ogg` crate). No new C dep.
- **MP3** → `mp3lame-encoder` (binds libmp3lame → C dep), streaming, self-contained.

**Remaining slices (pick by dep tolerance):**
- **R2b Opus** — lowest *new-dep* cost (only `ogg`; audiopus already built). Needs
  resampler + framing. Good "compression" default.
- **R2c FLAC** — `flac-bound` (C/libFLAC). Lossless. Add only if a C dep is acceptable.
- **R2d MP3** — `mp3lame-encoder` (C/libmp3lame). Add last; drop on MSVC friction.

Each slice: add the crate, add `<X>Sink: SampleSink`, extend `RecordContainer` +
`RecordConfig`/`RecorderSettings`, wire a resampler/downmix when target rate/channels
differ from source, then verify the file opens + correct duration. Do NOT guess crate
versions — resolve them when adding.

### R3 — Backend: settings model (global default + per-node override) + IPC
- Extend `RecorderSettings` (global defaults) + new per-node `RecordConfig` (override
  subset) stored on the Record node / `RecorderHandle`.
- IPC: `get_recording_defaults`, `set_recording_defaults`,
  `start_recording(spec, config?)`, `update_record_node_config`.
- Persist defaults in `recorder_settings.json`; per-node config in `PresetFileV2`.
- **Verify**: JSON round-trip; per-node override beats global; cargo green.

### R4 — Frontend: Record + Mixer nodes in NodeView
- Extend `NodeKind` + `NodeView.tsx`: Record node card (arm/REC, elapsed, format badge,
  settings gear) and Mixer node card (faders + meter, output = device|silent).
- Implement edge rules + the ">1 input → hidden silent mixer" auto-provision.
- Wire to R1–R3 IPC.
- **Verify**: drag inputs → mixer → record, hit record, file appears; vitest + tsc green.

### R5 — Frontend: settings UI
- `RecordingsPanel`: global defaults section (dir, format, quality, filename pattern,
  channels, sample rate).
- Per-Record-node settings popover: override fields.
- **Verify**: set per-node format, record, correct container written.

### R6 — Polish + deferred guards (optional)
- Auto-split, disk-space guard, metadata tags. Only if requested.

## Risks / open notes
- Opus/MP3 are frame-based, fixed/limited rates → resampler is mandatory in R2; pick one
  resampler (e.g. `rubato`, verify) and share it.
- MP3 (`mp3lame-encoder`) adds a C build dep; FLAC via `flacenc` avoids that. If MSVC/CMake
  friction appears, ship WAV+FLAC+Opus and defer MP3.
- Silent-bus timer clock can drift vs input device clocks; ring buffers already absorb
  jitter, acceptable for recording. Revisit only if silent-bus monitoring is added.

## Verify gate (every phase)
- `cargo check` / `cargo clippy` / `cargo test` in VS2026 dev shell with
  `$env:CMAKE_POLICY_VERSION_MINIMUM=3.5` (see memory `cargo-build-vs2026-cmake`).
- `tsc --noEmit` + `vitest` via Bash.
