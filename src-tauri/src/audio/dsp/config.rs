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

/// Per-group gain-sharing automix parameters (Dugan-style), used by the live
/// sound gate (Feature B). Co-located mics in one group share unity gain
/// weighted by each mic's level, so the loudest (closest) mic dominates and
/// duplicate captures of the same voice are pushed down — killing echo and
/// comb-filtering. Pure data: maps to `AutomixCoeffs` and the realtime
/// `AutomixGroup` in `automix.rs`. Cross-input, so unlike the other configs this
/// is not part of `DspConfig` (which is per-input); membership is carried
/// separately as resolved slot indices.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct AutomixConfig {
    pub enabled: bool,
    /// Energy-follower rise time (ms): how fast a newly-loud mic takes the share.
    pub attack_ms: f32,
    /// Energy-follower fall time (ms): how slowly a mic relinquishes its share.
    pub release_ms: f32,
    /// Minimum gain (dB) a suppressed member keeps, so a mic never hard-mutes.
    pub floor_db: f32,
    /// Group activity gate (dB): below this summed level the group holds its last
    /// gains (treated as silent) rather than dividing near-zero energy.
    pub noise_floor_db: f32,
}

impl Default for AutomixConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            attack_ms: 40.0,
            release_ms: 250.0,
            floor_db: -60.0,
            noise_floor_db: -50.0,
        }
    }
}

impl AutomixConfig {
    pub fn clamp(&mut self) {
        let d = Self::default();
        self.attack_ms = clamp_finite(self.attack_ms, d.attack_ms, TIME_MIN, TIME_MAX);
        self.release_ms = clamp_finite(self.release_ms, d.release_ms, TIME_MIN, TIME_MAX);
        self.floor_db = clamp_finite(self.floor_db, d.floor_db, -90.0, 0.0);
        self.noise_floor_db = clamp_finite(self.noise_floor_db, d.noise_floor_db, -90.0, 0.0);
    }
}

/// Neural denoiser backend. `Rnnoise` is the only one actually compiled in.
/// `DeepFilterNet`'s engine is NOT buildable yet (upstream tract/model blocker —
/// see denoise.rs and Cargo.toml), so selecting it would silently run as RNNoise.
/// `DenoiseConfig::clamp()` normalizes an unavailable backend to `Rnnoise` so the
/// stored/displayed backend never misrepresents what actually runs (#37). Flip
/// `DEEP_FILTER_NET_AVAILABLE` (and wire the dep) once DFN compiles in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DenoiseBackend {
    #[default]
    Rnnoise,
    DeepFilterNet,
}

impl DenoiseBackend {
    /// Whether the DeepFilterNet engine is compiled in. `false` until the
    /// upstream tract/model blocker is resolved and the `deep_filter` dep wired.
    pub const DEEP_FILTER_NET_AVAILABLE: bool = false;

    /// Whether this backend's engine is actually available to run on this build.
    pub fn is_available(self) -> bool {
        match self {
            DenoiseBackend::Rnnoise => true,
            DenoiseBackend::DeepFilterNet => Self::DEEP_FILTER_NET_AVAILABLE,
        }
    }
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
        // An unavailable backend (DeepFilterNet — not built yet) would silently
        // run as RNNoise. Normalize it so the stored/displayed backend always
        // matches what the engine actually runs (#37). Remove once DFN compiles
        // in. Runs on every IPC/preset path via DspConfig::clamp -> denoise.clamp.
        if !self.backend.is_available() {
            self.backend = DenoiseBackend::Rnnoise;
        }
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

/// Stereo image controls (#34): pan/balance, mono fold, channel swap, per-channel
/// phase invert, and mid/side width. Stateless — pure per-frame math on an `[L, R]`
/// pair, so it crosses the realtime boundary by value (no envelopes, no coeffs).
/// Only meaningful on 2-channel inputs; the realtime path skips it on mono.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct StereoConfig {
    /// Balance/pan, `-1.0` (hard left) .. `1.0` (hard right). `0.0` = center.
    pub pan: f32,
    /// Fold both channels to their average (true mono).
    pub mono: bool,
    /// Swap left and right.
    pub swap: bool,
    /// Invert the left channel's polarity.
    pub invert_left: bool,
    /// Invert the right channel's polarity.
    pub invert_right: bool,
    /// Mid (center) component scale, `0.0` .. `2.0`. `1.0` = transparent.
    pub center_level: f32,
    /// Side (difference) component scale, `0.0` .. `2.0`. `1.0` = transparent,
    /// `0.0` = mono, `> 1.0` = widen.
    pub width: f32,
}

