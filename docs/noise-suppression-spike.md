# Noise suppression spike (#37)

Decision record for AudioManager's realtime Rust/WASAPI mic noise-suppression.
Closes the #37 spike: compares the options, records the shipped decision, and
documents chain ordering + the no-native-deps fallback.

## Options compared

| | Native gate | RNNoise (`nnnoiseless`) | DeepFilterNet (DFN3) | WebRTC APM |
|---|---|---|---|---|
| Type | DSP gate/expander | Recurrent neural NS | Deep neural NS | NS + AEC + AGC suite |
| Quality | Coarse (on/off below threshold) | Good broadband NS, voice-preserving | Best NS, handles non-stationary | Good NS; adds AEC + AGC |
| Latency | 0 | ~10 ms (480-frame @ 48 kHz) | ~10s of ms (hop framing) | ~10 ms NS; AEC adds more |
| CPU | Negligible | Low (small RNN) | High (large model) | Moderate–high |
| Binary size | 0 (in-tree DSP) | Small (pure Rust, no native) | Large (embedded model + tract) | Large (native C++ lib) |
| Licensing | n/a | BSD-3 (RNNoise/Xiph); port permissive¹ | code MIT/Apache; model terms¹ | BSD-3 (Google) |
| Build complexity | none | none (pure-Rust crate) | high (git dep, tract pinning) | high (native build + bindgen) |
| Windows packaging | none | none | model + native codegen | native DLL / vendored C++ |
| Needs reference signal | no | no | no | **yes for AEC** (loopback tap) |

¹ Confirm exact crate/model licenses before a public release.

## Decision

- **Ship: native gate + RNNoise.** The gate (`dsp/gate.rs`) is always present
  (zero-dep DSP). RNNoise (`nnnoiseless` 0.5.2, pure Rust) is the optional neural
  NS, opt-in behind the per-input denoise toggle (`DenoiseConfig.enabled`,
  `dsp/denoise.rs`). Pure-Rust ⇒ it always compiles, no native packaging cost.
- **Defer: DeepFilterNet.** It is the quality ceiling, and the config/UI path is
  already plumbed (`DenoiseBackend::DeepFilterNet`), but it is **not built**:
  the published `deep_filter` crate predates the `DfTract` API, its `main` only
  builds against tract `=0.21.4`, and that tract fails to load the embedded DFN3
  model (`duplicate name /convt3/Conv.bias` at codegen). An optional git dep is
  also fetched on default builds. Held out until an upstream model/tract combo
  builds; selecting it falls back to RNNoise (honest, see below).
- **Do not ship: WebRTC APM (initially).** Its differentiator is AEC + AGC, not
  NS quality — and AEC needs a reference (loopback) signal and a heavy native
  C++ build/packaging chain. Out of scope for a mic-NS spike; revisit only if
  echo cancellation becomes a goal (e.g. speaker bleed into mic). Note: the
  pure-Rust `webrtc` crate *is* a dependency, but only for the phone audio
  *transport* (receiving the phone's Opus track, #41/#42) — that is unrelated to
  the WebRTC Audio Processing Module (the C++ NS/AEC/AGC DSP) deferred here.

## Chain ordering

Canonical per-input order (`dsp/config.rs` `DspStage::ALL`):

```
denoise → high-pass → gate → EQ → compressor → limiter
```

Rationale:
- **denoise first** — strip broadband noise before any decision/boost stage, so
  the gate threshold and the compressor makeup don't act on the noise floor.
- **high-pass** next — remove sub-bass rumble the denoiser leaves.
- **gate** after HP — its level decision is cleaner once rumble + hiss are gone.
- **EQ → compressor** — tone then leveling on the cleaned signal.
- **limiter last** — final brick wall (and the B1 bus limiter is the true final
  guard, see #33).

No separate **AGC** stage ships: the compressor (+ makeup gain) provides
leveling. A dedicated AGC would arrive only with WebRTC APM, which is deferred.

## Fallback / no-native-deps guarantee

The app fully works with **no optional native dependencies**:
- The gate and all other DSP are pure in-tree Rust.
- RNNoise is a pure-Rust crate (always built); there is no native NS DLL.
- RNNoise runs at **48 kHz mono only** and **bypasses** when the engine isn't at
  48 kHz — audio still flows, just un-denoised.
- Selecting DeepFilterNet (currently unbuilt) transparently **falls back to
  RNNoise** (`Denoiser::process`), so a saved preset naming DFN stays valid.
- Allocation happens only in `Denoiser::new` (engine start, off the audio
  thread); the realtime `process` path never allocates.

## Outcome

Acceptance criteria met: options compared (table); one optional NS path
prototyped behind a toggle (RNNoise, shipping); decision recorded (gate +
RNNoise ship, DFN deferred, WebRTC APM out); ordering documented; native-dep
fallback guaranteed. Follow-ups: land DeepFilterNet when upstream builds;
reconsider WebRTC APM only if AEC becomes a requirement.
