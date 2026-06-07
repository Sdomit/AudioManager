//! Serializable DSP configuration model (issue #32, step 1).
//!
//! Pure data: these structs describe a per-input or per-bus effect chain but do
//! no audio processing. Step 2 maps a clamped config into the fixed effect slots
//! and atomic parameter blocks read by the audio callback.
//!
//! Every field is sample-rate independent. Frequencies are clamped here to a
//! fixed audible window; the final clamp to `< Nyquist` happens in step 2 when
//! the engine sample rate is known.

use serde::{Deserialize, Serialize};

/// Fixed number of parametric EQ bands exposed in #32. The serde shape is a
/// `Vec` so older/newer payloads deserialize, but [`EqConfig::clamp`] pads or
/// truncates to exactly this many bands so the realtime slot count is constant.
pub const MAX_EQ_BANDS: usize = 4;

/// Clamp `v` to `[lo, hi]`, substituting `default` for any non-finite value.
/// Mirrors the `clamp_gain` / `clamp_volume` discipline elsewhere in the engine.
#[inline]
fn clamp_finite(v: f32, default: f32, lo: f32, hi: f32) -> f32 {
    if v.is_finite() {
        v.clamp(lo, hi)
    } else {
        default
    }
}

// Shared parameter bounds. Frequencies use a fixed audible window; step 2
// additionally caps frequency at `< Nyquist` for the active sample rate.
const FREQ_MIN: f32 = 10.0;
const FREQ_MAX: f32 = 20_000.0;
const TIME_MIN: f32 = 0.0;
const TIME_MAX: f32 = 5_000.0; // ms

/// High-pass filter (2nd-order Butterworth). Maps to `BiquadFilter::high_pass`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct HpfConfig {
    pub enabled: bool,
    pub freq_hz: f32,
}

impl Default for HpfConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            freq_hz: 80.0,
        }
    }
}

impl HpfConfig {
    pub fn clamp(&mut self) {
        let d = Self::default();
        self.freq_hz = clamp_finite(self.freq_hz, d.freq_hz, FREQ_MIN, FREQ_MAX);
    }
}

/// Noise gate / downward expander. Maps to `NoiseGate::new`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct GateConfig {
    pub enabled: bool,
    pub threshold_db: f32,
    pub attack_ms: f32,
    pub release_ms: f32,
    pub hold_ms: f32,
}

impl Default for GateConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            threshold_db: -40.0,
            attack_ms: 10.0,
            release_ms: 150.0,
            hold_ms: 80.0,
        }
    }
}

impl GateConfig {
    pub fn clamp(&mut self) {
        let d = Self::default();
        self.threshold_db = clamp_finite(self.threshold_db, d.threshold_db, -80.0, 0.0);
        self.attack_ms = clamp_finite(self.attack_ms, d.attack_ms, TIME_MIN, TIME_MAX);
        self.release_ms = clamp_finite(self.release_ms, d.release_ms, TIME_MIN, TIME_MAX);
        self.hold_ms = clamp_finite(self.hold_ms, d.hold_ms, TIME_MIN, TIME_MAX);
    }
}

/// Filter shape for one EQ band. The realtime path is shape-agnostic (it applies
/// precomputed biquad coefficients); this only selects which coefficient formula
/// the IPC thread runs. `#[serde(default)]` on the band field keeps presets that
/// predate per-band shapes deserializing as `Peaking`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum BandKind {
    #[default]
    Peaking,
    LowShelf,
    HighShelf,
    LowPass,
    HighPass,
    Notch,
}

/// One parametric EQ band. `kind` selects the filter shape; `gain_db` is used by
/// peaking/shelf shapes, `q` by peaking/cut/notch shapes (ignored params are
/// harmless — the coefficient formula simply does not read them).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct EqBand {
    pub enabled: bool,
    #[serde(default)]
    pub kind: BandKind,
    pub freq_hz: f32,
    pub q: f32,
    pub gain_db: f32,
}

impl EqBand {
    pub fn clamp(&mut self) {
        self.freq_hz = clamp_finite(self.freq_hz, 1_000.0, FREQ_MIN, FREQ_MAX);
        self.q = clamp_finite(self.q, 1.0, 0.1, 10.0);
        self.gain_db = clamp_finite(self.gain_db, 0.0, -24.0, 24.0);
    }
}

/// Fixed-band parametric EQ. The `Vec` deserializes any length; [`Self::clamp`]
/// normalizes to exactly [`MAX_EQ_BANDS`] bands.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EqConfig {
    pub enabled: bool,
    pub bands: Vec<EqBand>,
}

