//! Streaming resampler for cpal device inputs whose sample rate differs from
//! the bus rate (#20, #36), plus a lightweight linear resampler for remote
//! phone audio (#39-#45).
//!
//! Loopback sources don't need this — WASAPI shared-mode `autoconvert` already
//! delivers the bus rate. It exists only so a microphone/line-in locked to a
//! different rate than the output bus can still be mixed instead of hard-erroring.
//!
//! It is frame-based (mono or stereo) so output frames interleave correctly,
//! and allocation-free: one instance is created per mismatched input stream and
//! driven from the realtime input callback.
//!
//! ## Interpolation quality (#36)
//!
//! [`ResampleQuality::Fast`] is linear interpolation between the two most recent
//! frames — 1-frame priming latency, cheapest, with some high-frequency aliasing.
//! [`ResampleQuality::Quality`] is a 4-point Catmull-Rom cubic: it at least
//! halves linear's RMS error on program material for a handful of extra
//! mul-adds per frame, at the cost of 2 more frames of priming latency
//! (~42 µs at 48 kHz). The mixer uses `Quality`; `Fast` stays available for the
//! lowest-latency path and as the reference baseline in tests.
//!
//! ## Drift-aware SRC (#36)
//!
//! `nudge_ratio` implements a P-controller that adjusts the conversion ratio
//! based on observed ring fill vs target. Called once per output block from the
//! mixer before draining that input's ring: if fill > target the resampler slows
//! output slightly (step up → fewer frames per input frame); if fill < target it
//! speeds up. Max correction is ±0.1 % per call, total clamp ±1 % of nominal, so
//! the pitch shift is inaudible (~1.7 cents) and drift converges in seconds rather
//! than popping. The coarser `resync_drop` backstop in the mixer fires only when
//! drift reaches 80 ms — these two mechanisms cover complementary regimes.
//!
//! ## Remote phone resampler (#39-#45)
//!
//! [`LinearResampler`] is a separate, simpler linear-interpolation resampler used
//! by the remote phone feed. It converts the phone decode rate to the bus rate
//! and exposes a ppm-trim API (`set_trim_ppm`) so the jitter feeder can correct
//! sender/receiver clock drift. It is kept distinct from `Resampler` because the
//! phone path needs the cheap ppm-trim knob rather than the mixer's fill-target
//! P-controller.

/// Max step delta per `nudge_ratio` call — ±0.1 % of nominal.
const DRIFT_MAX_STEP_DELTA: f64 = 0.001;
/// Proportional gain applied to (fill − target) / target.
const DRIFT_P_GAIN: f64 = 0.05;
/// Hard clamp: step never drifts more than ±1 % from nominal.
const DRIFT_RATIO_CLAMP: f64 = 0.01;

/// Interpolation quality for [`Resampler`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResampleQuality {
    /// Linear interpolation between the two most recent input frames.
    /// 1-frame priming latency, cheapest. Reserved for a future UltraLow path;
    /// the mixer currently always uses `Quality`, so this is exercised in tests.
    #[allow(dead_code)]
    Fast,
    /// 4-point Catmull-Rom cubic. ~Halves linear's RMS error; 3-frame priming.
    Quality,
}

/// Per-stream resampler state. Drive it with `process_frame` for each input
/// frame; it emits zero or more output frames at the target rate.
pub struct Resampler {
    /// Nominal ratio = in_rate / out_rate, never modified after construction.
    nominal_step: f64,
    /// Current (drift-adjusted) ratio. Nudged each block by `nudge_ratio`.
    step: f64,
    /// Time of the next output frame within the current input interval, in
    /// [0, 1) once normalized — may exceed 1 transiently when downsampling.
    t: f64,
    /// Input history x[n-3..=n] per channel, newest at index 3 (index 1 of the
    /// inner array is unused for mono). `Fast` uses the last two frames,
    /// `Quality` interpolates between hist[1] and hist[2] with hist[0]/hist[3]
    /// as the cubic's outer control points.
    hist: [[f32; 2]; 4],
    /// Frames consumed so far while priming the history (capped at
    /// `priming_frames`).
    primed: u8,
    channels: usize,
    quality: ResampleQuality,
}

impl Resampler {
    /// `channels` is clamped to 2 (the mixer only supports mono/stereo inputs).
    pub fn new(in_rate: u32, out_rate: u32, channels: usize, quality: ResampleQuality) -> Self {
        let in_rate = in_rate.max(1);
        let out_rate = out_rate.max(1);
        let nominal = in_rate as f64 / out_rate as f64;
        Self {
            nominal_step: nominal,
            step: nominal,
            t: 0.0,
            hist: [[0.0; 2]; 4],
            primed: 0,
            channels: channels.clamp(1, 2),
            quality,
        }
    }

