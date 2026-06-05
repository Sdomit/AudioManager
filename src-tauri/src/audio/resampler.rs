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

/// Max step delta per `nudge_ratio` call — ±0.1 % of nominal.
const DRIFT_MAX_STEP_DELTA: f64 = 0.001;
/// Proportional gain applied to (fill − target) / target.
const DRIFT_P_GAIN: f64 = 0.05;
/// Hard clamp: step never drifts more than ±1 % from nominal.
const DRIFT_RATIO_CLAMP: f64 = 0.01;

/// Per-stream resampler state. Drive it with `process_frame` for each input
/// frame; it emits zero or more output frames at the target rate.
pub struct LinearResampler {
    /// Nominal ratio = in_rate / out_rate, never modified after construction.
    nominal_step: f64,
    /// Current (drift-adjusted) ratio. Nudged each block by `nudge_ratio`.
    step: f64,
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
        let nominal = in_rate as f64 / out_rate as f64;
        Self {
            nominal_step: nominal,
            step: nominal,
            t: 0.0,
            prev: [0.0; 2],
            channels: channels.clamp(1, 2),
            started: false,
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

    // ── nudge_ratio (drift-aware SRC) ─────────────────────────────────────────

    #[test]
    fn nudge_at_target_is_noop() {
        let mut rs = LinearResampler::new(44_100, 48_000, 1);
        let before = rs.step;
        rs.nudge_ratio(1440, 1440);
        assert_eq!(rs.step, before, "step must not change when fill == target");
    }

    #[test]
    fn nudge_above_target_increases_step() {
        let mut rs = LinearResampler::new(44_100, 48_000, 1);
        let before = rs.step;
        rs.nudge_ratio(2000, 1440);
        assert!(rs.step > before, "step must increase when ring is over-full");
    }

    #[test]
    fn nudge_below_target_decreases_step() {
        let mut rs = LinearResampler::new(44_100, 48_000, 1);
        let before = rs.step;
        rs.nudge_ratio(500, 1440);
        assert!(rs.step < before, "step must decrease when ring is starved");
    }

    #[test]
    fn nudge_clamps_per_call_delta() {
        let mut rs = LinearResampler::new(48_000, 48_000, 1);
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
        let mut rs = LinearResampler::new(48_000, 48_000, 1);
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
        let mut rs2 = LinearResampler::new(48_000, 48_000, 1);
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
        let mut rs = LinearResampler::new(48_000, 48_000, 1);
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
}
