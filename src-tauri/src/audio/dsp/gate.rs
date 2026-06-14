use super::DspEffect;

#[inline(always)]
fn db_to_lin(db: f32) -> f32 {
    10.0_f32.powf(db / 20.0)
}

#[inline(always)]
fn ms_to_coeff(ms: f32, sr: f32) -> f32 {
    if ms <= 0.0 {
        return 0.0;
    }
    (-1.0 / (ms * 0.001 * sr)).exp()
}

/// Gate hysteresis: once open, the gate stays open until the signal falls this
/// many dB below the open threshold. Prevents on/off chatter when the level
/// hovers around the threshold. The hold counter adds time-hysteresis on top.
const HYSTERESIS_DB: f32 = 3.0;

/// Gate coefficients, precomputed on the IPC thread so the realtime callback
/// retunes via [`NoiseGate::set_coeffs`] without running `exp`/`powf`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GateCoeffs {
    pub threshold_lin: f32,
    pub attack_coeff: f32,
    pub release_coeff: f32,
    pub hold_samples: u32,
}

impl GateCoeffs {
    pub fn compute(
        threshold_db: f32,
        attack_ms: f32,
        release_ms: f32,
        hold_ms: f32,
        sample_rate: f32,
    ) -> Self {
        Self {
            threshold_lin: db_to_lin(threshold_db),
            attack_coeff: ms_to_coeff(attack_ms, sample_rate),
            release_coeff: ms_to_coeff(release_ms, sample_rate),
            hold_samples: (hold_ms * 0.001 * sample_rate) as u32,
        }
    }
}

/// Noise gate: silences signal below `threshold_db` after `hold` expires.
/// Uses a one-pole envelope follower + hold counter + gain ramp.
///
/// Typical voice settings: threshold −40 dB, attack 10 ms, hold 80 ms, release 150 ms.
pub struct NoiseGate {
    threshold_lin: f32,
    /// Lower threshold the level must fall below before the gate begins to
    /// close (open threshold minus [`HYSTERESIS_DB`]). Derived, not transmitted.
    close_threshold_lin: f32,
    attack_coeff: f32,
    release_coeff: f32,
    hold_samples: u32,
    hold_counter: u32,
    gain: f32,
    open: bool,
    enabled: bool,
}

impl NoiseGate {
    pub fn new(
        threshold_db: f32,
        attack_ms: f32,
        release_ms: f32,
        hold_ms: f32,
        sample_rate: f32,
    ) -> Self {
        Self {
            threshold_lin: db_to_lin(threshold_db),
            close_threshold_lin: db_to_lin(threshold_db - HYSTERESIS_DB),
            attack_coeff: ms_to_coeff(attack_ms, sample_rate),
            release_coeff: ms_to_coeff(release_ms, sample_rate),
            hold_samples: (hold_ms * 0.001 * sample_rate) as u32,
            hold_counter: 0,
            gain: 0.0,
            open: false,
            enabled: true,
        }
    }

    pub fn set_enabled(&mut self, v: bool) {
        self.enabled = v;
    }

    /// Retune from precomputed coefficients in place, preserving the envelope,
    /// open flag, and hold counter so a live parameter change does not pop.
    pub fn set_coeffs(&mut self, c: GateCoeffs) {
        self.threshold_lin = c.threshold_lin;
        // GateCoeffs carries only the linear threshold, so derive the close
        // threshold in the linear domain: ×db_to_lin(−HYSTERESIS_DB) is exactly
        // −HYSTERESIS_DB, matching `new()`'s db_to_lin(threshold_db − HYSTERESIS_DB).
        self.close_threshold_lin = c.threshold_lin * db_to_lin(-HYSTERESIS_DB);
        self.attack_coeff = c.attack_coeff;
        self.release_coeff = c.release_coeff;
        self.hold_samples = c.hold_samples;
    }
}

impl DspEffect for NoiseGate {
    #[inline(always)]
    fn process(&mut self, buf: &mut [f32; 2], channels: usize) {
        let peak = if channels == 2 {
            buf[0].abs().max(buf[1].abs())
        } else {
            buf[0].abs()
        };

        // Hysteresis: opening requires crossing the (higher) open threshold;
        // once open, the gate only begins to close after the level drops below
        // the (lower) close threshold and the hold counter expires.
        if self.open {
            if peak >= self.close_threshold_lin {
                self.hold_counter = self.hold_samples;
            } else if self.hold_counter > 0 {
                self.hold_counter -= 1;
            } else {
                self.open = false;
            }
        } else if peak >= self.threshold_lin {
            self.open = true;
            self.hold_counter = self.hold_samples;
        }

        let target = if self.open { 1.0_f32 } else { 0.0_f32 };
        let coeff = if self.open {
            self.attack_coeff
        } else {
            self.release_coeff
        };
        self.gain = target + coeff * (self.gain - target);

        buf[0] *= self.gain;
        if channels == 2 {
            buf[1] *= self.gain;
        }
    }

    fn reset(&mut self) {
        self.gain = 0.0;
        self.open = false;
        self.hold_counter = 0;
    }

    fn is_enabled(&self) -> bool {
        self.enabled
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compute_matches_new() {
        let c = GateCoeffs::compute(-40.0, 10.0, 150.0, 80.0, 48_000.0);
        assert!((c.threshold_lin - db_to_lin(-40.0)).abs() < 1e-9);
        assert_eq!(c.hold_samples, (0.080 * 48_000.0) as u32);
        assert!(c.attack_coeff > 0.0 && c.attack_coeff < 1.0);
        assert!(c.release_coeff > 0.0 && c.release_coeff < 1.0);
    }

    #[test]
    fn hysteresis_holds_gate_open_between_thresholds() {
        // threshold −40 dB, hysteresis 3 dB → close at −43 dB.
        let mut g = NoiseGate::new(-40.0, 1.0, 1.0, 0.0, 48_000.0);
        // Open with a loud frame.
        g.process(&mut [0.5, 0.5], 2);
        assert!(g.open);
        // Level between close (−43 dB) and open (−40 dB): a single-threshold
        // gate would start closing here; with hysteresis it stays open.
        let mid = db_to_lin(-41.5);
        for _ in 0..2_000 {
            g.process(&mut [mid, mid], 2);
        }
        assert!(g.open, "gate chattered closed inside the hysteresis band");
        // Drop below the close threshold: gate closes once hold expires (hold 0).
        let quiet = db_to_lin(-50.0);
        for _ in 0..8 {
            g.process(&mut [quiet, quiet], 2);
        }
        assert!(!g.open, "gate failed to close below the close threshold");
    }

    #[test]
    fn set_coeffs_preserves_runtime_state() {
        let mut g = NoiseGate::new(-40.0, 10.0, 150.0, 80.0, 48_000.0);
        // Drive a loud frame to open the gate and arm the hold counter.
        g.process(&mut [0.9, 0.9], 2);
        let saved = (g.gain, g.open, g.hold_counter);
        g.set_coeffs(GateCoeffs::compute(-20.0, 5.0, 100.0, 40.0, 48_000.0));
        assert_eq!((g.gain, g.open, g.hold_counter), saved);
        assert!((g.threshold_lin - db_to_lin(-20.0)).abs() < 1e-9);
    }
}
