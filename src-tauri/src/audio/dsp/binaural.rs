//! Parametric binaural panning (#binaural).
//!
//! Places a **mono** point source around the listener's head for **headphone**
//! playback, reproducing the three direction cues the auditory system uses —
//! without an HRIR dataset (closed-form coefficients, bounded CPU):
//!
//! * **ITD** (interaural time difference) — a per-ear fractional delay from the
//!   Woodworth spherical-head model `τ = (a/c)(θ + sinθ)`. Dominant left/right cue.
//! * **ILD** (interaural level difference) — a high-shelf cut + small broadband
//!   trim on the far (shadowed) ear, growing with lateral angle.
//! * **Front/back** — a pinna-style spectral dip that deepens as the source moves
//!   behind the head, resolving the ITD/ILD front-vs-back ambiguity. The same
//!   dip carries the distance HF roll-off.
//!
//! Coefficients are computed off the realtime thread ([`BinauralCoeffs::compute`])
//! and pushed in; [`BinauralState::process`] runs only delay-line + biquad math
//! per sample — no allocation, locks, or transcendentals on the audio thread.
//! Ring buffers are sized once in [`BinauralState::new`].
//!
//! Measured-HRIR convolution is a future fidelity upgrade behind the same
//! `SpatialConfig`; only the per-ear filter block would change.

use std::f32::consts::FRAC_PI_2;

use super::config::SpatialConfig;
use super::filter::{high_shelf_coeffs, peaking_coeffs, BiquadFilter};
use super::DspEffect;

/// Effective head radius (m) for the Woodworth ITD model.
const HEAD_RADIUS_M: f32 = 0.0875;
/// Speed of sound (m/s).
const SPEED_OF_SOUND: f32 = 343.0;
/// Worst-case ITD headroom used to size the per-ear delay ring (seconds).
const MAX_ITD_SECONDS: f32 = 0.0015;

/// Per-ear coefficient set, computed off the realtime thread.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EarCoeffs {
    /// Fractional delay in samples (ITD). 0 on the near ear.
    pub delay_samples: f32,
    /// Head-shadow high-shelf `[b0,b1,b2,a1,a2]`.
    pub shelf: [f32; 5],
    /// Front/back + distance spectral dip `[b0,b1,b2,a1,a2]` (shared L/R).
    pub cue: [f32; 5],
    /// Broadband level (ILD trim × distance attenuation).
    pub gain: f32,
}

/// Both ears' coefficients for one azimuth/distance.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BinauralCoeffs {
    pub left: EarCoeffs,
    pub right: EarCoeffs,
}

impl BinauralCoeffs {
    /// Closed-form cues for `cfg` at `sample_rate`. Pure — call on the IPC thread.
    pub fn compute(cfg: &SpatialConfig, sample_rate: f32) -> Self {
        let sr = sample_rate.max(1.0);
        let az = cfg.azimuth_deg.to_radians();
        let s = az.sin(); // +1 hard right, -1 hard left, 0 front/back
                          // Lateral angle off the median plane, folded so front and back share the
                          // same ITD/ILD (their difference is the spectral cue below). 0..π/2.
        let lateral = s.abs().clamp(0.0, 1.0).asin();
        let lat_frac = lateral / FRAC_PI_2; // 0 (front/back) .. 1 (side)

        // ── ITD: contralateral (far) ear delayed. ──
        let itd_samples = (HEAD_RADIUS_M / SPEED_OF_SOUND) * (lateral + lateral.sin()) * sr;
        let left_is_near = s < 0.0;
        let (delay_l, delay_r) = if left_is_near {
            (0.0, itd_samples)
        } else {
            (itd_samples, 0.0)
        };

        // ── ILD: head shadow on the far ear. ──
        let shelf_freq = 2_500.0_f32.min(0.45 * sr);
        let flat_shelf = high_shelf_coeffs(shelf_freq, 0.0, sr);
        let far_shelf = high_shelf_coeffs(shelf_freq, -9.0 * lat_frac, sr);
        let near_gain = 1.0;
        let far_gain = 10f32.powf(-(1.5 * lat_frac) / 20.0); // up to ~-1.5 dB

        // ── Front/back + distance: pinna-style dip, deeper toward the rear and
        //    with distance. `back` is 0 at the front, 1 directly behind. ──
        let back = (1.0 - az.cos()) * 0.5;
        let cue_freq = 7_000.0_f32.min(0.45 * sr);
        let cue_db = -(8.0 * back + 4.0 * cfg.distance);
        let cue = peaking_coeffs(cue_freq, 1.2, cue_db, sr);

        // ── Distance: inverse-law level attenuation, both ears. ──
        let dist_gain = 1.0 / (1.0 + 1.5 * cfg.distance);

        let (shelf_l, gain_l, shelf_r, gain_r) = if left_is_near {
            (flat_shelf, near_gain, far_shelf, far_gain)
        } else {
            (far_shelf, far_gain, flat_shelf, near_gain)
        };

        BinauralCoeffs {
            left: EarCoeffs {
                delay_samples: delay_l,
                shelf: shelf_l,
                cue,
                gain: gain_l * dist_gain,
            },
            right: EarCoeffs {
                delay_samples: delay_r,
                shelf: shelf_r,
                cue,
                gain: gain_r * dist_gain,
            },
        }
    }

