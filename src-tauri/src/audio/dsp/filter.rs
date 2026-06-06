use super::DspEffect;
use std::f32::consts::PI;

/// Butterworth Q = 1/√2 (maximally flat, -3 dB at cutoff).
const BUTTERWORTH_Q: f32 = std::f32::consts::FRAC_1_SQRT_2;

struct Coeffs {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
}

impl Coeffs {
    fn high_pass(freq: f32, q: f32, sr: f32) -> Self {
        let w0 = 2.0 * PI * freq / sr;
        let cos = w0.cos();
        let alpha = w0.sin() / (2.0 * q);
        let a0 = 1.0 + alpha;
        Self {
            b0: (1.0 + cos) * 0.5 / a0,
            b1: -(1.0 + cos) / a0,
            b2: (1.0 + cos) * 0.5 / a0,
            a1: -2.0 * cos / a0,
            a2: (1.0 - alpha) / a0,
        }
    }

    fn low_pass(freq: f32, q: f32, sr: f32) -> Self {
        let w0 = 2.0 * PI * freq / sr;
        let cos = w0.cos();
        let alpha = w0.sin() / (2.0 * q);
        let a0 = 1.0 + alpha;
        Self {
            b0: (1.0 - cos) * 0.5 / a0,
            b1: (1.0 - cos) / a0,
            b2: (1.0 - cos) * 0.5 / a0,
            a1: -2.0 * cos / a0,
            a2: (1.0 - alpha) / a0,
        }
    }

    fn peaking(freq: f32, q: f32, gain_db: f32, sr: f32) -> Self {
        let a = 10.0_f32.powf(gain_db / 40.0);
        let w0 = 2.0 * PI * freq / sr;
        let cos = w0.cos();
        let alpha = w0.sin() / (2.0 * q);
        let a0 = 1.0 + alpha / a;
        Self {
            b0: (1.0 + alpha * a) / a0,
            b1: -2.0 * cos / a0,
            b2: (1.0 - alpha * a) / a0,
            a1: -2.0 * cos / a0,
            a2: (1.0 - alpha / a) / a0,
        }
    }

    fn low_shelf(freq: f32, gain_db: f32, sr: f32) -> Self {
        let a = 10.0_f32.powf(gain_db / 40.0);
        let w0 = 2.0 * PI * freq / sr;
        let cos = w0.cos();
        let alpha = w0.sin() * 0.5 * 2.0_f32.sqrt(); // S = 1 slope
        let a0 = (a + 1.0) + (a - 1.0) * cos + 2.0 * a.sqrt() * alpha;
        Self {
            b0: a * ((a + 1.0) - (a - 1.0) * cos + 2.0 * a.sqrt() * alpha) / a0,
            b1: 2.0 * a * ((a - 1.0) - (a + 1.0) * cos) / a0,
            b2: a * ((a + 1.0) - (a - 1.0) * cos - 2.0 * a.sqrt() * alpha) / a0,
            a1: -2.0 * ((a - 1.0) + (a + 1.0) * cos) / a0,
            a2: ((a + 1.0) + (a - 1.0) * cos - 2.0 * a.sqrt() * alpha) / a0,
        }
    }

    fn high_shelf(freq: f32, gain_db: f32, sr: f32) -> Self {
        let a = 10.0_f32.powf(gain_db / 40.0);
        let w0 = 2.0 * PI * freq / sr;
        let cos = w0.cos();
        let alpha = w0.sin() * 0.5 * 2.0_f32.sqrt();
        let a0 = (a + 1.0) - (a - 1.0) * cos + 2.0 * a.sqrt() * alpha;
        Self {
            b0: a * ((a + 1.0) + (a - 1.0) * cos + 2.0 * a.sqrt() * alpha) / a0,
            b1: -2.0 * a * ((a - 1.0) + (a + 1.0) * cos) / a0,
            b2: a * ((a + 1.0) + (a - 1.0) * cos - 2.0 * a.sqrt() * alpha) / a0,
            a1: 2.0 * ((a - 1.0) - (a + 1.0) * cos) / a0,
            a2: ((a + 1.0) - (a - 1.0) * cos - 2.0 * a.sqrt() * alpha) / a0,
        }
    }

    fn notch(freq: f32, q: f32, sr: f32) -> Self {
        let w0 = 2.0 * PI * freq / sr;
        let cos = w0.cos();
        let alpha = w0.sin() / (2.0 * q);
        let a0 = 1.0 + alpha;
        Self {
            b0: 1.0 / a0,
            b1: -2.0 * cos / a0,
            b2: 1.0 / a0,
            a1: -2.0 * cos / a0,
            a2: (1.0 - alpha) / a0,
        }
    }

    /// `[b0, b1, b2, a1, a2]` for publishing across the realtime boundary.
    fn as_array(&self) -> [f32; 5] {
        [self.b0, self.b1, self.b2, self.a1, self.a2]
    }
}

