//! Streaming analysis meters (#38): RMS, BS.1770-style loudness (LUFS),
//! and 4× oversampled true peak.
//!
//! Runs inside the output callback on the final (post-DSP, post-clamp)
//! samples, but every per-sample step is strictly bounded arithmetic — two
//! biquads, a handful of multiply-adds for the true-peak interpolator, and
//! ring-buffer accumulation. Logarithms happen once per 100 ms block, not
//! per sample. Results publish through Relaxed atomics; the IPC thread
//! formats them.
//!
//! Accuracy note: the K-weighting filters use RBJ approximations of the
//! BS.1770 curves (high shelf ≈ +4 dB above ~1.5 kHz, RLB high-pass at
//! ~38 Hz) recomputed for the engine rate. That is guidance-meter accuracy
//! (within a fraction of a dB of the reference at 48 kHz), not
//! certification accuracy — exactly what a stream-confidence meter needs.
//!
//! Self-contained: carries its own `KBiquad` (RBJ high-shelf + high-pass) so
//! it does not couple to the DSP module's filter API.

use serde::Serialize;

/// 100 ms analysis block.
const BLOCK_MS: f32 = 100.0;
/// Momentary loudness window: 400 ms = 4 blocks.
const MOMENTARY_BLOCKS: usize = 4;
/// Short-term loudness window: 3 s = 30 blocks.
const SHORT_BLOCKS: usize = 30;
/// Reporting floor — silence and near-silence pin here instead of -inf
/// (JSON cannot carry -inf).
pub const SILENCE_FLOOR_DB: f32 = -70.0;

#[inline]
fn db_to_lin(db: f32) -> f32 {
    10.0f32.powf(db / 20.0)
}

/// Minimal stereo biquad (RBJ cookbook), transposed direct form II.
/// Only the two stages the K-weighting needs are implemented.
#[derive(Debug, Clone, Copy)]
struct KBiquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: [f32; 2],
    z2: [f32; 2],
}

impl Default for KBiquad {
    fn default() -> Self {
        Self { b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0, z1: [0.0; 2], z2: [0.0; 2] }
    }
}

impl KBiquad {
    fn set_coeffs(&mut self, b0: f32, b1: f32, b2: f32, a0: f32, a1: f32, a2: f32) {
        let inv = 1.0 / a0;
        self.b0 = b0 * inv;
        self.b1 = b1 * inv;
        self.b2 = b2 * inv;
        self.a1 = a1 * inv;
        self.a2 = a2 * inv;
    }

    /// RBJ cookbook high-pass.
    fn set_highpass(&mut self, sample_rate: f32, cutoff_hz: f32, q: f32) {
        let w0 = 2.0 * std::f32::consts::PI * (cutoff_hz / sample_rate).min(0.49);
        let (sin, cos) = w0.sin_cos();
        let alpha = sin / (2.0 * q);
        let b0 = (1.0 + cos) / 2.0;
        let b1 = -(1.0 + cos);
        let b2 = (1.0 + cos) / 2.0;
        let a0 = 1.0 + alpha;
        let a1 = -2.0 * cos;
        let a2 = 1.0 - alpha;
        self.set_coeffs(b0, b1, b2, a0, a1, a2);
    }

    /// RBJ cookbook high shelf.
    fn set_high_shelf(&mut self, sample_rate: f32, freq_hz: f32, q: f32, gain_db: f32) {
        let a = db_to_lin(gain_db / 2.0);
        let w0 = 2.0 * std::f32::consts::PI * (freq_hz / sample_rate).min(0.49);
        let (sin, cos) = w0.sin_cos();
        let alpha = sin / (2.0 * q);
        let two_sqrt_a_alpha = 2.0 * a.sqrt() * alpha;
        let b0 = a * ((a + 1.0) + (a - 1.0) * cos + two_sqrt_a_alpha);
        let b1 = -2.0 * a * ((a - 1.0) + (a + 1.0) * cos);
        let b2 = a * ((a + 1.0) + (a - 1.0) * cos - two_sqrt_a_alpha);
        let a0 = (a + 1.0) - (a - 1.0) * cos + two_sqrt_a_alpha;
        let a1 = 2.0 * ((a - 1.0) - (a + 1.0) * cos);
        let a2 = (a + 1.0) - (a - 1.0) * cos - two_sqrt_a_alpha;
        self.set_coeffs(b0, b1, b2, a0, a1, a2);
    }