impl Default for EqConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            // Console-style layout: low shelf, two sweepable bells, high shelf.
            bands: vec![
                EqBand {
                    enabled: false,
                    kind: BandKind::LowShelf,
                    freq_hz: 100.0,
                    q: 0.9,
                    gain_db: 0.0,
                },
                EqBand {
                    enabled: false,
                    kind: BandKind::Peaking,
                    freq_hz: 400.0,
                    q: 1.0,
                    gain_db: 0.0,
                },
                EqBand {
                    enabled: false,
                    kind: BandKind::Peaking,
                    freq_hz: 3_000.0,
                    q: 1.0,
                    gain_db: 0.0,
                },
                EqBand {
                    enabled: false,
                    kind: BandKind::HighShelf,
                    freq_hz: 8_000.0,
                    q: 0.9,
                    gain_db: 0.0,
                },
            ],
        }
    }
}

impl EqConfig {
    /// Normalize to exactly `MAX_EQ_BANDS` bands (pad with defaults, truncate
    /// extras) and clamp every band. The realtime layer relies on the fixed
    /// band count.
    pub fn clamp(&mut self) {
        let defaults = Self::default().bands;
        if self.bands.len() < MAX_EQ_BANDS {
            self.bands
                .extend_from_slice(&defaults[self.bands.len()..MAX_EQ_BANDS]);
        } else {
            self.bands.truncate(MAX_EQ_BANDS);
        }
        for band in &mut self.bands {
            band.clamp();
        }
    }
}

/// Feed-forward compressor. Maps to `Compressor::new`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct CompressorConfig {
    pub enabled: bool,
    pub threshold_db: f32,
    pub ratio: f32,
    pub attack_ms: f32,
    pub release_ms: f32,
    pub makeup_db: f32,
}

impl Default for CompressorConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            threshold_db: -18.0,
            ratio: 4.0,
            attack_ms: 5.0,
            release_ms: 80.0,
            makeup_db: 0.0,
        }
    }
}

impl CompressorConfig {
    pub fn clamp(&mut self) {
        let d = Self::default();
        self.threshold_db = clamp_finite(self.threshold_db, d.threshold_db, -60.0, 0.0);
        self.ratio = clamp_finite(self.ratio, d.ratio, 1.0, 20.0);
        self.attack_ms = clamp_finite(self.attack_ms, d.attack_ms, TIME_MIN, TIME_MAX);
        self.release_ms = clamp_finite(self.release_ms, d.release_ms, TIME_MIN, TIME_MAX);
        // Makeup doubles as a trim once EQ/comp are combined, so allow cut too.
        self.makeup_db = clamp_finite(self.makeup_db, d.makeup_db, -24.0, 24.0);
    }
}

/// Brick-wall peak limiter. Maps to `Limiter::new`. Default ceiling is a
/// streaming-safe −1 dBFS (see #33's B1 protection).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct LimiterConfig {
    pub enabled: bool,
    pub threshold_db: f32,
    pub attack_ms: f32,
    pub release_ms: f32,
}

impl Default for LimiterConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            threshold_db: -1.0,
            attack_ms: 0.5,
            release_ms: 100.0,
        }
    }
}

impl LimiterConfig {
    pub fn clamp(&mut self) {
        let d = Self::default();
        self.threshold_db = clamp_finite(self.threshold_db, d.threshold_db, -12.0, 0.0);
        self.attack_ms = clamp_finite(self.attack_ms, d.attack_ms, TIME_MIN, TIME_MAX);
        self.release_ms = clamp_finite(self.release_ms, d.release_ms, TIME_MIN, TIME_MAX);
    }
}

/// Neural denoiser backend. Only `Rnnoise` is wired in #37; `DeepFilterNet`
/// is reserved for the phase-2 upgrade and currently behaves like `Rnnoise`
/// until its engine lands, so saved configs that name it stay forward-valid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DenoiseBackend {
    #[default]
    Rnnoise,
    DeepFilterNet,
}

/// Neural noise suppression placed first in the chain (pre-HPF). RNNoise runs
/// at 48 kHz mono only and adds ~10 ms of latency; the realtime layer bypasses
/// it when the engine is not at 48 kHz.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct DenoiseConfig {
    pub enabled: bool,
    #[serde(default)]
    pub backend: DenoiseBackend,
}

impl Default for DenoiseConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            backend: DenoiseBackend::Rnnoise,
        }
    }
}

impl DenoiseConfig {
    pub fn clamp(&mut self) {
        // No numeric params yet; backend is an enum so it cannot be invalid.
    }
}

/// One stage in the per-input effect chain. The node-graph UI wires effects in
/// a chosen order; this enum names the stages so [`DspConfig::order`] can carry
/// that order to the engine. Declaration order is the canonical default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DspStage {
    Denoise,
    Hpf,
    Gate,
    Eq,
    Comp,
    Limiter,
}

