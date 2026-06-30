# Handoff — Record node + Mixer node + recording settings
20260630-185847 · repo AudioManager · branch claude/elegant-borg-8baf4a

## Goal
Graph-based recording: a **Record node** (plug any input or a bus into it) + **Mixer node**
(= existing BusNode, N inputs→1 out) with full recording settings (dir, format/compression,
bit depth, etc.). Full plan: `docs/PLAN-record-mixer-nodes.md`. Order: R4→R3→R2→R1.

## Status
- Done + committed + green:
  - **R4** Record node in NodeView (`805da39`) — local UI node (floating-fx pattern), source
    dropdown (input→input_pre / bus→bus_out), reuses RecordButton; tsc + vitest 205.
  - **R3** `recorder::RecordConfig{dir?,format?}` + pure `resolve()` + `start_recording(spec,config?)`
    (`805da39`) — per-node override beats global; backward-compatible; cargo test 297.
  - **R2a** `SampleSink` trait refactor of the writer, WAV-only, no new deps (`0a3546e`); cargo test 294.
- In progress: none (clean tree).
- Blocked: none.

## Next step
**R2b — Opus encoder.** Add `OpusSink: SampleSink`: `audiopus` (=0.3.0-rc.0) already in tree;
add the `ogg` crate for the container; resample to 48 kHz via `audio/resampler.rs`; buffer
interleaved f32 into 20 ms frames (960/ch @48k), encode, write Ogg pages. Then extend
`RecordContainer` + `RecordConfig`/`RecorderSettings`. (Then R2c FLAC=flac-bound/libFLAC,
R2d MP3=mp3lame-encoder, R1 silent bus.)

## Key files
- `src-tauri/src/audio/recorder.rs` — `SampleSink` trait + `WavSink` (~L427); `run_writer` drains
  ring → sink; `RecordConfig::resolve` (~L645); `start_recorder` builds the sink (~L335).
- `src-tauri/src/lib.rs` — `start_recording(spec, config?)` (~L1680); recording IPC cluster ~1655-1842.
- `src/components/audio-manager/NodeView.tsx` — Record node: `record:` prefix, `recordNodes` map,
  render loop (search "Record nodes"), context-menu "+ Record node".
- `src/types/engine.ts` — `RecordConfig`, `TapSpec`, `RecorderSettings`. `src/ipc/commands.ts` — `startRecording`.
- `src-tauri/src/audio/resampler.rs` — `Resampler`/`LinearResampler` (reuse for R2b-d).

## Decisions & gotchas
- Mixer node = existing BusNode (buses are fixed enum BusId; nothing new). Multi-input mix records
  today: inputs→bus→record bus_out.
- R3 deferred filename-pattern/channels/sample-rate to R2 (need resampler/encoders).
- Each new format needs a dep: Opus→ogg crate, FLAC→libFLAC (C), MP3→libmp3lame (C). Pure-Rust
  `flacenc` buffers whole stream → rejected for live. Don't guess crate versions.
- R1 is the riskiest (RT hot-path: extract the mixer output-callback closure, drive via timer thread
  when no output device). Save for last. `bus.rs:111` currently blocks no-device engine start.
- Worktree has NO node_modules: run tsc/vitest via the main repo's binaries
  (`node C:/Users/sarma/Documents/GitHub/AudioManager/node_modules/...`).

## Resume
- Branch: `git checkout claude/elegant-borg-8baf4a` (committed, unpushed; 3 commits ahead of 854a449).
- Verify: `tsc --noEmit -p tsconfig.json` · `vitest run` · `cargo check/test --manifest-path src-tauri/Cargo.toml`.
  Cargo needs `$env:CARGO_TARGET_DIR="…/AudioManager/src-tauri/target"` (reuse deps) +
  `$env:CMAKE_POLICY_VERSION_MINIMUM="3.5"`.
- Open questions: which encoders to actually ship (dep tolerance for C libs); Codex review of the
  branch still pending; R4 live smoke (run app, drag input/bus→record→file) not yet done.

## Resume prompt (paste into new chat)
> Continue the record/mixer-node feature on branch claude/elegant-borg-8baf4a. Read docs/HANDOFF.md
> and docs/PLAN-record-mixer-nodes.md. R4+R3+R2a done/committed/green. Next: R2b Opus encoder
> (audiopus in-tree + ogg crate + resampler + 20ms framing) as a new SampleSink impl. Don't guess
> crate versions; worktree has no node_modules (use main repo's tsc/vitest binaries).