    #[inline]
    fn process(&mut self, ch: usize, x: f32) -> f32 {
        let y = self.b0 * x + self.z1[ch];
        self.z1[ch] = self.b1 * x - self.a1 * y + self.z2[ch];
        self.z2[ch] = self.b2 * x - self.a2 * y;
        y
    }
}

/// One loudness/RMS/true-peak snapshot, serialized into `BusStatus`.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct LoudnessSnapshot {
    /// Un-weighted RMS over the short-term window, dBFS. Floored at -70.
    pub rms_db: f32,
    /// K-weighted momentary loudness (400 ms), LUFS. Floored at -70.
    pub lufs_momentary: f32,
    /// K-weighted short-term loudness (3 s), LUFS. Floored at -70.
    pub lufs_short: f32,
    /// Highest 4×-oversampled inter-sample peak over the last 400 ms, dBTP.
    /// Floored at -70.
    pub true_peak_db: f32,
    /// Plain-language verdict derived from short-term loudness + true peak.
    pub verdict: LoudnessVerdict,
}

impl Default for LoudnessSnapshot {
    fn default() -> Self {
        Self {
            rms_db: SILENCE_FLOOR_DB,
            lufs_momentary: SILENCE_FLOOR_DB,
            lufs_short: SILENCE_FLOOR_DB,
            true_peak_db: SILENCE_FLOOR_DB,
            verdict: LoudnessVerdict::NoSignal,
        }
    }
}

/// Stream-confidence verdict (#38): recommendation, not just numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LoudnessVerdict {
    /// Nothing (or near-silence) on the bus.
    NoSignal,
    /// Short-term loudness below the streaming comfort range.
    TooQuiet,
    /// Inside the comfort range with true-peak headroom.
    Healthy,
    /// Louder than the comfort range, or true peak within 1 dB of full
    /// scale (inter-sample clipping risk on lossy encoders).
    TooHot,
}

/// Derive the verdict from short-term LUFS and true peak (dBTP).
///
/// Comfort range for live streaming: roughly -24 to -12 LUFS short-term
/// (streaming platforms normalize near -14; voice riding -16 ± a few dB
/// reads as healthy). True peak above -1 dBTP risks encoder overs
/// regardless of average loudness.
pub fn verdict_for(lufs_short: f32, true_peak_db: f32) -> LoudnessVerdict {
    if lufs_short <= SILENCE_FLOOR_DB + 5.0 {
        LoudnessVerdict::NoSignal
    } else if true_peak_db > -1.0 || lufs_short > -12.0 {
        LoudnessVerdict::TooHot
    } else if lufs_short < -24.0 {
        LoudnessVerdict::TooQuiet
    } else {
        LoudnessVerdict::Healthy
    }
}

fn mean_square_to_db(ms: f32, offset: f32) -> f32 {
    if ms <= 1e-12 {
        SILENCE_FLOOR_DB
    } else {
        (offset + 10.0 * ms.log10()).max(SILENCE_FLOOR_DB)
    }
}

/// 4× oversampling inter-sample peak detector (BS.1770 Annex 2 style).
///
/// Each input sample produces 4 interpolated points via a polyphase
/// windowed-sinc (8 taps per phase, precomputed). Cost: 32 multiply-adds
/// per channel per sample — bounded and branch-free.
pub struct TruePeakMeter {
    /// Polyphase 4× interpolation taps: phase p evaluates the signal at
    /// hist[3] + p/4 using an 8-tap Hann-windowed sinc. Computed once at
    /// construction (engine start), never on the realtime path.
    phases: [[f32; 8]; 4],
    /// Per-channel history of the last 8 input samples.
    hist: [[f32; 8]; 2],
    /// Running maximum |interpolated| since the last `take_max`.
    max: f32,
}

fn sinc(x: f32) -> f32 {
    if x.abs() < 1e-6 {
        1.0
    } else {
        let px = std::f32::consts::PI * x;
        px.sin() / px
    }
}

fn tp_phases() -> [[f32; 8]; 4] {
    let mut phases = [[0.0f32; 8]; 4];
    for (p, taps) in phases.iter_mut().enumerate() {
        let frac = p as f32 / 4.0;
        let mut sum = 0.0f32;
        for (k, tap) in taps.iter_mut().enumerate() {
            // Distance from the interpolation point (between hist[3] and
            // hist[4]) to tap k.
            let d = (3.0 + frac) - k as f32;
            // Hann window over the ±4-sample support.
            let w = 0.5 * (1.0 + (std::f32::consts::PI * d / 4.0).cos());
            *tap = sinc(d) * w;
            sum += *tap;
        }
        // Normalize for exact DC response.
        for tap in taps.iter_mut() {
            *tap /= sum;
        }
    }
    phases
}