impl Default for StereoConfig {
    fn default() -> Self {
        Self {
            pan: 0.0,
            mono: false,
            swap: false,
            invert_left: false,
            invert_right: false,
            center_level: 1.0,
            width: 1.0,
        }
    }
}

impl StereoConfig {
    pub fn clamp(&mut self) {
        let d = Self::default();
        self.pan = clamp_finite(self.pan, d.pan, -1.0, 1.0);
        self.center_level = clamp_finite(self.center_level, d.center_level, 0.0, 2.0);
        self.width = clamp_finite(self.width, d.width, 0.0, 2.0);
    }

    /// True when any control departs from transparent identity. The realtime
    /// path skips the whole stage when this is false.
    pub fn is_active(&self) -> bool {
        self.pan != 0.0
            || self.mono
            || self.swap
            || self.invert_left
            || self.invert_right
            || self.center_level != 1.0
            || self.width != 1.0
    }

    /// Apply the stereo image transform to one interleaved `[L, R]` frame.
    /// Order: swap → phase → mono → mid/side → pan. Pan uses an equal-power
    /// taper renormalized to unity at center and clamped at `1.0`, so it behaves
    /// as an attenuate-only balance law (no channel is ever boosted).
    #[inline]
    pub fn process_frame(&self, frame: &mut [f32; 2]) {
        let (mut l, mut r) = (frame[0], frame[1]);

        if self.swap {
            std::mem::swap(&mut l, &mut r);
        }
        if self.invert_left {
            l = -l;
        }
        if self.invert_right {
            r = -r;
        }
        if self.mono {
            let m = (l + r) * 0.5;
            l = m;
            r = m;
        }
        if self.center_level != 1.0 || self.width != 1.0 {
            let m = (l + r) * 0.5 * self.center_level;
            let s = (l - r) * 0.5 * self.width;
            l = m + s;
            r = m - s;
        }
        if self.pan != 0.0 {
            let theta = (self.pan + 1.0) * std::f32::consts::FRAC_PI_4;
            let (sin, cos) = theta.sin_cos();
            let gl = (cos * std::f32::consts::SQRT_2).min(1.0);
            let gr = (sin * std::f32::consts::SQRT_2).min(1.0);
            l *= gl;
            r *= gr;
        }

        frame[0] = l;
        frame[1] = r;
    }
}

/// Binaural 3D position (HRTF-style). Places a (mono-folded) source around the
/// listener's head for **headphone** playback: `azimuth_deg` 0 = front, +90 =
/// hard right, ±180 = directly behind; `distance` 0 = at the head, 1 = far.
/// When `enabled`, it supersedes [`StereoConfig::pan`] (azimuth owns left/right).
/// The realtime cues (ITD/ILD/front-back) live in `dsp/binaural.rs`; this is the
/// serialized control surface only. On loudspeakers it degrades to a level/tone
/// shift rather than true 3D (there is no rear speaker — output is stereo-only).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct SpatialConfig {
    pub enabled: bool,
    /// Azimuth in degrees, `-180.0` .. `180.0`. 0 = front, +90 = right.
    pub azimuth_deg: f32,
    /// Distance, `0.0` (at the head) .. `1.0` (far).
    pub distance: f32,
}

impl Default for SpatialConfig {
    fn default() -> Self {
        Self {
            // Binaural 3D is on by default. At azimuth 0 / distance 0 the
            // spatialiser is transparent for a mono source (mics), so a fresh
            // input is unaffected until the position pad is dragged; stereo
            // sources are folded to a centered mono point (binaural positions a
            // point source). Toggle 3D off per-input to keep flat stereo.
            enabled: true,
            azimuth_deg: 0.0,
            distance: 0.0,
        }
    }
}

