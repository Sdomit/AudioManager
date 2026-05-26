use std::sync::Mutex;

use crate::audio::{graph::AudioGraph, passthrough::PassthroughEngine};

/// All mutable engine state under a single lock.
/// Using one Mutex prevents lock-ordering bugs that would arise from
/// separate Mutex<engine> and Mutex<graph> fields.
pub struct AppInner {
    pub engine: Option<PassthroughEngine>,
    /// Internal audio graph: de-duplicated input/output nodes connected by
    /// typed routes with explicit RouteState. Replaces the flat Vec<Route>
    /// used in Phase 2; IPC commands convert via graph.to_routes().
    pub graph: AudioGraph,
}

pub struct AppState {
    pub inner: Mutex<AppInner>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(AppInner {
                engine: None,
                graph: AudioGraph::new(),
            }),
        }
    }
}
