//! Neural noise suppression (#37), placed first in the per-input chain.
//!
//! Backend: RNNoise via the pure-Rust [`nnnoiseless`] port. RNNoise is a small
//! recurrent network that operates on **48 kHz mono** in fixed 480-sample
//! (10 ms) frames, with samples in **i16 scale** (`[-32768, 32767]`) rather
//! than normalised `[-1, 1]`.
//!
//! Two realities force the wrapper below:
//!
//!  * **Block bridging.** The audio callback hands us arbitrary block sizes,
//!    but RNNoise wants exactly 480-sample frames. We accumulate input into
//!    full frames and read denoised output from a queue primed with one frame
//!    of silence, giving a constant ~10 ms latency and never reading empty.
//!  * **Stereo.** RNNoise is mono, so a stereo input runs two independent
//!    states (one per channel).
//!
//! The model assumes 48 kHz; at any other engine rate the denoiser bypasses
//! (passes the block through untouched) so we never feed it wrong-rate audio.
//!
//! Allocation happens only in [`Denoiser::new`] (engine-start, off the audio
//! thread). `process` and `reset` touch pre-sized buffers only — no realtime
//! allocation as long as a block stays within [`OUT_CAPACITY`].

use std::collections::VecDeque;

use nnnoiseless::DenoiseState;

/// Samples RNNoise consumes/produces per call (10 ms at 48 kHz).
const FRAME: usize = DenoiseState::FRAME_SIZE;

/// `[-1, 1]` ↔ i16-scale conversion factor RNNoise expects.
const SCALE: f32 = 32_768.0;

/// Output-queue capacity per channel: one primed frame plus headroom for the
/// largest realistic callback block, so steady-state pushes never reallocate.
const OUT_CAPACITY: usize = FRAME * 2 + 16_384;

/// Per-input RNNoise denoiser with block bridging. Up to two channels.
pub struct Denoiser {
    /// One RNNoise state per channel (index 0 = L/mono, 1 = R).
    states: Vec<Box<DenoiseState<'static>>>,
    /// Partial input frame per channel, in i16 scale; len < `FRAME`.
    accum: Vec<Vec<f32>>,
    /// Denoised output per channel, in i16 scale; primed with one frame of
    /// silence so a read of any block size always succeeds.
    out: Vec<VecDeque<f32>>,
    /// True only when the engine runs at 48 kHz; otherwise `process` bypasses.
    sr_ok: bool,
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
            for _ in 0..FRAME {
                q.push_back(0.0);
            }
        }
        Self {
            states,
            accum,
            out,
            sr_ok: (sample_rate - 48_000.0).abs() < 1.0,
        }
    }

    /// True when the engine rate lets the denoiser run (48 kHz). When false,
    /// `process` is a passthrough and the UI toggle has no audible effect.
    pub fn is_supported(&self) -> bool {
        self.sr_ok
    }

    /// Flush bridging buffers back to a clean one-frame latency. Keeps RNNoise
    /// internal state (no reallocation) — used on a disabled→enabled transition
    /// so stale queued audio can't play out. Safe on the audio thread.
    pub fn reset(&mut self) {
        for a in &mut self.accum {
            a.clear();
        }
        for q in &mut self.out {
            q.clear();
            for _ in 0..FRAME {
                q.push_back(0.0);
            }
        }
    }

    /// Denoise an interleaved block in place. `channels` is 1 or 2. Bypass
    /// (no-op) when the engine is not at 48 kHz.
    pub fn process(&mut self, interleaved: &mut [f32], channels: usize) {
        if !self.sr_ok || channels == 0 {
            return;
        }
        let ch_count = channels.min(self.states.len());
        let frames = interleaved.len() / channels;

        for ch in 0..ch_count {
            // Pass A — consume this channel's samples into full RNNoise frames.
            for f in 0..frames {
                self.accum[ch].push(interleaved[f * channels + ch] * SCALE);
                if self.accum[ch].len() == FRAME {
                    let mut fin = [0.0f32; FRAME];
                    fin.copy_from_slice(&self.accum[ch]);
                    let mut fout = [0.0f32; FRAME];
                    self.states[ch].process_frame(&mut fout, &fin);
                    self.out[ch].extend(fout.iter().copied());
                    self.accum[ch].clear();
                }
            }
            // Pass B — emit one denoised sample per input sample. The queue is
            // primed a full frame ahead, and Pass A produced ≥ `frames` samples
            // of headroom, so `pop_front` always yields a value here.
            for f in 0..frames {
                let s = self.out[ch].pop_front().unwrap_or(0.0);
                interleaved[f * channels + ch] = s / SCALE;
            }
        }
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
        assert!(buf.iter().all(|&s| s == 0.0), "primed output must be silent");
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
}