impl SpatialConfig {
    pub fn clamp(&mut self) {
        // Wrap azimuth into [-180, 180] (a full circle is meaningful); non-finite
        // → front.
        let a = if self.azimuth_deg.is_finite() {
            self.azimuth_deg
        } else {
            0.0
        };
        self.azimuth_deg = ((a + 180.0).rem_euclid(360.0)) - 180.0;
        self.distance = clamp_finite(self.distance, 0.0, 0.0, 1.0);
    }

    /// The realtime path runs the spatialiser only when enabled; off = bypass.
    pub fn is_active(&self) -> bool {
        self.enabled
    }
}

/// Current DSP-config schema version. Bump when a field's meaning changes in a
/// way `#[serde(default)]` cannot transparently handle, and add a migration arm
/// in [`DspConfig::migrate`].
pub const DSP_CONFIG_VERSION: u32 = 1;

/// Schema version assumed for a payload that predates the `version` field.
fn default_dsp_version() -> u32 {
    0
}

/// Full per-input effect chain. `order` carries the wired processing order
/// (default: Denoise → HPF → Gate → EQ → Compressor → Limiter). The stereo
/// image stage runs after the ordered chain, pre-gain (see `live.rs`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DspConfig {
    /// Schema version this config was written with. `serde(default)` yields 0
    /// for pre-versioning payloads; [`DspConfig::clamp`] migrates them current.
    #[serde(default = "default_dsp_version")]
    pub version: u32,
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
    /// Stereo image controls, applied after the ordered chain. `serde(default)`
    /// so pre-#34 configs load transparent.
    #[serde(default)]
    pub stereo: StereoConfig,
    /// Binaural 3D position. `serde(default)` so pre-binaural configs load
    /// disabled. When enabled it supersedes `stereo.pan` (azimuth owns L/R).
    #[serde(default)]
    pub spatial: SpatialConfig,
}

impl Default for DspConfig {
    fn default() -> Self {
        Self {
            version: DSP_CONFIG_VERSION,
            denoise: DenoiseConfig::default(),
            hpf: HpfConfig::default(),
            gate: GateConfig::default(),
            eq: EqConfig::default(),
            compressor: CompressorConfig::default(),
            limiter: LimiterConfig::default(),
            order: default_dsp_order(),
            stereo: StereoConfig::default(),
            spatial: SpatialConfig::default(),
        }
    }
}

impl DspConfig {
    /// Clamp every effect's parameters to safe ranges and normalize the stage
    /// order. Run on the IPC thread before publishing to the realtime atomics,
    /// so the audio callback only ever sees valid values.
    pub fn clamp(&mut self) {
        self.migrate();
        self.denoise.clamp();
        self.hpf.clamp();
        self.gate.clamp();
        self.eq.clamp();
        self.compressor.clamp();
        self.limiter.clamp();
        normalize_order(&mut self.order);
        self.stereo.clamp();
        self.spatial.clamp();
    }

    /// Upgrade an older-schema config to the current version in place. Every
    /// field added since v0 carries `#[serde(default)]`, so an older payload
    /// already deserializes into the current shape; the only step today is
    /// stamping the version. Future breaking changes match on `self.version`.
    fn migrate(&mut self) {
        self.version = DSP_CONFIG_VERSION;
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
    fn denoise_clamp_normalizes_unavailable_backend() {
        // DeepFilterNet isn't compiled in (#37), so clamp must rewrite it to
        // RNNoise rather than persist/display a backend that silently runs as
        // RNNoise — no silent capability mismatch.
        assert!(!DenoiseBackend::DeepFilterNet.is_available());
        assert!(DenoiseBackend::Rnnoise.is_available());

        let mut d = DenoiseConfig { enabled: true, backend: DenoiseBackend::DeepFilterNet };
        d.clamp();
        assert_eq!(d.backend, DenoiseBackend::Rnnoise);

        // And it flows through the parent chain clamp.
        let mut cfg = DspConfig { denoise: DenoiseConfig { enabled: true, backend: DenoiseBackend::DeepFilterNet }, ..DspConfig::default() };
        cfg.clamp();
        assert_eq!(cfg.denoise.backend, DenoiseBackend::Rnnoise);
    }

    #[test]
    fn default_has_current_schema_version() {
        assert_eq!(DspConfig::default().version, DSP_CONFIG_VERSION);
    }

    #[test]
    fn version_absent_payload_is_legacy_then_migrates() {
        // A payload that predates the `version` field deserializes as v0.
        let mut c: DspConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(c.version, 0, "missing version must read as legacy v0");
        c.clamp();
        assert_eq!(c.version, DSP_CONFIG_VERSION, "clamp migrates to current");
    }

    #[test]
    fn version_round_trips_through_serde() {
        let c = DspConfig::default();
        let json = serde_json::to_string(&c).unwrap();
        assert!(json.contains("\"version\":"), "version must serialize");
        let back: DspConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back, c);
    }

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
    fn stereo_default_is_transparent() {
        let s = StereoConfig::default();
        assert!(!s.is_active());
        let mut f = [0.42, -0.17];
        s.process_frame(&mut f);
        assert_eq!(f, [0.42, -0.17]);
    }