    /// Coefficients for a bypassed/centered source (front, at the head).
    pub fn identity(sample_rate: f32) -> Self {
        Self::compute(&SpatialConfig::default(), sample_rate)
    }
}

/// Single-channel fractional delay line (linear interpolation). Ring is sized
/// once at construction; `process` never allocates.
struct DelayLine {
    buf: Vec<f32>,
    idx: usize,
}

impl DelayLine {
    fn new(cap: usize) -> Self {
        Self {
            buf: vec![0.0; cap.max(2)],
            idx: 0,
        }
    }

    #[inline]
    fn process(&mut self, x: f32, delay: f32) -> f32 {
        let cap = self.buf.len();
        self.buf[self.idx] = x;
        let d = delay.clamp(0.0, (cap - 1) as f32);
        let di = d.floor() as usize;
        let frac = d - di as f32;
        // `delay` samples back, then one more for the interpolation partner.
        let i0 = (self.idx + cap - di) % cap;
        let i1 = (self.idx + cap - di - 1) % cap;
        let y = self.buf[i0] * (1.0 - frac) + self.buf[i1] * frac;
        self.idx = (self.idx + 1) % cap;
        y
    }

    fn reset(&mut self) {
        self.buf.iter_mut().for_each(|s| *s = 0.0);
        self.idx = 0;
    }
}

/// Per-input binaural processor: two delay lines + two biquads per ear. Built
/// once (ring sized for the engine rate); retuned in place from
/// [`BinauralCoeffs`]. `process(m)` maps one mono sample to an `(L, R)` pair.
pub struct BinauralState {
    enabled: bool,
    coeffs: BinauralCoeffs,
    delay_l: DelayLine,
    delay_r: DelayLine,
    shelf_l: BiquadFilter,
    shelf_r: BiquadFilter,
    cue_l: BiquadFilter,
    cue_r: BiquadFilter,
}

