use super::DspEffect;

#[inline(always)]
fn db_to_lin(db: f32) -> f32 {
    10.0_f32.powf(db / 20.0)
}

#[inline(always)]
fn lin_to_db(lin: f32) -> f32 {
    20.0 * (lin + 1e-10_f32).log10()
}

#[inline(always)]
fn ms_to_coeff(ms: f32, sr: f32) -> f32 {
    if ms <= 0.0 {
        return 0.0;
    }
    (-1.0 / (ms * 0.001 * sr)).exp()
}

/// Compressor coefficients precomputed on the IPC thread so the realtime
/// callback retunes via [`Compressor::set_coeffs`] without running `exp`/`powf`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CompressorCoeffs {
    pub threshold_db: f32,
    pub ratio: f32,
    pub makeup_lin: f32,
    pub env_attack: f32,
    pub env_release: f32,
    /// Retained for the live (seqlock) wire format only; the runtime compressor
    /// no longer applies a second gain-smoothing pass (see `Compressor::process`).
    pub gain_attack: f32,
    pub gain_release: f32,
}

impl CompressorCoeffs {
    pub fn compute(
        threshold_db: f32,
        ratio: f32,
        attack_ms: f32,
        release_ms: f32,
        makeup_db: f32,
        sample_rate: f32,
    ) -> Self {
        Self {
            threshold_db,
            ratio: ratio.max(1.0),
            makeup_lin: db_to_lin(makeup_db),
            env_attack: ms_to_coeff(attack_ms, sample_rate),
            env_release: ms_to_coeff(release_ms, sample_rate),
            gain_attack: ms_to_coeff(attack_ms, sample_rate),
            gain_release: ms_to_coeff(release_ms, sample_rate),
        }
    }
}

/// Feed-forward VCA compressor with peak envelope detection.
/// Hard knee. Attack/release ballistics live in the peak envelope follower;
/// the gain computer is static so the configured attack/release apply exactly
/// once (a second gain-smoothing pass previously ~doubled the effective times).
///
/// Typical voice settings: threshold −18 dB, ratio 4:1, attack 5 ms,
/// release 80 ms, makeup_db to taste (0–6 dB).
pub struct Compressor {
    threshold_db: f32,
    ratio: f32,
    makeup_lin: f32,
    env_attack: f32,
    env_release: f32,
    envelope: f32,
    gain_db: f32,
    enabled: bool,
}

impl Compressor {
    pub fn new(
        threshold_db: f32,
        ratio: f32,
        attack_ms: f32,
        release_ms: f32,
        makeup_db: f32,
        sample_rate: f32,
    ) -> Self {
        Self {
            threshold_db,
            ratio: ratio.max(1.0),
            makeup_lin: db_to_lin(makeup_db),
            env_attack: ms_to_coeff(attack_ms, sample_rate),
            env_release: ms_to_coeff(release_ms, sample_rate),
            envelope: 0.0,
            gain_db: 0.0,
            enabled: true,
        }
    }

    pub fn set_enabled(&mut self, v: bool) {
        self.enabled = v;
    }

    /// Retune from precomputed coefficients in place, preserving the envelope
    /// and current gain reduction so a live parameter change does not pop.
    pub fn set_coeffs(&mut self, c: CompressorCoeffs) {
        self.threshold_db = c.threshold_db;
        self.ratio = c.ratio;
        self.makeup_lin = c.makeup_lin;
        self.env_attack = c.env_attack;
        self.env_release = c.env_release;
    }
}

impl DspEffect for Compressor {
    #[inline(always)]
    fn process(&mut self, buf: &mut [f32; 2], channels: usize) {
        let peak = if channels == 2 {
            buf[0].abs().max(buf[1].abs())
        } else {
            buf[0].abs()
        };

        // Peak envelope follower with separate attack / release.
        let env_coeff = if peak > self.envelope {
            self.env_attack
        } else {
            self.env_release
        };
        self.envelope = self.envelope * env_coeff + peak * (1.0 - env_coeff);

        // Static gain reduction in dB (hard knee), derived directly from the
        // smoothed envelope. The attack/release ballistics already live in the
        // envelope follower above; smoothing the gain here too cascaded two
        // identical one-poles and ~doubled the effective attack/release.
        let level_db = lin_to_db(self.envelope);
        self.gain_db = if level_db > self.threshold_db {
            (self.threshold_db - level_db) * (1.0 - 1.0 / self.ratio)
        } else {
            0.0
        };

        let gain = db_to_lin(self.gain_db) * self.makeup_lin;
        buf[0] *= gain;
        if channels == 2 {
            buf[1] *= gain;
        }
    }

    fn reset(&mut self) {
        self.envelope = 0.0;
        self.gain_db = 0.0;
    }

    fn is_enabled(&self) -> bool {
        self.enabled
    }
}

/// Brick-wall peak limiter. Ratio = ∞, threshold settable.
/// Place last in chain to catch inter-effect overshoots.
///
/// Default: threshold −0.3 dBFS, attack 0.5 ms, release 100 ms.
pub struct Limiter {
    threshold_lin: f32,
    attack: f32,
    release: f32,
    envelope: f32,
    enabled: bool,
}