impl DspStage {
    /// All stages in canonical processing order.
    pub const ALL: [DspStage; 6] = [
        DspStage::Denoise,
        DspStage::Hpf,
        DspStage::Gate,
        DspStage::Eq,
        DspStage::Comp,
        DspStage::Limiter,
    ];
}

fn default_dsp_order() -> Vec<DspStage> {
    DspStage::ALL.to_vec()
}

/// Normalize an order list to a full permutation of all six stages: keep the
/// first occurrence of each, drop duplicates/unknowns, then append any missing
/// stages in canonical order. Guarantees the realtime loop sees each stage
/// exactly once regardless of what the UI sent.
fn normalize_order(order: &mut Vec<DspStage>) {
    let mut seen = [false; 6];
    let mut out: Vec<DspStage> = Vec::with_capacity(6);
    for &s in order.iter() {
        let i = s as usize;
        if !seen[i] {
            seen[i] = true;
            out.push(s);
        }
    }
    for &s in DspStage::ALL.iter() {
        if !seen[s as usize] {
            out.push(s);
        }
    }
    *order = out;
}

/// Full per-input effect chain. `order` carries the wired processing order
/// (default: Denoise → HPF → Gate → EQ → Compressor → Limiter).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DspConfig {
    #[serde(default)]
    pub denoise: DenoiseConfig,
    #[serde(default)]
    pub hpf: HpfConfig,
    #[serde(default)]
    pub gate: GateConfig,
    #[serde(default)]
    pub eq: EqConfig,
    #[serde(default)]
    pub compressor: CompressorConfig,
    #[serde(default)]
    pub limiter: LimiterConfig,
    /// Processing order of the stages. `serde(default)` so pre-order configs
    /// load with the canonical order.
    #[serde(default = "default_dsp_order")]
    pub order: Vec<DspStage>,
}

impl Default for DspConfig {
    fn default() -> Self {
        Self {
            denoise: DenoiseConfig::default(),
            hpf: HpfConfig::default(),
            gate: GateConfig::default(),
            eq: EqConfig::default(),
            compressor: CompressorConfig::default(),
            limiter: LimiterConfig::default(),
            order: default_dsp_order(),
        }
    }
}

impl DspConfig {
    /// Clamp every effect's parameters to safe ranges and normalize the stage
    /// order. Run on the IPC thread before publishing to the realtime atomics,
    /// so the audio callback only ever sees valid values.
    pub fn clamp(&mut self) {
        self.denoise.clamp();
        self.hpf.clamp();
        self.gate.clamp();
        self.eq.clamp();
        self.compressor.clamp();
        self.limiter.clamp();
        normalize_order(&mut self.order);
    }
}

/// Per-bus effect chain, processed post-sum/pre-clip in order EQ → Limiter.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct BusDspConfig {
    #[serde(default)]
    pub eq: EqConfig,
    #[serde(default)]
    pub limiter: LimiterConfig,
}

