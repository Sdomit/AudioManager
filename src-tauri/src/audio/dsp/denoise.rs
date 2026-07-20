//! Neural noise suppression (#37), placed first in the per-input chain.
//!
//! **RNNoise** (the pure-Rust [`nnnoiseless`] port) is the active backend: a
//! small recurrent net, ~10 ms latency, tiny CPU, i16-scaled samples. It runs
//! at **48 kHz mono** in fixed 480-sample frames, so the wrapper accumulates
//! arbitrary callback blocks into full frames and reads denoised output from a
//! queue primed with one frame of silence — constant ~10 ms latency, never
//! reads empty. Stereo runs one state per channel. Off 48 kHz it bypasses.
//!
//! ## DeepFilterNet (phase 2 — wired but not built)
//!
//! [`Denoiser`] carries a `use_dfn` flag fed from [`DenoiseBackend`] through the
//! seqlock, and selecting DeepFilterNet in the UI flows all the way here. The
//! actual `DfTract` engine is **not compiled in**: a prototype backend worked
//! architecturally (per-channel `df::tract::DfTract`, normalised `[-1,1]`,
//! `hop_size` framing, `unsafe impl Send` because tract holds `Rc`s but the
//! slots only ever touch the audio thread after a single move), but:
//!   * the published `deep_filter` crate predates `DfTract`;
//!   * `deep_filter` `main` only builds against tract `=0.21.4`; and
//!   * that tract then fails to load the embedded DeepFilterNet3 model
//!     (`duplicate name /convt3/Conv.bias` during codegen).
//! No buildable model/tract combo exists today, and an optional git dep is
//! fetched even on default builds, so DFN is held out. Until it lands,
//! `use_dfn` simply falls back to RNNoise (see [`Denoiser::process`]).
//!
//! Allocation happens only in [`Denoiser::new`] (engine start, off the audio
//! thread). `process`/`reset` touch pre-sized buffers and never allocate on the
//! audio thread: `process` interleaves frame production with draining, so the
//! output queue holds at most ~2 frames for *any* block size (see
//! [`OUT_CAPACITY`]).

use std::collections::VecDeque;

use nnnoiseless::DenoiseState;

/// Samples RNNoise consumes/produces per call (10 ms at 48 kHz).
const FRAME: usize = DenoiseState::FRAME_SIZE;

/// `[-1, 1]` ↔ i16-scale conversion factor RNNoise expects.
const SCALE: f32 = 32_768.0;

/// Output-queue capacity per channel. `process` interleaves frame production
/// with draining, so the queue never holds more than the primed frame plus one
/// freshly produced frame (~2 frames) regardless of block size. Three frames
/// leaves margin so neither priming, `extend`, nor `push` ever reallocates on
/// the audio thread.
const OUT_CAPACITY: usize = FRAME * 3;

/// Per-input neural denoiser. RNNoise backend; `use_dfn` is plumbed for the
/// future DeepFilterNet backend and currently falls back to RNNoise.
pub struct Denoiser {
    /// One RNNoise state per channel (index 0 = L/mono, 1 = R).
    states: Vec<Box<DenoiseState<'static>>>,
    /// Partial input frame per channel, in i16 scale; len < `FRAME`.
    accum: Vec<Vec<f32>>,
    /// Denoised output per channel, in i16 scale; primed one frame ahead.
    out: Vec<VecDeque<f32>>,
    /// True only when the engine runs at 48 kHz; otherwise `process` bypasses.
    sr_ok: bool,
    /// DeepFilterNet requested. No effect until the DFN backend is compiled in;
    /// retained so the UI selection and seqlock stay wired end to end.
    use_dfn: bool,
}

impl Denoiser {
    /// Allocate states + buffers for up to two channels. Call before the stream
    /// starts — never on the audio thread.
    pub fn new(sample_rate: f32) -> Self {
        let states = vec![DenoiseState::new(), DenoiseState::new()];
        let accum = vec![Vec::with_capacity(FRAME), Vec::with_capacity(FRAME)];
        let mut out = vec![
            VecDeque::with_capacity(OUT_CAPACITY),
            VecDeque::with_capacity(OUT_CAPACITY),
        ];
        for q in &mut out {
            prime(q, FRAME);
        }
        Self {
            states,
            accum,
            out,
            sr_ok: (sample_rate - 48_000.0).abs() < 1.0,
            use_dfn: false,
        }
    }

    /// True when the engine rate lets the denoiser run (48 kHz).
    #[cfg(test)]
    pub fn is_supported(&self) -> bool {
        self.sr_ok
    }

    /// Select the DeepFilterNet backend. Returns true if it changed (caller
    /// resets on change). No audible effect until the DFN backend is compiled
    /// in — selection currently falls back to RNNoise.
    pub fn set_use_dfn(&mut self, use_dfn: bool) -> bool {
        let changed = self.use_dfn != use_dfn;
        self.use_dfn = use_dfn;
        changed
    }

    /// Flush bridging buffers back to a clean one-frame latency. Keeps RNNoise
    /// internal state (no reallocation). Safe on the audio thread.
    pub fn reset(&mut self) {
        for a in &mut self.accum {
            a.clear();
        }
        for q in &mut self.out {
            q.clear();
            prime(q, FRAME);
        }
    }

