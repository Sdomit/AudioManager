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

/// Hysteresis: the gate closes 3 dB below the level it opens at, so a signal
/// hovering around the threshold can't chatter the gate open/closed. Derived
/// internally from the open threshold (no extra config field).
/// `10^(-3 dB / 20)` ≈ 0.7079.
const GATE_HYSTERESIS_RATIO: f32 = 0.707_946;

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
/// Uses a hold counter + gain ramp with 3 dB of threshold hysteresis (opens at
/// `threshold_db`, closes 3 dB lower) so signal near the threshold cannot
/// chatter the gate.
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

        // Hysteresis: open at `threshold_lin`, close only once the signal drops
        // 3 dB below it. Between the two thresholds the gate sustains its current
        // state, so a signal riding the threshold cannot chatter.
        if peak >= self.threshold_lin {
            self.open = true;
            self.hold_counter = self.hold_samples;
        } else if peak < self.threshold_lin * GATE_HYSTERESIS_RATIO {
            if self.hold_counter > 0 {
                self.hold_counter -= 1;
            } else {
                self.open = false;
            }
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
    fn hysteresis_band_keeps_open_gate_open() {
        // threshold -40 dB; close threshold is 3 dB lower (~-43 dB). attack/
        // release/hold = 0 so gain and closing are immediate, isolating the
        // open/close state machine.
        let mut g = NoiseGate::new(-40.0, 0.0, 0.0, 0.0, 48_000.0);
        g.process(&mut [0.5, 0.0], 1); // loud → opens
        assert!(g.open);
        // A sample inside the hysteresis band (below open, above close) must NOT
        // close the gate.
        g.process(&mut [db_to_lin(-41.5), 0.0], 1);
        assert!(g.open, "band signal must keep an open gate open");
        // Dropping below the close threshold closes it (hold = 0).
        g.process(&mut [db_to_lin(-50.0), 0.0], 1);
        assert!(!g.open, "signal below close threshold must close the gate");
    }

    #[test]
    fn hysteresis_band_does_not_open_closed_gate() {
        let mut g = NoiseGate::new(-40.0, 0.0, 0.0, 0.0, 48_000.0);
        assert!(!g.open);
        // In the band but below the open threshold: a closed gate stays closed.
        g.process(&mut [db_to_lin(-41.5), 0.0], 1);
        assert!(!g.open, "band signal below open threshold must not open the gate");
        // Only crossing the open threshold opens it.
        g.process(&mut [db_to_lin(-39.0), 0.0], 1);
        assert!(g.open, "crossing the open threshold opens the gate");
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
