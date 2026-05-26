use serde::{Deserialize, Serialize};

/// Flat route representation used at the IPC boundary.
///
/// Constructed exclusively by `AudioGraph::to_routes()`; the graph is the
/// authoritative source of route state. `enabled` and `active` are derived
/// from `RouteState` (see `audio::graph`):
///   Disabled → enabled=false, active=false
///   Enabled  → enabled=true,  active=false  (Phase 4+ pre-config)
///   Active   → enabled=true,  active=true
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Route {
    pub input_id: String,
    pub output_id: String,
    pub enabled: bool,
    pub active: bool,
}