    /// Frames of priming latency before the first output frame.
    fn priming_frames(&self) -> u8 {
        match self.quality {
            ResampleQuality::Fast => 1,
            ResampleQuality::Quality => 3,
        }
    }

    /// Adjust conversion ratio to steer ring fill toward `target` (in samples).
    ///
    /// Call once per output block, before draining the ring for this input. The
    /// correction is proportional, clamped to ±0.1 % per call and ±1 % total.
    ///
    /// fill > target → step increases → resampler produces fewer output frames
    ///   per input frame → ring drains faster.
    /// fill < target → step decreases → more output frames per input → ring fills.
    pub fn nudge_ratio(&mut self, fill: usize, target: usize) {
        let error = (fill as f64 - target as f64) / target.max(1) as f64;
        let delta = (error * DRIFT_P_GAIN).clamp(-DRIFT_MAX_STEP_DELTA, DRIFT_MAX_STEP_DELTA);
        let lo = self.nominal_step * (1.0 - DRIFT_RATIO_CLAMP);
        let hi = self.nominal_step * (1.0 + DRIFT_RATIO_CLAMP);
        self.step = (self.step + delta).clamp(lo, hi);
    }

    /// Interpolate channel `c` at fractional position `f` in [0, 1) within the
    /// current input interval.
    #[inline]
    fn interpolate(&self, c: usize, f: f32) -> f32 {
        match self.quality {
            ResampleQuality::Fast => {
                // Linear between the two most recent frames.
                let a = self.hist[2][c];
                let b = self.hist[3][c];
                a + (b - a) * f
            }
            ResampleQuality::Quality => {
                // Catmull-Rom between hist[1] (f=0) and hist[2] (f=1), using
                // hist[0] and hist[3] as the outer tangent control points.
                let x0 = self.hist[0][c];
                let x1 = self.hist[1][c];
                let x2 = self.hist[2][c];
                let x3 = self.hist[3][c];
                let a = (-x0 + 3.0 * x1 - 3.0 * x2 + x3) * 0.5;
                let b = (2.0 * x0 - 5.0 * x1 + 4.0 * x2 - x3) * 0.5;
                let cc = (-x0 + x2) * 0.5;
                ((a * f + b) * f + cc) * f + x1
            }
        }
    }

    /// Feed one input frame (`frame.len() == channels`). Calls `emit` once per
    /// produced output frame with a `[L, R]` array (R == 0.0 for mono).
    ///
    /// The first `priming_frames` frames only fill the history (no output):
    /// output frames are interpolated across an interval bounded by real input
    /// frames, so a small priming latency is unavoidable.
    pub fn process_frame<E: FnMut([f32; 2])>(&mut self, frame: &[f32], mut emit: E) {
        let ch = self.channels;
        let cur = [frame[0], if ch == 2 { frame[1] } else { 0.0 }];

        // Shift history left and append the newest frame at index 3.
        self.hist = [self.hist[1], self.hist[2], self.hist[3], cur];

        if self.primed < self.priming_frames() {
            self.primed += 1;
            return;
        }

        while self.t < 1.0 {
            let f = self.t as f32;
            let mut out = [0.0f32; 2];
            for (c, slot) in out.iter_mut().enumerate().take(ch) {
                *slot = self.interpolate(c, f);
            }
            emit(out);
            self.t += self.step;
        }
        self.t -= 1.0;
    }
}

// ── Remote phone linear resampler (#39-#45) ───────────────────────────────────

/// Largest playout-rate trim the drift compensator may apply, in ppm. ±300 ppm
/// is ±0.03 % pitch — well under audibility, and only reached under sustained drift.
pub const MAX_TRIM_PPM: i32 = 300;

