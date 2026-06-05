use super::DspEffect;
use std::f32::consts::PI;

/// Butterworth Q (maximally flat, -3 dB at cutoff).
const BUTTERWORTH_Q: f32 = 0.707_107;

struct Coeffs {
    b0: f32, b1: f32, b2: f32,
    a1: f32, a2: f32,
}

impl Coeffs {
    fn high_pass(freq: f32, q: f32, sr: f32) -> Self {
        let w0 = 2.0 * PI * freq / sr;
        let cos = w0.cos();
        let alpha = w0.sin() / (2.0 * q);
        let a0 = 1.0 + alpha;
        Self {
            b0:  (1.0 + cos) * 0.5 / a0,
            b1: -(1.0 + cos) / a0,
            b2:  (1.0 + cos) * 0.5 / a0,
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
            b0:  (1.0 + alpha * a) / a0,
            b1: -2.0 * cos / a0,
            b2:  (1.0 - alpha * a) / a0,
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
            b0:  a * ((a + 1.0) - (a - 1.0) * cos + 2.0 * a.sqrt() * alpha) / a0,
            b1:  2.0 * a * ((a - 1.0) - (a + 1.0) * cos) / a0,
            b2:  a * ((a + 1.0) - (a - 1.0) * cos - 2.0 * a.sqrt() * alpha) / a0,
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
            b0:   a * ((a + 1.0) + (a - 1.0) * cos + 2.0 * a.sqrt() * alpha) / a0,
            b1: -2.0 * a * ((a - 1.0) + (a + 1.0) * cos) / a0,
            b2:   a * ((a + 1.0) + (a - 1.0) * cos - 2.0 * a.sqrt() * alpha) / a0,
            a1:   2.0 * ((a - 1.0) - (a + 1.0) * cos) / a0,
            a2: ((a + 1.0) - (a - 1.0) * cos - 2.0 * a.sqrt() * alpha) / a0,
        }
    }
}

/// 2nd-order IIR biquad filter (Audio EQ Cookbook, R. Bristow-Johnson).
/// Direct Form I — per-channel state, numerically stable.
/// Modes: HPF, LPF, peaking bell, low shelf, high shelf.
pub struct BiquadFilter {
    coeffs: Coeffs,
    enabled: bool,
    x1: [f32; 2], x2: [f32; 2],
    y1: [f32; 2], y2: [f32; 2],
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

    pub fn set_enabled(&mut self, v: bool) { self.enabled = v; }

    fn from_coeffs(coeffs: Coeffs) -> Self {
        Self {
            coeffs, enabled: true,
            x1: [0.0; 2], x2: [0.0; 2],
            y1: [0.0; 2], y2: [0.0; 2],
        }
    }

    #[inline(always)]
    fn tick(&mut self, x: f32, ch: usize) -> f32 {
        let c = &self.coeffs;
        let y = c.b0 * x + c.b1 * self.x1[ch] + c.b2 * self.x2[ch]
              - c.a1 * self.y1[ch] - c.a2 * self.y2[ch];
        self.x2[ch] = self.x1[ch]; self.x1[ch] = x;
        self.y2[ch] = self.y1[ch]; self.y1[ch] = y;
        y
    }
}

impl DspEffect for BiquadFilter {
    #[inline(always)]
    fn process(&mut self, buf: &mut [f32; 2], channels: usize) {
        buf[0] = self.tick(buf[0], 0);
        if channels == 2 { buf[1] = self.tick(buf[1], 1); }
    }

    fn reset(&mut self) {
        self.x1 = [0.0; 2]; self.x2 = [0.0; 2];
        self.y1 = [0.0; 2]; self.y2 = [0.0; 2];
    }

    fn is_enabled(&self) -> bool { self.enabled }
}