    /// Denoise an interleaved block in place. `channels` is 1 or 2. Bypass when
    /// the engine is not at 48 kHz. (DeepFilterNet selection falls back here.)
    pub fn process(&mut self, interleaved: &mut [f32], channels: usize) {
        if !self.sr_ok || channels == 0 {
            return;
        }
        let ch_count = channels.min(self.states.len());
        let frames = interleaved.len() / channels;
        for ch in 0..ch_count {
            // Accumulate into full RNNoise frames and drain one output sample per
            // input sample in the SAME pass. Interleaving — rather than pushing
            // the whole block first, then draining — caps the output queue at the
            // primed frame plus one freshly produced frame, so an oversized
            // callback block can never grow it (no realloc on the audio thread).
            // The queue is primed a frame ahead and each completed frame
            // replenishes it before its samples are read, so `pop_front` always
            // yields. Output is identical to the two-pass form (FIFO order and
            // one-frame latency are unchanged).
            for f in 0..frames {
                let idx = f * channels + ch;
                self.accum[ch].push(interleaved[idx] * SCALE);
                if self.accum[ch].len() == FRAME {
                    let mut fin = [0.0f32; FRAME];
                    fin.copy_from_slice(&self.accum[ch]);
                    let mut fout = [0.0f32; FRAME];
                    self.states[ch].process_frame(&mut fout, &fin);
                    self.out[ch].extend(fout.iter().copied());
                    self.accum[ch].clear();
                }
                let s = self.out[ch].pop_front().unwrap_or(0.0);
                interleaved[idx] = s / SCALE;
            }
        }
    }
}

/// Prime an output queue with `n` zeros (one frame of latency headroom).
#[inline]
fn prime(q: &mut VecDeque<f32>, n: usize) {
    for _ in 0..n {
        q.push_back(0.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bypasses_when_not_48k() {
        let mut d = Denoiser::new(44_100.0);
        assert!(!d.is_supported());
        let mut buf = vec![0.5, -0.5, 0.25, -0.25];
        let copy = buf.clone();
        d.process(&mut buf, 2);
        assert_eq!(buf, copy, "non-48k must pass through untouched");
    }

    #[test]
    fn primed_latency_emits_silence_first() {
        // Output lags input by one 480-sample frame (primed with silence), so a
        // first sub-frame block reads back all zeros regardless of input.
        let mut d = Denoiser::new(48_000.0);
        assert!(d.is_supported());
        let mut buf = vec![0.7f32; 100];
        d.process(&mut buf, 1);
        assert!(
            buf.iter().all(|&s| s == 0.0),
            "primed output must be silent"
        );
    }

    #[test]
    fn preserves_length_and_finiteness_stereo() {
        let mut d = Denoiser::new(48_000.0);
        for _ in 0..10 {
            let mut buf = vec![0.1f32; 512 * 2];
            d.process(&mut buf, 2);
            assert_eq!(buf.len(), 512 * 2);
            assert!(buf.iter().all(|s| s.is_finite()));
        }
    }

    #[test]
    fn oversized_block_does_not_reallocate_output_queue() {
        // A single block far larger than any realistic callback (and larger than
        // the old hardcoded headroom) must not grow the output queue — the RT
        // path allocates nowhere. The two-pass form pushed the whole block before
        // draining and would realloc here; the interleaved form keeps the queue
        // at ~2 frames, so capacity is unchanged.
        let mut d = Denoiser::new(48_000.0);
        let cap_l = d.out[0].capacity();
        let cap_r = d.out[1].capacity();
        let mut buf = vec![0.3f32; 50_000 * 2];
        d.process(&mut buf, 2);
        assert_eq!(buf.len(), 50_000 * 2);
        assert!(buf.iter().all(|s| s.is_finite()));
        assert_eq!(
            d.out[0].capacity(),
            cap_l,
            "RT path must not reallocate (L)"
        );
        assert_eq!(
            d.out[1].capacity(),
            cap_r,
            "RT path must not reallocate (R)"
        );
    }

    #[test]
    fn handles_odd_block_sizes() {
        let mut d = Denoiser::new(48_000.0);
        for &n in &[1usize, 7, 63, 480, 481, 960, 1024] {
            let mut buf = vec![0.05f32; n];
            d.process(&mut buf, 1);
            assert_eq!(buf.len(), n);
        }
    }

    #[test]
    fn reset_reprimes_latency() {
        let mut d = Denoiser::new(48_000.0);
        let mut warm = vec![0.5f32; 1000];
        d.process(&mut warm, 1);
        d.reset();
        let mut buf = vec![0.9f32; 100];
        d.process(&mut buf, 1);
        assert!(buf.iter().all(|&s| s == 0.0), "reset must re-prime silence");
    }

    #[test]
    fn set_use_dfn_reports_change() {
        let mut d = Denoiser::new(48_000.0);
        assert!(d.set_use_dfn(true), "false→true is a change");
        assert!(!d.set_use_dfn(true), "true→true is no change");
        assert!(d.set_use_dfn(false), "true→false is a change");
    }

    // Selecting DeepFilterNet falls back to RNNoise (DFN backend not compiled):
    // same primed-latency behavior, no panic.
    #[test]
    fn dfn_selection_falls_back_to_rnnoise() {
        let mut d = Denoiser::new(48_000.0);
        d.set_use_dfn(true);
        let mut buf = vec![0.7f32; 100];
        d.process(&mut buf, 1);
        assert!(
            buf.iter().all(|&s| s == 0.0),
            "fallback keeps primed silence"
        );
    }
}