/// Precompute high-pass coefficients off the realtime thread.
pub fn high_pass_coeffs(freq_hz: f32, sample_rate: f32) -> [f32; 5] {
    Coeffs::high_pass(freq_hz, BUTTERWORTH_Q, sample_rate).as_array()
}

/// Precompute peaking-band coefficients off the realtime thread.
pub fn peaking_coeffs(freq_hz: f32, q: f32, gain_db: f32, sample_rate: f32) -> [f32; 5] {
    Coeffs::peaking(freq_hz, q, gain_db, sample_rate).as_array()
}

/// Precompute low-pass coefficients with a user-supplied Q (EQ band variant).
pub fn low_pass_coeffs(freq_hz: f32, q: f32, sample_rate: f32) -> [f32; 5] {
    Coeffs::low_pass(freq_hz, q, sample_rate).as_array()
}

/// Precompute high-pass coefficients with a user-supplied Q (EQ band variant).
/// The dedicated HPF effect uses [`high_pass_coeffs`] (fixed Butterworth Q).
pub fn high_pass_coeffs_q(freq_hz: f32, q: f32, sample_rate: f32) -> [f32; 5] {
    Coeffs::high_pass(freq_hz, q, sample_rate).as_array()
}

/// Precompute low-shelf coefficients off the realtime thread.
pub fn low_shelf_coeffs(freq_hz: f32, gain_db: f32, sample_rate: f32) -> [f32; 5] {
    Coeffs::low_shelf(freq_hz, gain_db, sample_rate).as_array()
}

/// Precompute high-shelf coefficients off the realtime thread.
pub fn high_shelf_coeffs(freq_hz: f32, gain_db: f32, sample_rate: f32) -> [f32; 5] {
    Coeffs::high_shelf(freq_hz, gain_db, sample_rate).as_array()
}

/// Precompute notch coefficients off the realtime thread.
pub fn notch_coeffs(freq_hz: f32, q: f32, sample_rate: f32) -> [f32; 5] {
    Coeffs::notch(freq_hz, q, sample_rate).as_array()
}

/// 2nd-order IIR biquad filter (Audio EQ Cookbook, R. Bristow-Johnson).
/// Direct Form I — per-channel state, numerically stable.
/// Modes: HPF, LPF, peaking bell, low shelf, high shelf, notch.
pub struct BiquadFilter {
    coeffs: Coeffs,
    enabled: bool,
    x1: [f32; 2],
    x2: [f32; 2],
    y1: [f32; 2],
    y2: [f32; 2],
}

impl BiquadFilter {
    /// 2nd-order Butterworth high-pass.
    pub fn high_pass(freq_hz: f32, sample_rate: f32) -> Self {
        Self::from_coeffs(Coeffs::high_pass(freq_hz, BUTTERWORTH_Q, sample_rate))
    }

    /// 2nd-order Butterworth low-pass.
    pub fn low_pass(freq_hz: f32, sample_rate: f32) -> Self {
        Self::from_coeffs(Coeffs::low_pass(freq_hz, BUTTERWORTH_Q, sample_rate))
    }

    /// Peaking (bell) EQ band. q: bandwidth (0.5–4.0 typical), gain_db: boost/cut.
    pub fn peaking(freq_hz: f32, q: f32, gain_db: f32, sample_rate: f32) -> Self {
        Self::from_coeffs(Coeffs::peaking(freq_hz, q, gain_db, sample_rate))
    }

    /// Low shelving filter. gain_db: boost/cut below freq_hz.
    pub fn low_shelf(freq_hz: f32, gain_db: f32, sample_rate: f32) -> Self {
        Self::from_coeffs(Coeffs::low_shelf(freq_hz, gain_db, sample_rate))
    }

    /// High shelving filter. gain_db: boost/cut above freq_hz.
    pub fn high_shelf(freq_hz: f32, gain_db: f32, sample_rate: f32) -> Self {
        Self::from_coeffs(Coeffs::high_shelf(freq_hz, gain_db, sample_rate))
    }

    /// Notch (band-reject) filter. q sets the notch width.
    pub fn notch(freq_hz: f32, q: f32, sample_rate: f32) -> Self {
        Self::from_coeffs(Coeffs::notch(freq_hz, q, sample_rate))
    }

    pub fn set_enabled(&mut self, v: bool) {
        self.enabled = v;
    }

    /// Replace the filter coefficients in place, preserving the per-channel
    /// delay state (`x1/x2/y1/y2`). Lets the realtime thread retune a band from
    /// precomputed coefficients without a click. Accepts `[b0, b1, b2, a1, a2]`.
    pub fn set_coeffs(&mut self, c: [f32; 5]) {
        self.coeffs = Coeffs {
            b0: c[0],
            b1: c[1],
            b2: c[2],
            a1: c[3],
            a2: c[4],
        };
    }