    #[test]
    fn stereo_pan_attenuates_far_channel_never_boosts() {
        // Hard right: left silenced, right held at unity (no boost).
        let s = StereoConfig {
            pan: 1.0,
            ..StereoConfig::default()
        };
        let mut f = [0.8, 0.8];
        s.process_frame(&mut f);
        assert!(f[0].abs() < 1e-6, "left should be silenced, got {}", f[0]);
        assert!((f[1] - 0.8).abs() < 1e-6, "right unchanged, got {}", f[1]);

        // Center is unity on both channels (no -3 dB dip).
        let c = StereoConfig {
            pan: 0.0,
            ..StereoConfig::default()
        };
        let mut g = [0.5, 0.5];
        c.process_frame(&mut g);
        assert_eq!(g, [0.5, 0.5]);
    }

    #[test]
    fn stereo_mono_folds_to_average() {
        let s = StereoConfig {
            mono: true,
            ..StereoConfig::default()
        };
        let mut f = [1.0, 0.0];
        s.process_frame(&mut f);
        assert_eq!(f, [0.5, 0.5]);
    }

    #[test]
    fn stereo_swap_and_phase() {
        let s = StereoConfig {
            swap: true,
            invert_left: true,
            ..StereoConfig::default()
        };
        // swap first: l,r = 0.2,0.7 -> 0.7,0.2 ; then invert_left -> -0.7,0.2
        let mut f = [0.2, 0.7];
        s.process_frame(&mut f);
        assert!((f[0] + 0.7).abs() < 1e-6);
        assert!((f[1] - 0.2).abs() < 1e-6);
    }

    #[test]
    fn stereo_width_zero_collapses_to_mono() {
        let s = StereoConfig {
            width: 0.0,
            ..StereoConfig::default()
        };
        let mut f = [1.0, -1.0];
        s.process_frame(&mut f);
        // side killed -> both channels carry the mid (here 0).
        assert!(f[0].abs() < 1e-6 && f[1].abs() < 1e-6);
    }

    #[test]
    fn stereo_clamp_bounds_and_non_finite() {
        let mut s = StereoConfig {
            pan: 5.0,
            center_level: -1.0,
            width: f32::NAN,
            ..StereoConfig::default()
        };
        s.clamp();
        assert_eq!(s.pan, 1.0);
        assert_eq!(s.center_level, 0.0);
        assert_eq!(s.width, 1.0); // NaN -> default
    }

    #[test]
    fn stereo_serde_missing_fields_default() {
        let s: StereoConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(s, StereoConfig::default());
        let m: StereoConfig = serde_json::from_str(r#"{"mono":true}"#).unwrap();
        assert!(m.mono);
        assert_eq!(m.width, 1.0);
    }

    #[test]
    fn dsp_config_carries_stereo_through_serde_default() {
        // A pre-#34 payload (no `stereo` key) loads transparent.
        let json = r#"{"hpf":{"enabled":true,"freq_hz":120.0}}"#;
        let c: DspConfig = serde_json::from_str(json).unwrap();
        assert!(c.hpf.enabled);
        assert_eq!(c.stereo, StereoConfig::default());
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
        // Missing keys fall back to per-field defaults (preset back-compat); the
        // version field's default is the legacy 0 marker (migrated to current on
        // clamp), so an empty object is the default chain at version 0.
        let c: DspConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(c, DspConfig { version: 0, ..DspConfig::default() });
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