impl Default for TruePeakMeter {
    fn default() -> Self {
        Self { phases: tp_phases(), hist: [[0.0; 8]; 2], max: 0.0 }
    }
}

impl TruePeakMeter {
    #[inline]
    pub fn process(&mut self, ch: usize, x: f32) {
        let h = &mut self.hist[ch];
        h.copy_within(1.., 0);
        h[7] = x;
        for phase in &self.phases {
            let mut acc = 0.0f32;
            for k in 0..8 {
                acc += phase[k] * h[k];
            }
            let a = acc.abs();
            if a > self.max {
                self.max = a;
            }
        }
    }

    /// Highest interpolated |peak| since the last call; resets the maximum.
    pub fn take_max(&mut self) -> f32 {
        std::mem::replace(&mut self.max, 0.0)
    }
}

/// Combined RMS + LUFS + true-peak analyzer for one stereo bus output.
pub struct StreamAnalyzer {
    block_samples: u32,
    pos: u32,

    // K-weighted accumulation (sum over both channels) for LUFS.
    k_shelf: KBiquad,
    k_hp: KBiquad,
    k_acc: f64,
    k_blocks: [f32; SHORT_BLOCKS],
    // Un-weighted accumulation for RMS.
    rms_acc: f64,
    rms_blocks: [f32; SHORT_BLOCKS],
    block_idx: usize,
    blocks_filled: usize,

    true_peak: TruePeakMeter,
    // Per-block true-peak maxima over the momentary window. Published as a
    // plain max so any number of status readers can poll without draining
    // each other (a swap-reset here raced the meter poll against the state
    // poll and showed -inf mid-signal).
    tp_blocks: [f32; MOMENTARY_BLOCKS],
    tp_idx: usize,

    // Published values, refreshed once per completed 100 ms block.
    rms_db: f32,
    lufs_momentary: f32,
    lufs_short: f32,
    true_peak_lin: f32,
}

impl StreamAnalyzer {
    pub fn new(sample_rate: u32) -> Self {
        let sample_rate = sample_rate.max(1);
        let fs = sample_rate as f32;
        let mut k_shelf = KBiquad::default();
        let mut k_hp = KBiquad::default();
        // RBJ approximations of the BS.1770 K-weighting stages.
        k_shelf.set_high_shelf(fs, 1500.0, 0.707, 4.0);
        k_hp.set_highpass(fs, 38.0, 0.5);
        Self {
            block_samples: ((fs * BLOCK_MS / 1000.0) as u32).max(1),
            pos: 0,
            k_shelf,
            k_hp,
            k_acc: 0.0,
            k_blocks: [0.0; SHORT_BLOCKS],
            rms_acc: 0.0,
            rms_blocks: [0.0; SHORT_BLOCKS],
            block_idx: 0,
            blocks_filled: 0,
            true_peak: TruePeakMeter::default(),
            tp_blocks: [0.0; MOMENTARY_BLOCKS],
            tp_idx: 0,
            rms_db: SILENCE_FLOOR_DB,
            lufs_momentary: SILENCE_FLOOR_DB,
            lufs_short: SILENCE_FLOOR_DB,
            true_peak_lin: 0.0,
        }
    }

    /// Feed one output frame. Bounded per-sample work; log math only at
    /// 100 ms block boundaries.
    #[inline]
    pub fn process_frame(&mut self, l: f32, r: f32) {
        // K-weighted mean square (sum of both channel energies, BS.1770).
        let kl = self.k_hp.process(0, self.k_shelf.process(0, l));
        let kr = self.k_hp.process(1, self.k_shelf.process(1, r));
        self.k_acc += (kl * kl + kr * kr) as f64;

        // Un-weighted mean square averaged across channels.
        self.rms_acc += ((l * l + r * r) * 0.5) as f64;

        self.true_peak.process(0, l);
        self.true_peak.process(1, r);

        self.pos += 1;
        if self.pos >= self.block_samples {
            self.finish_block();
        }
    }

