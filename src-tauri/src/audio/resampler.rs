//! Streaming linear-interpolation resampler for cpal device inputs whose
//! sample rate differs from the bus rate (#20).
//!
//! Loopback sources don't need this — WASAPI shared-mode `autoconvert` already
//! delivers the bus rate. It exists only so a microphone/line-in locked to a
//! different rate than the output bus can still be mixed instead of hard-erroring.
//!
//! It is frame-based (mono or stereo) so output frames interleave correctly,
//! and allocation-free: one instance is created per mismatched input stream and
//! driven from the realtime input callback. Linear interpolation is modest
//! quality (some high-frequency aliasing) but correct and cheap; a higher-order
//! resampler (e.g. `rubato` sinc) is a future quality upgrade.

/// Per-stream resampler state. Drive it with `process_frame` for each input
/// frame; it emits zero or more output frames at the target rate.
/// Largest playout-rate trim the drift compensator may apply, in ppm. ±300 ppm
/// is ±0.03 % pitch — well under audibility, and only reached under sustained drift.
pub const MAX_TRIM_PPM: i32 = 300;

pub struct LinearResampler {
    /// Input frames advanced per output frame = (in_rate / out_rate) * trim.
    step: f64,
    /// Untrimmed ratio; `step` is derived from this and the current trim.
    base_step: f64,
    /// Current playout-rate trim in ppm (drift compensation; 0 = identity).
    trim_ppm: i32,
    /// Time of the next output frame within the current input interval, in
    /// [0, 1) once normalized — may exceed 1 transiently when downsampling.
    t: f64,
    /// Previous input frame (left/right); right is unused for mono.
    prev: [f32; 2],
    channels: usize,
    started: bool,
}

impl LinearResampler {
    /// `channels` is clamped to 2 (the mixer only supports mono/stereo inputs).
    pub fn new(in_rate: u32, out_rate: u32, channels: usize) -> Self {
        let in_rate = in_rate.max(1);
        let out_rate = out_rate.max(1);
        let base_step = in_rate as f64 / out_rate as f64;
        Self {
            step: base_step,
            base_step,
            trim_ppm: 0,
            t: 0.0,
            prev: [0.0; 2],
            channels: channels.clamp(1, 2),
            started: false,
        }
    }

    /// Nudge the effective resampling ratio by `ppm` (clamped to ±[`MAX_TRIM_PPM`])
    /// to compensate sender/receiver clock drift. `0` restores the exact base
    /// ratio (bit-identical to an untrimmed resampler).
    pub fn set_trim_ppm(&mut self, ppm: i32) {
        self.trim_ppm = ppm.clamp(-MAX_TRIM_PPM, MAX_TRIM_PPM);
        self.step = self.base_step * (1.0 + self.trim_ppm as f64 / 1_000_000.0);
    }

    /// Current applied trim in ppm (observability).
    #[allow(dead_code)] // surfaced in Phase 3
    pub fn trim_ppm(&self) -> i32 {
        self.trim_ppm
    }

