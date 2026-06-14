//! Output bus runtime foundation (Phase 8A).
//!
//! Introduces 4 fixed output buses (A1, A2, B1, B2). Each bus owns at most one
//! independent `MixerEngine` instance, assignable to any output device
//! (hardware or third-party virtual cable). Per-bus controls — output device,
//! volume, mute, enabled — live in `BusConfig`. Per-bus engine and last error
//! live in `BusRuntime`.
//!
//! Phase 8A keeps the existing single-bus user flow working by funnelling all
//! legacy commands through bus A1. The matrix model (per-input sends to many
//! buses) lands in Phase 8B.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::audio::dsp::BusDspConfig;
use crate::audio::meters::LoudnessSnapshot;
use crate::audio::mixer::MixerEngine;

/// Stable, hashable identifier for the four fixed output buses.
///
/// Serializes as the uppercase short string ("A1", "A2", "B1", "B2") so the
/// frontend can use these as plain JSON values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum BusId {
    A1,
    A2,
    B1,
    B2,
}

impl BusId {
    /// All four bus IDs in display order.
    pub const ALL: [BusId; 4] = [BusId::A1, BusId::A2, BusId::B1, BusId::B2];

    /// Default human-readable name for this bus.
    pub fn default_name(self) -> &'static str {
        match self {
            BusId::A1 => "A1 Monitor",
            BusId::A2 => "A2 Speakers",
            BusId::B1 => "B1 Stream",
            BusId::B2 => "B2 Record",
        }
    }
}

/// Named output-latency presets (#35). A user-facing abstraction over the raw
/// `buffer_size_frames` the engine consumes: `Stable` lets the driver choose
/// (safest, fewest dropouts), `Low` and `UltraLow` request progressively smaller
/// fixed callback buffers. The engine still reads `buffer_size_frames`; this maps
/// to/from it so the UI can offer modes instead of raw frame counts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LatencyMode {
    Stable,
    Low,
    UltraLow,
}

impl LatencyMode {
    #[cfg(test)]
    pub const ALL: [LatencyMode; 3] =
        [LatencyMode::Stable, LatencyMode::Low, LatencyMode::UltraLow];

    /// The buffer size this mode requests. `None` = driver default (Stable).
    pub fn frames(self) -> Option<u32> {
        match self {
            LatencyMode::Stable => None,
            LatencyMode::Low => Some(256),
            LatencyMode::UltraLow => Some(128),
        }
    }

    /// Which named mode a raw buffer size corresponds to, or `None` for a custom
    /// frame count that doesn't match a preset.
    pub fn from_frames(frames: Option<u32>) -> Option<LatencyMode> {
        match frames {
            None => Some(LatencyMode::Stable),
            Some(256) => Some(LatencyMode::Low),
            Some(128) => Some(LatencyMode::UltraLow),
            Some(_) => None,
        }
    }

    pub fn parse(s: &str) -> Option<LatencyMode> {
        match s {
            "stable" => Some(LatencyMode::Stable),
            "low" => Some(LatencyMode::Low),
            "ultra-low" => Some(LatencyMode::UltraLow),
            _ => None,
        }
    }
}

/// User-editable configuration for a single bus.
///
/// Held inside `BusRuntime`. Mutating this struct does NOT automatically
/// rebuild the engine — the caller is responsible for calling
/// `rebuild_bus` after a structural change (device or enabled flag).
/// Volume and mute updates can be pushed atomically to a running engine
/// without a rebuild.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BusConfig {
    pub id: BusId,
    pub name: String,
    pub output_device_id: Option<String>,
    /// Bus-level gain in [0.0, 2.0]. Default 1.0.
    pub volume: f32,
    pub muted: bool,
    /// User toggle. Engine only starts when `enabled` AND `output_device_id`
    /// is set AND there is at least one active input routed to the device.
    pub enabled: bool,
    /// Per-bus DSP chain (final limiter in #32). `serde(default)` so configs
    /// saved before #32 deserialize as a bypassed chain.
    #[serde(default)]
    pub dsp: BusDspConfig,
    /// Output callback buffer size in frames. `None` = CPAL default (driver
    /// chooses). Set to e.g. 128 or 256 for lower device-callback latency (#35).
    /// `serde(default)` so pre-#35 configs load as None (driver default).
    #[serde(default)]
    pub buffer_size_frames: Option<u32>,
}