/// Linear-interpolation resampler for the remote phone feed. Drive it with
/// `process_frame` for each input frame; it emits zero or more output frames at
/// the target rate. Linear interpolation is modest quality (some high-frequency
/// aliasing) but correct and cheap.
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

    fn collect_mono(rs: &mut Resampler, inputs: &[f32]) -> Vec<f32> {
        let mut out = Vec::new();
        for &x in inputs {
            rs.process_frame(&[x], |y| out.push(y[0]));
        }
        out
    }

    fn collect_mono_linear(rs: &mut LinearResampler, inputs: &[f32]) -> Vec<f32> {
        let mut out = Vec::new();
        for &x in inputs {
            rs.process_frame(&[x], |y| out.push(y[0]));
        }
        out
    }

    #[test]
    fn upsamples_2x_with_midpoints() {
        let mut rs = Resampler::new(1, 2, 1, ResampleQuality::Fast);
        let out = collect_mono(&mut rs, &[0.0, 1.0, 2.0, 3.0]);
        // First input primes; then 2 outputs per input.
        assert_eq!(out, vec![0.0, 0.5, 1.0, 1.5, 2.0, 2.5]);
    }

    #[test]
    fn downsamples_2x_drops_every_other() {
        let mut rs = Resampler::new(2, 1, 1, ResampleQuality::Fast);
        let out = collect_mono(&mut rs, &[0.0, 1.0, 2.0, 3.0, 4.0]);
        // step = 2.0: one output per two inputs, taken at the interval's left
        // edge (the previous sample). First input primes history.
        assert_eq!(out, vec![0.0, 2.0]);
    }

    #[test]
    fn equal_rate_is_unit_delay_passthrough() {
        let mut rs = Resampler::new(48_000, 48_000, 1, ResampleQuality::Fast);
        let out = collect_mono(&mut rs, &[0.1, 0.2, 0.3, 0.4]);
        // step = 1.0: emits the previous sample each step — input delayed by one.
        assert_eq!(out, vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn stereo_channels_stay_independent_and_interleaved() {
        let mut rs = Resampler::new(1, 2, 2, ResampleQuality::Fast);
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
        let mut rs = Resampler::new(44_100, 48_000, 1, ResampleQuality::Fast);
        let inputs: Vec<f32> = (0..441).map(|i| i as f32).collect();
        let out = collect_mono(&mut rs, &inputs);
        let expected = ((inputs.len() - 1) as f64 * 48_000.0 / 44_100.0).round() as usize;
        assert!(
            (out.len() as i64 - expected as i64).abs() <= 1,
            "got {} outputs, expected ~{expected}",
            out.len()
        );
    }

    // ── Cubic (Quality) interpolation ─────────────────────────────────────────

    #[test]
    fn cubic_is_exact_on_linear_ramp() {
        // Catmull-Rom reproduces a linear ramp exactly: a ramp in gives a ramp
        // out, so consecutive outputs differ by a constant.
        let mut rs = Resampler::new(1, 2, 1, ResampleQuality::Quality);
        let out = collect_mono(&mut rs, &(0..12).map(|i| i as f32).collect::<Vec<_>>());
        assert!(out.len() > 4, "expected several outputs, got {}", out.len());
        let d0 = out[1] - out[0];
        for w in out.windows(2) {
            assert!(
                (w[1] - w[0] - d0).abs() < 1e-5,
                "cubic output of a ramp is not linear: {out:?}"
            );
        }
    }

    #[test]
    fn cubic_beats_linear_on_sine_error() {
        // Resample a 3 kHz sine from 44.1k to 48k with both modes; compare RMS
        // error against the ideal continuous signal at each output's true
        // input-time position.
        let in_rate = 44_100u32;
        let out_rate = 48_000u32;
        let freq = 3_000.0f64;
        let n_in = 4_410;
        let step = in_rate as f64 / out_rate as f64;

        let rms_error = |quality: ResampleQuality| -> f64 {
            let mut rs = Resampler::new(in_rate, out_rate, 1, quality);
            let mut outputs: Vec<f32> = Vec::new();
            for i in 0..n_in {
                let t = i as f64 / in_rate as f64;
                let s = (2.0 * std::f64::consts::PI * freq * t).sin() as f32;
                rs.process_frame(&[s], |y| outputs.push(y[0]));
            }
            // Output k interpolates at input index base + k*step, where the
            // anchor is the older frame of the interpolation pair: Fast anchors
            // at index 0, Quality at index 1 (hist[1] after a 3-frame priming
            // over inputs 0,1,2).
            let base = if quality == ResampleQuality::Fast {
                0.0
            } else {
                1.0
            };
            let skip = 64usize;
            let used = outputs.len() - 2 * skip;
            let mut err_sq = 0.0f64;
            for (k, &y) in outputs.iter().enumerate().skip(skip).take(used) {
                let t_in = (base + k as f64 * step) / in_rate as f64;
                let ideal = (2.0 * std::f64::consts::PI * freq * t_in).sin();
                err_sq += (y as f64 - ideal).powi(2);
            }
            (err_sq / used as f64).sqrt()
        };

        let linear = rms_error(ResampleQuality::Fast);
        let cubic = rms_error(ResampleQuality::Quality);
        assert!(
            cubic < linear * 0.5,
            "cubic ({cubic:.6}) should at least halve linear error ({linear:.6})"
        );
    }

    // ── nudge_ratio (drift-aware SRC) ─────────────────────────────────────────

    #[test]
    fn nudge_at_target_is_noop() {
        let mut rs = Resampler::new(44_100, 48_000, 1, ResampleQuality::Quality);
        let before = rs.step;
        rs.nudge_ratio(1440, 1440);
        assert_eq!(rs.step, before, "step must not change when fill == target");
    }

    #[test]
    fn nudge_above_target_increases_step() {
        let mut rs = Resampler::new(44_100, 48_000, 1, ResampleQuality::Quality);
        let before = rs.step;
        rs.nudge_ratio(2000, 1440);
        assert!(
            rs.step > before,
            "step must increase when ring is over-full"
        );
    }

    #[test]
    fn nudge_below_target_decreases_step() {
        let mut rs = Resampler::new(44_100, 48_000, 1, ResampleQuality::Quality);
        let before = rs.step;
        rs.nudge_ratio(500, 1440);
        assert!(rs.step < before, "step must decrease when ring is starved");
    }

    #[test]
    fn nudge_clamps_per_call_delta() {
        let mut rs = Resampler::new(48_000, 48_000, 1, ResampleQuality::Quality);
        let before = rs.step;
        // Extreme error (10× target): delta should still be <= DRIFT_MAX_STEP_DELTA.
        rs.nudge_ratio(14400, 1440);
        let delta = rs.step - before;
        assert!(
            delta <= DRIFT_MAX_STEP_DELTA + 1e-12,
            "per-call delta {delta} exceeded max {DRIFT_MAX_STEP_DELTA}"
        );
    }

    #[test]
    fn nudge_total_clamp_limits_accumulated_drift() {
        let mut rs = Resampler::new(48_000, 48_000, 1, ResampleQuality::Quality);
        let nominal = rs.nominal_step;
        // Apply 1000 nudges all in the same (over-full) direction.
        for _ in 0..1_000 {
            rs.nudge_ratio(10_000, 1440);
        }
        let max_allowed = nominal * (1.0 + DRIFT_RATIO_CLAMP) + 1e-12;
        assert!(
            rs.step <= max_allowed,
            "step {} exceeded nominal+1% clamp {}",
            rs.step,
            max_allowed
        );
        // And lower direction.
        let mut rs2 = Resampler::new(48_000, 48_000, 1, ResampleQuality::Quality);
        let nominal2 = rs2.nominal_step;
        for _ in 0..1_000 {
            rs2.nudge_ratio(0, 1440);
        }
        let min_allowed = nominal2 * (1.0 - DRIFT_RATIO_CLAMP) - 1e-12;
        assert!(
            rs2.step >= min_allowed,
            "step {} below nominal-1% clamp {}",
            rs2.step,
            min_allowed
        );
    }

    #[test]
    fn nudge_converges_toward_target() {
        // Simulate ring slowly draining as step increases: check step approaches
        // nominal+something and fill trends toward target.
        let mut rs = Resampler::new(48_000, 48_000, 1, ResampleQuality::Quality);
        let target = 1440usize;
        let mut fill = 3000usize;
        for _ in 0..200 {
            rs.nudge_ratio(fill, target);
            // Simulate: higher step = faster drain. Just model fill -= delta_drain.
            let drain = ((rs.step - rs.nominal_step) * 480.0 * 10.0) as usize;
            fill = fill.saturating_sub(drain.max(1));
            if fill <= target + 50 {
                break;
            }
        }
        assert!(
            fill <= target + 100,
            "fill {fill} did not converge to target {target} within 200 nudges"
        );
    }

    // ── LinearResampler (remote phone) ────────────────────────────────────────

    #[test]
    fn trim_zero_is_identity() {
        let inputs: Vec<f32> = (0..300).map(|i| i as f32 * 0.01).collect();
        let mut base = LinearResampler::new(48_000, 44_100, 1);
        let mut trimmed = LinearResampler::new(48_000, 44_100, 1);
        trimmed.set_trim_ppm(0);
        assert_eq!(
            collect_mono_linear(&mut base, &inputs),
            collect_mono_linear(&mut trimmed, &inputs)
        );
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
        let nf = collect_mono_linear(&mut faster, &inputs).len();
        let nb = collect_mono_linear(&mut base, &inputs).len();
        let ns = collect_mono_linear(&mut slower, &inputs).len();
        assert!(
            nf > nb && nb > ns,
            "−ppm→more, +ppm→fewer outputs: {nf} {nb} {ns}"
        );
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