impl BusDspConfig {
    pub fn clamp(&mut self) {
        self.eq.clamp();
        self.limiter.clamp();
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_chain_is_fully_bypassed() {
        let c = DspConfig::default();
        assert!(!c.hpf.enabled);
        assert!(!c.gate.enabled);
        assert!(!c.eq.enabled);
        assert!(!c.compressor.enabled);
        assert!(!c.limiter.enabled);
        assert!(c.eq.bands.iter().all(|b| !b.enabled));
    }

    #[test]
    fn clamp_bounds_out_of_range_params() {
        let mut c = DspConfig::default();
        c.hpf.freq_hz = 50_000.0;
        c.gate.threshold_db = 20.0;
        c.compressor.ratio = 0.2;
        c.compressor.makeup_db = -100.0;
        c.limiter.threshold_db = 6.0;
        c.clamp();
        assert_eq!(c.hpf.freq_hz, FREQ_MAX);
        assert_eq!(c.gate.threshold_db, 0.0);
        assert_eq!(c.compressor.ratio, 1.0);
        assert_eq!(c.compressor.makeup_db, -24.0);
        assert_eq!(c.limiter.threshold_db, 0.0);
    }

    #[test]
    fn clamp_replaces_non_finite_with_defaults() {
        let mut c = DspConfig::default();
        c.hpf.freq_hz = f32::NAN;
        c.compressor.ratio = f32::INFINITY;
        c.gate.attack_ms = f32::NEG_INFINITY;
        c.clamp();
        assert_eq!(c.hpf.freq_hz, HpfConfig::default().freq_hz);
        assert_eq!(c.compressor.ratio, CompressorConfig::default().ratio);
        assert_eq!(c.gate.attack_ms, GateConfig::default().attack_ms);
    }

    #[test]
    fn eq_clamp_pads_short_band_list() {
        let mut eq = EqConfig {
            enabled: true,
            bands: vec![],
        };
        eq.clamp();
        assert_eq!(eq.bands.len(), MAX_EQ_BANDS);
    }

    #[test]
    fn eq_clamp_truncates_long_band_list() {
        let extra = EqBand {
            enabled: true,
            kind: BandKind::Peaking,
            freq_hz: 500.0,
            q: 1.0,
            gain_db: 3.0,
        };
        let mut eq = EqConfig {
            enabled: true,
            bands: vec![extra; MAX_EQ_BANDS + 4],
        };
        eq.clamp();
        assert_eq!(eq.bands.len(), MAX_EQ_BANDS);
    }

    #[test]
    fn eq_band_clamp_bounds_q_and_gain() {
        let mut band = EqBand {
            enabled: true,
            kind: BandKind::Peaking,
            freq_hz: 1_000.0,
            q: 100.0,
            gain_db: 99.0,
        };
        band.clamp();
        assert_eq!(band.q, 10.0);
        assert_eq!(band.gain_db, 24.0);
    }

    #[test]
    fn band_kind_serde_round_trips_and_renames() {
        let json = serde_json::to_string(&BandKind::LowShelf).unwrap();
        assert_eq!(json, "\"low_shelf\"");
        let back: BandKind = serde_json::from_str("\"high_pass\"").unwrap();
        assert_eq!(back, BandKind::HighPass);
    }

    #[test]
    fn band_without_kind_defaults_to_peaking() {
        // Presets predating per-band shapes have no `kind` key.
        let band: EqBand =
            serde_json::from_str(r#"{"enabled":true,"freq_hz":1000,"q":1.0,"gain_db":3.0}"#)
                .unwrap();
        assert_eq!(band.kind, BandKind::Peaking);
    }

    #[test]
    fn bus_config_round_trips_eq_and_back_compat() {
        let mut b = BusDspConfig::default();
        b.eq.enabled = true;
        b.eq.bands[0].kind = BandKind::HighShelf;
        b.eq.bands[0].gain_db = 4.0;
        let json = serde_json::to_string(&b).unwrap();
        let back: BusDspConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(b, back);

        // Old bus presets carry only a limiter; eq falls back to default.
        let legacy: BusDspConfig =
            serde_json::from_str(r#"{"limiter":{"enabled":false,"threshold_db":-1.0,"attack_ms":0.5,"release_ms":100.0}}"#)
                .unwrap();
        assert_eq!(legacy.eq, EqConfig::default());
    }

    #[test]
    fn config_serde_round_trips() {
        let mut c = DspConfig::default();
        c.gate.enabled = true;
        c.compressor.ratio = 3.5;
        let json = serde_json::to_string(&c).unwrap();
        let back: DspConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(c, back);
    }

    #[test]
    fn config_deserializes_from_empty_object() {
        // Missing keys fall back to per-field defaults (preset back-compat).
        let c: DspConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(c, DspConfig::default());
    }

    #[test]
    fn compressor_makeup_allows_negative_trim() {
        let mut c = CompressorConfig {
            makeup_db: -6.0,
            ..CompressorConfig::default()
        };
        c.clamp();
        assert_eq!(c.makeup_db, -6.0);
    }

    #[test]
    fn eq_default_has_max_bands() {
        assert_eq!(EqConfig::default().bands.len(), MAX_EQ_BANDS);
    }

    #[test]
    fn bus_config_clamp_bounds_limiter() {
        let mut b = BusDspConfig::default();
        b.limiter.threshold_db = 99.0;
        b.clamp();
        assert_eq!(b.limiter.threshold_db, 0.0);
    }

    #[test]
    fn dsp_config_default_order_is_canonical() {
        assert_eq!(DspConfig::default().order, DspStage::ALL.to_vec());
    }

    #[test]
    fn normalize_order_dedupes_and_fills() {
        // Duplicates dropped (keep first), unknown count irrelevant, missing
        // stages appended in canonical order.
        let mut c = DspConfig::default();
        c.order = vec![DspStage::Limiter, DspStage::Eq, DspStage::Limiter];
        c.clamp();
        assert_eq!(
            c.order,
            vec![
                DspStage::Limiter,
                DspStage::Eq,
                DspStage::Denoise,
                DspStage::Hpf,
                DspStage::Gate,
                DspStage::Comp,
            ]
        );
    }

    #[test]
    fn normalize_order_empty_becomes_canonical() {
        let mut c = DspConfig::default();
        c.order = vec![];
        c.clamp();
        assert_eq!(c.order, DspStage::ALL.to_vec());
    }
}