impl BusConfig {
    /// Default config for a given bus id (unassigned, disabled, unity gain).
    pub fn default_for(id: BusId) -> Self {
        Self {
            id,
            name: id.default_name().to_string(),
            output_device_id: None,
            volume: 1.0,
            muted: false,
            enabled: false,
            dsp: BusDspConfig::default(),
            buffer_size_frames: None,
        }
    }

    /// Clamp an arbitrary volume value to the legal range.
    /// NaN or non-finite values fall back to unity (1.0).
    pub fn clamp_volume(v: f32) -> f32 {
        if !v.is_finite() {
            1.0
        } else {
            v.clamp(0.0, 2.0)
        }
    }
}

/// Snapshot of a bus's full state — emitted across IPC for the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct BusStatus {
    pub id: BusId,
    pub name: String,
    pub output_device: Option<String>,
    pub volume: f32,
    pub muted: bool,
    pub enabled: bool,
    pub running: bool,
    pub output_peak: f32,
    pub clipped_recently: bool,
    pub last_error: Option<String>,
    /// Per-bus DSP chain, surfaced so the frontend can render bus effect state.
    pub dsp: BusDspConfig,
    /// Dropout counters since the last poll. Underrun = mixer outran capture
    /// (silence inserted); overrun = capture outran mixer or resync trim fired
    /// (samples lost). Both reset to 0 on each `read_status` / `get_system_status`
    /// call so the frontend sees per-interval counts, not lifetime totals.
    pub underruns: u64,
    pub overruns: u64,
    /// Current output buffer size setting, mirrored from `BusConfig`. `None`
    /// means the driver default is in use.
    pub buffer_size_frames: Option<u32>,
    /// Streaming loudness snapshot (#38): RMS, momentary/short LUFS, true peak,
    /// and a plain-language verdict. Defaults to the silence floor when the bus
    /// has no running engine.
    pub loudness: LoudnessSnapshot,
    /// The named latency mode `buffer_size_frames` maps to (#35), or `None` for
    /// a custom frame count that matches no preset. Derived, not stored.
    pub latency_mode: Option<LatencyMode>,
}

/// Per-bus runtime state owned by `AppInner`.
///
/// Holds the optional `MixerEngine` and a per-bus last-error string so a
/// failure on one bus does not blank meters or errors on another.
pub struct BusRuntime {
    pub config: BusConfig,
    pub engine: Option<MixerEngine>,
    pub last_error: Option<String>,
}

impl BusRuntime {
    pub fn new(id: BusId) -> Self {
        Self {
            config: BusConfig::default_for(id),
            engine: None,
            last_error: None,
        }
    }

    /// Default set of four buses (A1/A2/B1/B2), all unassigned and disabled.
    pub fn default_set() -> BTreeMap<BusId, BusRuntime> {
        let mut map = BTreeMap::new();
        for id in BusId::ALL {
            map.insert(id, BusRuntime::new(id));
        }
        map
    }

    /// Build a `BusStatus` snapshot.
    ///
    /// Reads and resets the engine's meter atomics if an engine is present —
    /// matches the existing `get_engine_status` polling contract.
    pub fn read_status(&self) -> BusStatus {
        let (output_peak, clipped_recently, underruns, overruns) = match self.engine.as_ref() {
            Some(eng) => {
                let (_input_peaks, peak, clipped) = eng.read_and_reset_meters();
                let (un, ov) = eng.read_and_reset_xruns();
                (peak, clipped, un, ov)
            }
            None => (0.0, false, 0, 0),
        };

        let mut status = self.status_from_meters(output_peak, clipped_recently);
        status.underruns = underruns;
        status.overruns = overruns;
        if let Some(eng) = self.engine.as_ref() {
            status.loudness = eng.read_loudness();
        }
        status
    }