    fn from_coeffs(coeffs: Coeffs) -> Self {
        Self {
            coeffs,
            enabled: true,
            x1: [0.0; 2],
            x2: [0.0; 2],
            y1: [0.0; 2],
            y2: [0.0; 2],
        }
    }

    #[inline(always)]
    fn tick(&mut self, x: f32, ch: usize) -> f32 {
        let c = &self.coeffs;
        let y = c.b0 * x + c.b1 * self.x1[ch] + c.b2 * self.x2[ch]
            - c.a1 * self.y1[ch]
            - c.a2 * self.y2[ch];
        self.x2[ch] = self.x1[ch];
        self.x1[ch] = x;
        self.y2[ch] = self.y1[ch];
        self.y1[ch] = y;
        y
    }
}

impl DspEffect for BiquadFilter {
    #[inline(always)]
    fn process(&mut self, buf: &mut [f32; 2], channels: usize) {
        buf[0] = self.tick(buf[0], 0);
        if channels == 2 {
            buf[1] = self.tick(buf[1], 1);
        }
    }

    fn reset(&mut self) {
        self.x1 = [0.0; 2];
        self.x2 = [0.0; 2];
        self.y1 = [0.0; 2];
        self.y2 = [0.0; 2];
    }

    fn is_enabled(&self) -> bool {
        self.enabled
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coeff_helpers_match_constructors() {
        let from_fn = high_pass_coeffs(120.0, 48_000.0);
        let from_ctor = BiquadFilter::high_pass(120.0, 48_000.0);
        assert_eq!(from_fn, from_ctor.coeffs.as_array());

        let peak_fn = peaking_coeffs(2_000.0, 1.2, 4.0, 48_000.0);
        let peak_ctor = BiquadFilter::peaking(2_000.0, 1.2, 4.0, 48_000.0);
        assert_eq!(peak_fn, peak_ctor.coeffs.as_array());

        // Butterworth Q feeds the q-variants, so they match the fixed-Q ctors.
        assert_eq!(
            low_pass_coeffs(5_000.0, BUTTERWORTH_Q, 48_000.0),
            BiquadFilter::low_pass(5_000.0, 48_000.0).coeffs.as_array()
        );
        assert_eq!(
            high_pass_coeffs_q(120.0, BUTTERWORTH_Q, 48_000.0),
            BiquadFilter::high_pass(120.0, 48_000.0).coeffs.as_array()
        );
        assert_eq!(
            low_shelf_coeffs(200.0, 6.0, 48_000.0),
            BiquadFilter::low_shelf(200.0, 6.0, 48_000.0).coeffs.as_array()
        );
        assert_eq!(
            high_shelf_coeffs(8_000.0, -4.0, 48_000.0),
            BiquadFilter::high_shelf(8_000.0, -4.0, 48_000.0).coeffs.as_array()
        );
        assert_eq!(
            notch_coeffs(1_000.0, 4.0, 48_000.0),
            BiquadFilter::notch(1_000.0, 4.0, 48_000.0).coeffs.as_array()
        );
    }

    #[test]
    fn all_band_helpers_finite() {
        for c in [
            low_pass_coeffs(5_000.0, 0.7, 48_000.0),
            high_pass_coeffs_q(80.0, 1.5, 48_000.0),
            low_shelf_coeffs(120.0, 9.0, 48_000.0),
            high_shelf_coeffs(10_000.0, -12.0, 48_000.0),
            notch_coeffs(2_000.0, 8.0, 48_000.0),
        ] {
            assert!(c.iter().all(|v| v.is_finite()));
        }
    }

    #[test]
    fn set_coeffs_preserves_delay_state() {
        let mut f = BiquadFilter::high_pass(100.0, 48_000.0);
        // Prime the delay state.
        f.process(&mut [0.7, 0.7], 2);
        let saved = (f.x1, f.x2, f.y1, f.y2);
        f.set_coeffs(peaking_coeffs(3_000.0, 1.0, 6.0, 48_000.0));
        // Coefficients changed; history untouched (no click).
        assert_eq!(
            f.coeffs.as_array(),
            peaking_coeffs(3_000.0, 1.0, 6.0, 48_000.0)
        );
        assert_eq!((f.x1, f.x2, f.y1, f.y2), saved);
    }

    #[test]
    fn retuned_filter_stays_finite() {
        let mut f = BiquadFilter::high_pass(80.0, 48_000.0);
        for i in 0..256 {
            if i == 128 {
                f.set_coeffs(high_pass_coeffs(200.0, 48_000.0));
            }
            let mut buf = [0.5, -0.5];
            f.process(&mut buf, 2);
            assert!(buf[0].is_finite() && buf[1].is_finite());
        }
    }
}
