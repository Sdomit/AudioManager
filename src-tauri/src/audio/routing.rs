use serde::{Deserialize, Serialize};

/// Flat route representation used at the IPC boundary.
///
/// Constructed by legacy compatibility helpers that map A1 send state into
/// the Phase 4/5 route shape.
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