    pub fn status_from_meters(&self, output_peak: f32, clipped_recently: bool) -> BusStatus {
        BusStatus {
            id: self.config.id,
            name: self.config.name.clone(),
            output_device: self.config.output_device_id.clone(),
            volume: self.config.volume,
            muted: self.config.muted,
            enabled: self.config.enabled,
            running: self.engine.is_some(),
            output_peak,
            clipped_recently,
            last_error: self.last_error.clone(),
            dsp: self.config.dsp.clone(),
            underruns: 0,
            overruns: 0,
            buffer_size_frames: self.config.buffer_size_frames,
            loudness: LoudnessSnapshot::default(),
            latency_mode: LatencyMode::from_frames(self.config.buffer_size_frames),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latency_mode_maps_to_frames_round_trip() {
        assert_eq!(LatencyMode::Stable.frames(), None);
        assert_eq!(LatencyMode::Low.frames(), Some(256));
        assert_eq!(LatencyMode::UltraLow.frames(), Some(128));
        for m in LatencyMode::ALL {
            assert_eq!(LatencyMode::from_frames(m.frames()), Some(m));
        }
        assert_eq!(LatencyMode::from_frames(Some(512)), None); // custom frame count
        assert_eq!(LatencyMode::parse("ultra-low"), Some(LatencyMode::UltraLow));
        assert_eq!(LatencyMode::parse("nope"), None);
    }

    #[test]
    fn default_set_has_four_buses() {
        let set = BusRuntime::default_set();
        assert_eq!(set.len(), 4);
        assert!(set.contains_key(&BusId::A1));
        assert!(set.contains_key(&BusId::A2));
        assert!(set.contains_key(&BusId::B1));
        assert!(set.contains_key(&BusId::B2));
    }

    #[test]
    fn default_bus_is_unassigned_and_disabled() {
        let bus = BusRuntime::new(BusId::A1);
        assert_eq!(bus.config.id, BusId::A1);
        assert_eq!(bus.config.name, "A1 Monitor");
        assert!(bus.config.output_device_id.is_none());
        assert!(!bus.config.enabled);
        assert!(!bus.config.muted);
        assert!((bus.config.volume - 1.0).abs() < f32::EPSILON);
        assert!(bus.engine.is_none());
        assert!(bus.last_error.is_none());
    }

    #[test]
    fn default_names_match_locked_spec() {
        assert_eq!(BusId::A1.default_name(), "A1 Monitor");
        assert_eq!(BusId::A2.default_name(), "A2 Speakers");
        assert_eq!(BusId::B1.default_name(), "B1 Stream");
        assert_eq!(BusId::B2.default_name(), "B2 Record");
    }

    #[test]
    fn clamp_volume_clamps_to_range() {
        assert!((BusConfig::clamp_volume(-1.0) - 0.0).abs() < f32::EPSILON);
        assert!((BusConfig::clamp_volume(0.5) - 0.5).abs() < f32::EPSILON);
        assert!((BusConfig::clamp_volume(2.5) - 2.0).abs() < f32::EPSILON);
        assert!((BusConfig::clamp_volume(f32::INFINITY) - 1.0).abs() < f32::EPSILON);
        assert!((BusConfig::clamp_volume(f32::NAN) - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn status_for_disabled_bus_has_no_running_engine() {
        let bus = BusRuntime::new(BusId::B1);
        let status = bus.read_status();
        assert_eq!(status.id, BusId::B1);
        assert_eq!(status.name, "B1 Stream");
        assert!(!status.running);
        assert!(!status.enabled);
        assert!(status.output_device.is_none());
        assert!((status.output_peak - 0.0).abs() < f32::EPSILON);
        assert!(!status.clipped_recently);
    }

    #[test]
    fn bus_config_deserializes_without_dsp_field() {
        // Config saved before #32 has no `dsp` key.
        let json = r#"{"id":"B1","name":"B1 Stream","output_device_id":null,
            "volume":1.0,"muted":false,"enabled":false}"#;
        let cfg: BusConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.dsp, BusDspConfig::default());
    }

    #[test]
    fn bus_status_exposes_dsp() {
        let bus = BusRuntime::new(BusId::B1);
        let json = serde_json::to_value(bus.read_status()).unwrap();
        assert!(json.get("dsp").is_some());
    }

    #[test]
    fn busid_serializes_as_short_string() {
        let json = serde_json::to_string(&BusId::A1).unwrap();
        assert_eq!(json, "\"A1\"");
        let json = serde_json::to_string(&BusId::B2).unwrap();
        assert_eq!(json, "\"B2\"");
    }

    #[test]
    fn busid_deserializes_from_short_string() {
        let id: BusId = serde_json::from_str("\"A1\"").unwrap();
        assert_eq!(id, BusId::A1);
        let id: BusId = serde_json::from_str("\"B2\"").unwrap();
        assert_eq!(id, BusId::B2);
    }

    #[test]
    fn bus_status_serializes_round_trip_keys() {
        let bus = BusRuntime::new(BusId::A2);
        let status = bus.read_status();
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["id"], "A2");
        assert_eq!(json["name"], "A2 Speakers");
        assert!(json["output_device"].is_null());
        assert_eq!(json["volume"], 1.0);
        assert_eq!(json["muted"], false);
        assert_eq!(json["enabled"], false);
        assert_eq!(json["running"], false);
    }
}