    fn finish_block(&mut self) {
        let n = self.pos.max(1) as f64;
        self.k_blocks[self.block_idx] = (self.k_acc / n) as f32;
        self.rms_blocks[self.block_idx] = (self.rms_acc / n) as f32;
        self.k_acc = 0.0;
        self.rms_acc = 0.0;
        self.pos = 0;
        self.block_idx = (self.block_idx + 1) % SHORT_BLOCKS;
        if self.blocks_filled < SHORT_BLOCKS {
            self.blocks_filled += 1;
        }

        // Mean over the most recent windows (newest block is just behind
        // block_idx).
        let mean_of = |blocks: &[f32; SHORT_BLOCKS], count: usize, filled: usize| -> f32 {
            let take = count.min(filled);
            if take == 0 {
                return 0.0;
            }
            let mut sum = 0.0f32;
            for back in 1..=take {
                let idx = (self.block_idx + SHORT_BLOCKS - back) % SHORT_BLOCKS;
                sum += blocks[idx];
            }
            sum / take as f32
        };

        let filled = self.blocks_filled;
        let momentary_ms = mean_of(&self.k_blocks, MOMENTARY_BLOCKS, filled);
        let short_ms = mean_of(&self.k_blocks, SHORT_BLOCKS, filled);
        let rms_ms = mean_of(&self.rms_blocks, SHORT_BLOCKS, filled);

        // BS.1770 loudness offset.
        self.lufs_momentary = mean_square_to_db(momentary_ms, -0.691);
        self.lufs_short = mean_square_to_db(short_ms, -0.691);
        self.rms_db = mean_square_to_db(rms_ms, 0.0);

        // True peak: max over the momentary window (400 ms), so a quiet
        // block doesn't instantly erase a hot transient.
        self.tp_blocks[self.tp_idx] = self.true_peak.take_max();
        self.tp_idx = (self.tp_idx + 1) % MOMENTARY_BLOCKS;
        self.true_peak_lin = self.tp_blocks.iter().fold(0.0f32, |a, &b| a.max(b));
    }

    pub fn rms_db(&self) -> f32 {
        self.rms_db
    }

    pub fn lufs_momentary(&self) -> f32 {
        self.lufs_momentary
    }

    pub fn lufs_short(&self) -> f32 {
        self.lufs_short
    }

