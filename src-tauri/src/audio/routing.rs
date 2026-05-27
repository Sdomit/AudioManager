use serde::{Deserialize, Serialize};

/// Flat route representation used at the IPC boundary.
///
/// Constructed exclusively by `AudioGraph::to_routes()`.
/// `enabled` and `active` are derived from `RouteState`:
///   Disabled → enabled=false, active=false
///   Enabled  → enabled=true,  active=false
///   Active   → enabled=true,  active=true
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Route {
    pub input_id: String,
    pub output_id: String,
    pub enabled: bool,
    pub active: bool,
    /// Per-route gain in [0.0, 2.0]. Default 1.0.
    pub volume: f32,
    /// True when this input is muted (contributes silence).
    pub muted: bool,
}
