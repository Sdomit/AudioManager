use std::collections::BTreeMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::audio::bus::{BusId, BusRuntime};
use crate::audio::dsp::AutomixConfig;
use crate::audio::graph::AudioGraph;
use crate::audio::metering_tap::MeteringTap;
use crate::audio::recorder::RecorderHandle;

/// A live-sound-gate automix group (Feature B): a set of co-located inputs
/// (typically phones) whose gains are shared so the closest mic dominates.
/// Members are stored as input device ids (the stable key), resolved to per-engine
/// input-slot bitmasks when published to the realtime layer. Serializable so it
/// round-trips through presets and IPC.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AutomixGroupDef {
    pub id: String,
    pub name: String,
    /// Member input device ids (same keys as the audio graph / mixer inputs).
    pub members: Vec<String>,
    pub config: AutomixConfig,
}

/// All mutable engine state under a single lock.
/// One Mutex prevents lock-ordering bugs that would arise from separate
/// Mutex<engine> and Mutex<graph> fields.
///
/// Phase 8A: the previous single `engine: Option<MixerEngine>` is replaced by
/// a fixed map of four bus runtimes (A1/A2/B1/B2). Each bus owns at most one
/// `MixerEngine`. The audio thread inside a `MixerEngine` never acquires this
/// lock; only the IPC thread does.
pub struct AppInner {
    pub buses: BTreeMap<BusId, BusRuntime>,
    pub graph: AudioGraph,
    /// Active recording handles, keyed by recording id.
    pub recorders: BTreeMap<String, RecorderHandle>,
    /// Live-sound-gate automix groups (Feature B). Resolved to per-engine slot
    /// bitmasks and published whenever a group changes or an engine rebuilds.
    pub automix_groups: Vec<AutomixGroupDef>,
    /// Per-device metering taps (#feature-idle-meter), keyed by input device id.
    /// One lightweight capture per real `Device` input so its level meter moves
    /// even while the input is unrouted. Reconciled to `graph` whenever the
    /// input set changes; merged into per-device peaks in `get_system_status`.
    pub metering_taps: BTreeMap<String, MeteringTap>,
    /// Global last-error string for operations not tied to a single bus.
    /// Per-bus errors live on `BusRuntime.last_error`.
    pub last_error: Option<String>,
}

pub struct AppState {
    pub inner: Mutex<AppInner>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(AppInner {
                buses: BusRuntime::default_set(),
                graph: AudioGraph::new(),
                recorders: BTreeMap::new(),
                automix_groups: Vec::new(),
                metering_taps: BTreeMap::new(),
                last_error: None,
            }),
        }
    }
}
