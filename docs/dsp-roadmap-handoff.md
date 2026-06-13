# Streaming-DSP roadmap — hand-off (continue in a fresh conversation)

Paste this whole file into the new conversation. It is self-contained — assume the new session has **no chat history**.

---

## Mission
Continue the AudioManager **streaming-DSP / latency roadmap** (#32–#38, Phase-12 ducking, Phase-13 meters). #32 foundation is landed; finish the rest. Work is **plan-first, Codex-review-gated** (see Workflow rules below).

## Machine / repo layout (Windows 11, PowerShell)
- **Main clone** (`C:\Users\sarma\Documents\GitHub\AudioManager`) — checked out on `codex/streaming-dsp-latency-roadmap` (tip **095b4f7**). **Codex is LIVE-editing this clone.** Do NOT git-checkout/stash/commit/reset here, and do not build here while Codex is active (one-clone hazard).
- **DSP work worktree** (`C:\Users\sarma\Documents\GitHub\AudioManager\.claude\worktrees\dsp-latency-modes`, branch `claude/dsp-latency-modes`) — forked off the committed tip 095b4f7. **This is where the safe DSP work lives.** #35 + #37 already committed here (unpushed).
- `phone-audio/mvp` — separate feature line; the phone "persistent pairing" feature (#1/#3/#4) was just merged into it (PR #46). NOT related to DSP. Leave it alone.
- `git` remote: `origin` = https://github.com/Sdomit/AudioManager.git

## 🔴 THE BLOCKER (read first)
The committed DSP tip's **frontend does not `pnpm build`**: `src/components/audio-manager/InputDetail.tsx` imports `./eqPopoutWindow` and uses an `onPopOutEq` prop that live ONLY in Codex's **uncommitted working-tree cluster** in the main clone (`EqPopout.tsx/.css`, `QuickPanel.tsx/.module.css`, `eqPopoutWindow.ts`, `quickPanelWindow.ts`, `audio/monitor.rs` + edits to `config.rs`/`lib.rs`/`state.rs`/`DspControls.tsx`/`EqGraph.tsx`/`TopBar.tsx`/`main.tsx`/`BusDetail.tsx`/`Cargo.toml`).
- Until Codex **commits that cluster**, the DSP frontend can't build, so nothing DSP can be run/verified in-app, and `dsp-latency-modes` can't cleanly rebase/merge (it overlaps `config.rs`/`lib.rs`/`BusDetail.tsx`).
- **You cannot commit Codex's WIP** (not yours, one-clone hazard). Getting Codex to commit its cluster is a USER/Codex action and is the gating step for in-app verification + merge.
- **Backend (Rust) is unaffected** — `cargo test --lib` builds & passes on `dsp-latency-modes` (150 tests). So backend-only DSP work IS verifiable now.

## Rules / hazards
- **Never spawn more than 4 subagents** (concurrent AND total fan-out). Hard cap, every task.
- **Delegate by default** (within the cap): searches/"where is X", multi-file fact extraction, build/test digestion, diff reviews. Do multi-file features / new files INLINE.
- **One-clone hazard**: Codex shares the main clone. Never checkout/stash/commit there while Codex is live. Do DSP work in the `dsp-latency-modes` worktree (or a new worktree off 095b4f7). Reading committed blobs is always safe: `git -C <main> show HEAD:<path>`.
- **Codex-review-gated**: after a change, run `codex exec -s read-only review --base <base>` (Codex CLI, gpt-5.4, user's quota). `review --base` rejects a positional prompt — put guidance in `--title`. If quota-blocked, do a ≤4-agent self-review instead.
- **DSP branch needs NO MSVC dev shell** (no audiopus/webrtc/cmake deps — that was the phone branch). Plain `cargo test --lib` works. `pnpm install` then `pnpm build`/`pnpm test` for frontend (but frontend build is currently BLOCKED, see above).
- Commit messages: Conventional Commits; end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Done so far on `claude/dsp-latency-modes` (unpushed)
- **#35 named latency modes** (commit `9c0549f`): `audio/bus.rs` `LatencyMode {Stable→driver-default/None, Low→256, UltraLow→128}` + `is_available`-style `from_frames`/`frames`; `lib.rs` `set_bus_latency_mode` command (registered); derived `BusStatus.latency_mode`; frontend segmented picker in `BusDetail.tsx` threaded `AudioManager → DetailPanel → BusDetail` + ipc/adapter/hook/types. Additive over existing `buffer_size_frames` (no mixer/preset-schema change). `latencyMode` is OPTIONAL on the `Bus` type.
- **#37 DeepFilterNet honesty** (commit `287c0f9`): DFN engine is un-buildable (upstream tract/model blocker, documented in `Cargo.toml`/`denoise.rs`). `DenoiseBackend::is_available()` + `DEEP_FILTER_NET_AVAILABLE=false` const; `DenoiseConfig::clamp()` normalizes an unavailable backend → `Rnnoise` (runs on every IPC/preset path) so no silent mismatch. config.rs only.
- `cargo test --lib`: **150 passed**. Frontend: my TS typechecks clean; only the pre-existing broken-base errors (EqPopout cluster) remain.

## Remaining roadmap (prioritized — from a 4-agent committed-state review)
**Correctness fixes (do these; backend-only, verifiable now):**
- **HIGH — no denormal/FTZ flush in the realtime DSP.** Biquad `y1/y2` + comp/limiter/gate one-pole envelopes decay into subnormals on silence → FPU stalls → dropouts. Fix: set FTZ+DAZ on the audio thread once at stream start (MXCSR via `core::arch::x86_64`), or per-accumulator denormal guards. Files: `src-tauri/src/audio/dsp/filter.rs:228`, `dynamics.rs:118/219`, `gate.rs:95`, document in `live.rs`.
- **MED — biquad coeffs not finiteness-guarded** at the RT boundary → a NaN coeff permanently kills a channel. Sanitize to passthrough `[1,0,0,0,0]` before publish. `live.rs:125` (AtomicBiquad::store), `filter.rs:206`.
- **MED — denoiser output queue can `realloc` on the RT thread** for oversized blocks (`OUT_CAPACITY` hardcoded, not derived from ring size). `denoise.rs:40`.
- **MED — `process()` (per-frame) ≠ `process_block()` (RT)**: per-frame ignores chain `order` + omits denoiser; doc claims identical; test doesn't catch it. Safe today (engine uses block) but a trap. Fix or delete `process()`; strengthen `process_block_matches_per_frame_process`. `live.rs:632` vs `659`.
- **MED — live per-input DSP update is single-bus**: same input on 2 running buses keeps stale params on the others. Publish to all running buses containing the input. `lib.rs` `update_input_dsp`.
- **MED — EqGraph always drawn at 48 kHz** (frontend): curve diverges from DSP at 44.1/96k. Thread real sample rate into `EqGraph`. `EqGraph.tsx:18`.
- LOW: gate hysteresis; compressor effective attack/release ~2× (double smoothing); DSP config has no version field; float-claim ignores canvas position for chain order.

**Roadmap features (gate behind a green base + plan-first + Codex review):**
- **P1 — #33 Stream Voice preset + B1 protection**: one-click HPF→gate→EQ→comp→limiter chain, protected final limiter ~−1 dBFS on B1. Highest value. Backend seams (`update_input_dsp`/`update_bus_dsp`) exist → mostly preset data + UI.
- **P2 — #34 stereo** (pan/balance/mono/phase/mid-side): needs a new `DspStage` inserted post-EQ/pre-Comp + config field + UI. Note: `DspStage::ALL` + the `live.rs` order packer are fixed at 6 stages → extend carefully.
- **P2 — Phase-12 ducking** (sidechain auto-duck music under speech): needs a sidechain audio tap in the mixer + a ducking processor. `graph.ts` sidechain PortKind is UI scaffold only.
- **P2 — #38 streaming meters** (RMS, LUFS momentary/integrated, true-peak, spectrum): new analysis module off the RT path, surfaced via `BusStatus`. Parallelizable.
- **P3 — #36 resampler**: linear only; benchmark rubato sinc or formally close as linear. **P4** — refresh `docs/streaming-dsp-implementation-plan.md` (stale: still says "no code implemented").

## Verify commands (DSP backend, in the worktree)
```
cd C:\Users\sarma\Documents\GitHub\AudioManager\.claude\worktrees\dsp-latency-modes\src-tauri
cargo test --lib
```
Frontend (currently blocked by the EqPopout base):
```
cd C:\Users\sarma\Documents\GitHub\AudioManager\.claude\worktrees\dsp-latency-modes
pnpm install --prefer-offline ; pnpm build ; pnpm test
```

## Recommended first move for the new session
1. Check whether Codex has committed its EqPopout cluster (`git -C <main> show HEAD --stat` / does the committed tip now contain `EqPopout.tsx`?). If yes → the base may build; rebase `dsp-latency-modes` onto the new tip, verify in-app, reconcile, PR #35/#37.
2. If still blocked → do the **HIGH denormal/FTZ fix** (+ coeff finiteness guard) on `dsp-latency-modes` — backend-only, `cargo test`-verifiable, low collision with Codex's cluster. Then the other backend MED fixes.
3. Don't push/PR `dsp-latency-modes` until the base builds (frontend in-app verification + clean reconcile with Codex's cluster).