impl BinauralState {
    pub fn new(sample_rate: f32) -> Self {
        let cap = (MAX_ITD_SECONDS * sample_rate.max(1.0)).ceil() as usize + 4;
        let c = BinauralCoeffs::identity(sample_rate);
        // Seed the biquads with the identity coeffs; they are flat at center.
        let mk = |coeffs: [f32; 5]| {
            let mut f = BiquadFilter::high_pass(1_000.0, sample_rate);
            f.set_coeffs(coeffs);
            f
        };
        Self {
            enabled: false,
            coeffs: c,
            delay_l: DelayLine::new(cap),
            delay_r: DelayLine::new(cap),
            shelf_l: mk(c.left.shelf),
            shelf_r: mk(c.right.shelf),
            cue_l: mk(c.left.cue),
            cue_r: mk(c.right.cue),
        }
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        if enabled && !self.enabled {
            self.reset(); // avoid a stale delay-line/filter pop on (re)enable
        }
        self.enabled = enabled;
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// Retune from precomputed coefficients, preserving filter/delay state.
    pub fn set_coeffs(&mut self, c: BinauralCoeffs) {
        self.coeffs = c;
        self.shelf_l.set_coeffs(c.left.shelf);
        self.shelf_r.set_coeffs(c.right.shelf);
        self.cue_l.set_coeffs(c.left.cue);
        self.cue_r.set_coeffs(c.right.cue);
    }

    /// Spatialise one mono sample into an `(L, R)` pair.
    #[inline]
    pub fn process(&mut self, m: f32) -> (f32, f32) {
        let mut l = self.delay_l.process(m, self.coeffs.left.delay_samples);
        let mut r = self.delay_r.process(m, self.coeffs.right.delay_samples);
        l = tick_mono(&mut self.shelf_l, l);
        r = tick_mono(&mut self.shelf_r, r);
        l = tick_mono(&mut self.cue_l, l);
        r = tick_mono(&mut self.cue_r, r);
        (l * self.coeffs.left.gain, r * self.coeffs.right.gain)
    }

    pub fn reset(&mut self) {
        self.delay_l.reset();
        self.delay_r.reset();
        self.shelf_l.reset();
        self.shelf_r.reset();
        self.cue_l.reset();
        self.cue_r.reset();
    }
}

/// Run one sample through a biquad used as a single-channel filter (ch 0).
#[inline(always)]
fn tick_mono(f: &mut BiquadFilter, x: f32) -> f32 {
    let mut b = [x, 0.0];
    f.process(&mut b, 1);
    b[0]
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 48_000.0;

    fn cfg(az: f32, dist: f32) -> SpatialConfig {
        SpatialConfig {
            enabled: true,
            azimuth_deg: az,
            distance: dist,
        }
    }

    #[test]
    fn center_front_is_symmetric_and_undelayed() {
        let c = BinauralCoeffs::compute(&cfg(0.0, 0.0), SR);
        assert_eq!(c.left.delay_samples, 0.0);
        assert_eq!(c.right.delay_samples, 0.0);
        assert!((c.left.gain - c.right.gain).abs() < 1e-6);
        assert_eq!(c.left.shelf, c.right.shelf);
    }

    #[test]
    fn right_source_delays_and_shadows_the_left_ear() {
        // +90° = hard right: left ear is contralateral → delayed and attenuated.
        let c = BinauralCoeffs::compute(&cfg(90.0, 0.0), SR);
        assert!(c.left.delay_samples > c.right.delay_samples);
        assert_eq!(c.right.delay_samples, 0.0);
        assert!(c.left.gain < c.right.gain);
        // Max ITD stays under ~0.7 ms (≈34 samples @48 k).
        assert!(
            c.left.delay_samples < 40.0,
            "ITD {} too large",
            c.left.delay_samples
        );
    }

    #[test]
    fn symmetric_azimuths_mirror_between_ears() {
        let r = BinauralCoeffs::compute(&cfg(60.0, 0.0), SR);
        let l = BinauralCoeffs::compute(&cfg(-60.0, 0.0), SR);
        assert!((r.left.delay_samples - l.right.delay_samples).abs() < 1e-4);
        assert!((r.left.gain - l.right.gain).abs() < 1e-6);
    }

    #[test]
    fn front_and_back_differ_in_the_cue_band() {
        // Same lateral angle (±right), opposite hemispheres → the front/back cue
        // must differ even though ITD/ILD match.
        let front = BinauralCoeffs::compute(&cfg(45.0, 0.0), SR);
        let back = BinauralCoeffs::compute(&cfg(135.0, 0.0), SR);
        assert!((front.left.delay_samples - back.left.delay_samples).abs() < 1e-4);
        assert_ne!(front.left.cue, back.left.cue);
    }

    #[test]
    fn distance_attenuates() {
        let near = BinauralCoeffs::compute(&cfg(0.0, 0.0), SR);
        let far = BinauralCoeffs::compute(&cfg(0.0, 1.0), SR);
        assert!(far.left.gain < near.left.gain);
    }

    #[test]
    fn coeffs_all_finite_across_the_circle() {
        for az in (-180..=180).step_by(15) {
            for d in [0.0, 0.5, 1.0] {
                let c = BinauralCoeffs::compute(&cfg(az as f32, d), SR);
                for e in [c.left, c.right] {
                    assert!(e.delay_samples.is_finite() && e.gain.is_finite());
                    assert!(e.shelf.iter().all(|v| v.is_finite()));
                    assert!(e.cue.iter().all(|v| v.is_finite()));
                }
            }
        }
    }

    #[test]
    fn process_stays_finite_and_centered_passes_through() {
        let mut st = BinauralState::new(SR);
        st.set_enabled(true);
        st.set_coeffs(BinauralCoeffs::compute(&cfg(0.0, 0.0), SR));
        // Center/front, no distance: both ears carry the source at equal level
        // (delay 0, flat shelf, no cut) — output is finite and L≈R.
        let mut max_abs = 0.0f32;
        for i in 0..256 {
            let x = ((i as f32) * 0.05).sin();
            let (l, r) = st.process(x);
            assert!(l.is_finite() && r.is_finite());
            assert!((l - r).abs() < 1e-4);
            max_abs = max_abs.max(l.abs());
        }
        assert!(max_abs > 0.0);
    }

    #[test]
    fn delay_line_zero_delay_is_passthrough() {
        let mut dl = DelayLine::new(64);
        assert_eq!(dl.process(0.5, 0.0), 0.5);
        assert_eq!(dl.process(-0.3, 0.0), -0.3);
    }

    #[test]
    fn delay_line_integer_delay() {
        let mut dl = DelayLine::new(64);
        dl.process(1.0, 4.0); // t=0
        for _ in 0..3 {
            dl.process(0.0, 4.0);
        }
        // 4th call after the impulse: the 1.0 should surface (delay = 4).
        let y = dl.process(0.0, 4.0);
        assert!((y - 1.0).abs() < 1e-6, "got {y}");
    }
}