/// Limiter coefficients precomputed on the IPC thread.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LimiterCoeffs {
    pub threshold_lin: f32,
    pub attack: f32,
    pub release: f32,
}

impl LimiterCoeffs {
    pub fn compute(threshold_db: f32, attack_ms: f32, release_ms: f32, sample_rate: f32) -> Self {
        Self {
            threshold_lin: db_to_lin(threshold_db),
            attack: ms_to_coeff(attack_ms, sample_rate),
            release: ms_to_coeff(release_ms, sample_rate),
        }
    }
}

impl Limiter {
    pub fn new(threshold_db: f32, attack_ms: f32, release_ms: f32, sample_rate: f32) -> Self {
        Self {
            threshold_lin: db_to_lin(threshold_db),
            attack: ms_to_coeff(attack_ms, sample_rate),
            release: ms_to_coeff(release_ms, sample_rate),
            envelope: 0.0,
            enabled: true,
        }
    }

    /// Typical output limiter at −0.3 dBFS.
    pub fn output(sample_rate: f32) -> Self {
        Self::new(-0.3, 0.5, 100.0, sample_rate)
    }

    pub fn set_enabled(&mut self, v: bool) {
        self.enabled = v;
    }

    /// Retune from precomputed coefficients in place, preserving the envelope.
    pub fn set_coeffs(&mut self, c: LimiterCoeffs) {
        self.threshold_lin = c.threshold_lin;
        self.attack = c.attack;
        self.release = c.release;
    }
}

impl DspEffect for Limiter {
    #[inline(always)]
    fn process(&mut self, buf: &mut [f32; 2], channels: usize) {
        let peak = if channels == 2 {
            buf[0].abs().max(buf[1].abs())
        } else {
            buf[0].abs()
        };

        let coeff = if peak > self.envelope {
            self.attack
        } else {
            self.release
        };
        self.envelope = self.envelope * coeff + peak * (1.0 - coeff);

        if self.envelope > self.threshold_lin {
            let gain = self.threshold_lin / self.envelope;
            buf[0] *= gain;
            if channels == 2 {
                buf[1] *= gain;
            }
        }
    }

    fn reset(&mut self) {
        self.envelope = 0.0;
    }
    fn is_enabled(&self) -> bool {
        self.enabled
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comp_compute_matches_new() {
        let c = CompressorCoeffs::compute(-18.0, 4.0, 5.0, 80.0, 0.0, 48_000.0);
        let r = Compressor::new(-18.0, 4.0, 5.0, 80.0, 0.0, 48_000.0);
        assert_eq!(c.threshold_db, r.threshold_db);
        assert_eq!(c.ratio, r.ratio);
        assert!((c.makeup_lin - r.makeup_lin).abs() < 1e-9);
        assert!((c.env_attack - r.env_attack).abs() < 1e-9);
        assert!((c.env_release - r.env_release).abs() < 1e-9);
    }

    #[test]
    fn comp_compute_clamps_ratio() {
        let c = CompressorCoeffs::compute(-18.0, 0.1, 5.0, 80.0, 0.0, 48_000.0);
        assert_eq!(c.ratio, 1.0);
    }

    #[test]
    fn comp_set_coeffs_preserves_envelope() {
        let mut comp = Compressor::new(-18.0, 4.0, 5.0, 80.0, 0.0, 48_000.0);
        for _ in 0..64 {
            comp.process(&mut [0.9, 0.9], 2);
        }
        let saved = (comp.envelope, comp.gain_db);
        comp.set_coeffs(CompressorCoeffs::compute(
            -24.0, 8.0, 2.0, 120.0, 3.0, 48_000.0,
        ));
        assert_eq!((comp.envelope, comp.gain_db), saved);
        assert_eq!(comp.ratio, 8.0);
    }

    #[test]
    fn comp_gain_tracks_envelope_without_second_smoothing() {
        // With the redundant gain-smoothing pass removed, gain_db is the
        // instantaneous static hard-knee target of the current envelope at every
        // sample — no extra lag. The old double-smoothed code failed this.
        let mut comp = Compressor::new(-18.0, 4.0, 5.0, 80.0, 0.0, 48_000.0);
        let levels = [0.9_f32, 0.1, 0.5, 0.02, 0.7];
        for &lv in levels.iter().cycle().take(200) {
            comp.process(&mut [lv, lv], 2);
            let level_db = lin_to_db(comp.envelope);
            let target = if level_db > -18.0 {
                (-18.0 - level_db) * (1.0 - 1.0 / 4.0)
            } else {
                0.0
            };
            assert!((comp.gain_db - target).abs() < 1e-6);
        }
    }

    #[test]
    fn limiter_compute_and_set_preserves_envelope() {
        let lc = LimiterCoeffs::compute(-1.0, 0.5, 100.0, 48_000.0);
        assert!((lc.threshold_lin - db_to_lin(-1.0)).abs() < 1e-9);
        let mut lim = Limiter::output(48_000.0);
        for _ in 0..64 {
            lim.process(&mut [0.95, 0.95], 2);
        }
        let env = lim.envelope;
        lim.set_coeffs(lc);
        assert_eq!(lim.envelope, env);
        assert!((lim.threshold_lin - db_to_lin(-1.0)).abs() < 1e-9);
    }
}