    /// Feed one input frame (`frame.len() == channels`). Calls `emit` once per
    /// produced output frame with a `[L, R]` array (R == 0.0 for mono).
    ///
    /// The first frame only primes `prev` (no output): output frames are
    /// interpolated across the interval between the previous and current input
    /// frame, so one frame of priming latency is unavoidable.
    pub fn process_frame<E: FnMut([f32; 2])>(&mut self, frame: &[f32], mut emit: E) {
        let ch = self.channels;
        let cur = [frame[0], if ch == 2 { frame[1] } else { 0.0 }];

        if !self.started {
            self.started = true;
            self.prev = cur;
            return;
        }

        while self.t < 1.0 {
            let f = self.t as f32;
            let mut out = [0.0f32; 2];
            for c in 0..ch {
                out[c] = self.prev[c] + (cur[c] - self.prev[c]) * f;
            }
            emit(out);
            self.t += self.step;
        }
        self.t -= 1.0;
        self.prev = cur;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect_mono(rs: &mut LinearResampler, inputs: &[f32]) -> Vec<f32> {
        let mut out = Vec::new();
        for &x in inputs {
            rs.process_frame(&[x], |y| out.push(y[0]));
        }
        out
    }

    #[test]
    fn upsamples_2x_with_midpoints() {
        let mut rs = LinearResampler::new(1, 2, 1);
        let out = collect_mono(&mut rs, &[0.0, 1.0, 2.0, 3.0]);
        // First input primes; then 2 outputs per input.
        assert_eq!(out, vec![0.0, 0.5, 1.0, 1.5, 2.0, 2.5]);
    }

    #[test]
    fn downsamples_2x_drops_every_other() {
        let mut rs = LinearResampler::new(2, 1, 1);
        let out = collect_mono(&mut rs, &[0.0, 1.0, 2.0, 3.0, 4.0]);
        // step = 2.0: one output per two inputs, taken at the interval's left
        // edge (the previous sample). First input primes prev.
        assert_eq!(out, vec![0.0, 2.0]);
    }

    #[test]
    fn equal_rate_is_unit_delay_passthrough() {
        let mut rs = LinearResampler::new(48_000, 48_000, 1);
        let out = collect_mono(&mut rs, &[0.1, 0.2, 0.3, 0.4]);
        // step = 1.0: emits the previous sample each step — input delayed by one.
        assert_eq!(out, vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn stereo_channels_stay_independent_and_interleaved() {
        let mut rs = LinearResampler::new(1, 2, 2);
        let mut out: Vec<[f32; 2]> = Vec::new();
        for frame in [[0.0, 10.0], [1.0, 11.0], [2.0, 12.0]] {
            rs.process_frame(&frame, |y| out.push(y));
        }
        // L follows 0,0.5,1,1.5 ; R follows 10,10.5,11,11.5 — paired per frame.
        assert_eq!(
            out,
            vec![[0.0, 10.0], [0.5, 10.5], [1.0, 11.0], [1.5, 11.5]]
        );
    }

    #[test]
    fn non_integer_ratio_count_is_proportional() {
        // 44.1k -> 48k: expect ~ (N-1) * 48/44.1 outputs.
        let mut rs = LinearResampler::new(44_100, 48_000, 1);
        let inputs: Vec<f32> = (0..441).map(|i| i as f32).collect();
        let out = collect_mono(&mut rs, &inputs);
        let expected = ((inputs.len() - 1) as f64 * 48_000.0 / 44_100.0).round() as usize;
        assert!(
            (out.len() as i64 - expected as i64).abs() <= 1,
            "got {} outputs, expected ~{expected}",
            out.len()
        );
    }

    #[test]
    fn trim_zero_is_identity() {
        let inputs: Vec<f32> = (0..300).map(|i| i as f32 * 0.01).collect();
        let mut base = LinearResampler::new(48_000, 44_100, 1);
        let mut trimmed = LinearResampler::new(48_000, 44_100, 1);
        trimmed.set_trim_ppm(0);
        assert_eq!(collect_mono(&mut base, &inputs), collect_mono(&mut trimmed, &inputs));
    }

    #[test]
    fn trim_sign_changes_output_rate_monotonically() {
        // Long input so ±300 ppm yields a clear (>1 frame) output-count delta.
        let inputs: Vec<f32> = (0..20_000).map(|i| i as f32).collect();
        let mut faster = LinearResampler::new(48_000, 48_000, 1);
        faster.set_trim_ppm(-300); // smaller step → MORE outputs (catch up / fill)
        let mut base = LinearResampler::new(48_000, 48_000, 1);
        let mut slower = LinearResampler::new(48_000, 48_000, 1);
        slower.set_trim_ppm(300); // larger step → FEWER outputs (bleed off / drain)
        let nf = collect_mono(&mut faster, &inputs).len();
        let nb = collect_mono(&mut base, &inputs).len();
        let ns = collect_mono(&mut slower, &inputs).len();
        assert!(nf > nb && nb > ns, "−ppm→more, +ppm→fewer outputs: {nf} {nb} {ns}");
    }

    #[test]
    fn trim_is_clamped() {
        let mut r = LinearResampler::new(48_000, 48_000, 1);
        r.set_trim_ppm(100_000);
        assert_eq!(r.trim_ppm(), MAX_TRIM_PPM);
        r.set_trim_ppm(-100_000);
        assert_eq!(r.trim_ppm(), -MAX_TRIM_PPM);
    }
}
