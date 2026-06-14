use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

use crate::audio::bus::{BusId, BusRuntime};
use crate::audio::graph::AudioGraph;
use crate::audio::monitor::InputMonitor;
use crate::audio::recorder::RecorderHandle;

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
    /// Per-device input monitors for metering when no bus engine is running.
    /// Keyed by device_id (cpal device name only — not synthetic loopback ids).
    pub monitors: HashMap<String, InputMonitor>,
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
                monitors: HashMap::new(),
                last_error: None,
            }),
        }
    }
}
