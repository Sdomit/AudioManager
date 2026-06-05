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

        if peak >= self.threshold_lin {
            self.open = true;
            self.hold_counter = self.hold_samples;
        } else if self.hold_counter > 0 {
            self.hold_counter -= 1;
        } else {
            self.open = false;
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