    /// Highest inter-sample peak over the momentary window (400 ms), linear.
    /// Pure read — safe for any number of pollers (no drain).
    pub fn true_peak_lin(&self) -> f32 {
        self.true_peak_lin
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FS: u32 = 48_000;

    fn feed_sine(an: &mut StreamAnalyzer, amp: f32, freq: f32, seconds: f32) {
        let n = (FS as f32 * seconds) as usize;
        for i in 0..n {
            let t = i as f32 / FS as f32;
            let s = amp * (2.0 * std::f32::consts::PI * freq * t).sin();
            an.process_frame(s, s);
        }
    }

    #[test]
    fn rms_of_full_scale_sine_is_minus_3db() {
        let mut an = StreamAnalyzer::new(FS);
        feed_sine(&mut an, 1.0, 997.0, 4.0);
        assert!(
            (an.rms_db() - (-3.01)).abs() < 0.2,
            "expected ~-3.01 dB RMS, got {}",
            an.rms_db()
        );
    }

    #[test]
    fn lufs_of_full_scale_997hz_stereo_sine_is_near_zero() {
        // BS.1770: a 997 Hz 0 dBFS sine in BOTH channels reads ≈ -0.0 LUFS
        // (-3.01 per channel + 3.01 channel sum - 0.69 offset ≈ -0.7,
        // plus ~+0.6 dB of K-shelf gain at 997 Hz ≈ -0.1). Allow slack for
        // the RBJ-approximated filters.
        let mut an = StreamAnalyzer::new(FS);
        feed_sine(&mut an, 1.0, 997.0, 4.0);
        assert!(
            an.lufs_short() > -2.0 && an.lufs_short() < 1.5,
            "expected ≈0 LUFS, got {}",
            an.lufs_short()
        );
    }

    #[test]
    fn lufs_tracks_level_changes_linearly() {
        // -20 dB amplitude drop must read ~20 LU lower.
        let mut loud = StreamAnalyzer::new(FS);
        feed_sine(&mut loud, 1.0, 997.0, 4.0);
        let mut quiet = StreamAnalyzer::new(FS);
        feed_sine(&mut quiet, 0.1, 997.0, 4.0);
        let diff = loud.lufs_short() - quiet.lufs_short();
        assert!(
            (diff - 20.0).abs() < 0.3,
            "expected ~20 LU difference, got {diff}"
        );
    }

    #[test]
    fn silence_reports_floor_and_no_signal() {
        let mut an = StreamAnalyzer::new(FS);
        for _ in 0..FS {
            an.process_frame(0.0, 0.0);
        }
        assert_eq!(an.rms_db(), SILENCE_FLOOR_DB);
        assert_eq!(an.lufs_short(), SILENCE_FLOOR_DB);
        assert_eq!(verdict_for(an.lufs_short(), SILENCE_FLOOR_DB), LoudnessVerdict::NoSignal);
    }

    #[test]
    fn true_peak_catches_inter_sample_overs() {
        // fs/4 sine sampled exactly between its extrema: every sample is
        // ±0.7071 yet the continuous waveform reaches 1.0. A sample-peak
        // meter reads -3 dB; the true-peak meter must get close to 0 dBTP.
        let mut tp = TruePeakMeter::default();
        for i in 0..4096 {
            let x = (2.0 * std::f32::consts::PI * (i as f32 + 0.5) / 4.0).sin();
            tp.process(0, x);
        }
        let max = tp.take_max();
        assert!(
            max > 0.9,
            "true peak should approach 1.0 for inter-sample over, got {max}"
        );
        // And reading again starts fresh.
        assert_eq!(tp.take_max(), 0.0);
    }

    #[test]
    fn true_peak_matches_sample_peak_for_dc() {
        let mut tp = TruePeakMeter::default();
        // Warm up past the 0 → 0.5 step: the transient legitimately
        // overshoots (Gibbs ringing IS an inter-sample over). Discard it.
        for _ in 0..64 {
            tp.process(0, 0.5);
        }
        let _ = tp.take_max();
        // Steady-state DC must read exactly the sample value.
        for _ in 0..64 {
            tp.process(0, 0.5);
        }
        let max = tp.take_max();
        assert!((max - 0.5).abs() < 0.02, "DC true peak ≈ sample peak, got {max}");
    }

    #[test]
    fn analyzer_true_peak_is_windowed_not_drained() {
        // fs/4 sine sampled between extrema: inter-sample peak ≈ 1.0.
        let mut an = StreamAnalyzer::new(FS);
        for i in 0..(FS / 2) {
            let x = (2.0 * std::f32::consts::PI * (i as f32 + 0.5) / 4.0).sin();
            an.process_frame(x, x);
        }
        let p1 = an.true_peak_lin();
        assert!(p1 > 0.9, "expected ~1.0 inter-sample peak, got {p1}");
        // Repeated reads must NOT drain the value (multi-poller safety).
        assert_eq!(an.true_peak_lin(), p1);
        // After > 400 ms of silence the windowed max decays to zero.
        for _ in 0..(FS / 2) {
            an.process_frame(0.0, 0.0);
        }
        assert_eq!(an.true_peak_lin(), 0.0);
    }

    #[test]
    fn verdict_thresholds() {
        assert_eq!(verdict_for(SILENCE_FLOOR_DB, SILENCE_FLOOR_DB), LoudnessVerdict::NoSignal);
        assert_eq!(verdict_for(-30.0, -12.0), LoudnessVerdict::TooQuiet);
        assert_eq!(verdict_for(-16.0, -3.0), LoudnessVerdict::Healthy);
        assert_eq!(verdict_for(-10.0, -3.0), LoudnessVerdict::TooHot);
        // Healthy loudness but inter-sample clipping risk → too hot.
        assert_eq!(verdict_for(-16.0, -0.5), LoudnessVerdict::TooHot);
    }

    #[test]
    fn snapshot_serializes_expected_keys() {
        let snap = LoudnessSnapshot {
            rms_db: -18.0,
            lufs_momentary: -15.5,
            lufs_short: -16.0,
            true_peak_db: -2.0,
            verdict: LoudnessVerdict::Healthy,
        };
        let json = serde_json::to_value(snap).unwrap();
        assert_eq!(json["rms_db"], -18.0);
        assert_eq!(json["lufs_momentary"], -15.5);
        assert_eq!(json["lufs_short"], -16.0);
        assert_eq!(json["true_peak_db"], -2.0);
        assert_eq!(json["verdict"], "healthy");

        let json = serde_json::to_value(LoudnessSnapshot::default()).unwrap();
        assert_eq!(json["verdict"], "no_signal");
        // Floors are finite — JSON-safe (no -inf).
        assert!(json["lufs_short"].as_f64().unwrap().is_finite());
    }
}
