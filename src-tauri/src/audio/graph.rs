use serde::{Deserialize, Serialize};

use crate::audio::routing::Route;

// ── Identity types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct NodeId(u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct RouteId(u32);

// ── Nodes ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InputNode {
    pub id: NodeId,
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputNode {
    pub id: NodeId,
    pub device_id: String,
}

// ── Route state ───────────────────────────────────────────────────────────────

/// `Disabled` — user has not requested audio flow (or has stopped it).
/// `Enabled`  — user wants audio flow but engine is not running yet.
/// `Active`   — engine thread is running; audio is flowing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum RouteState {
    Disabled,
    Enabled,
    Active,
}

// ── Route ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioRoute {
    pub id: RouteId,
    pub input: NodeId,
    pub output: NodeId,
    pub state: RouteState,
    /// Per-route gain in [0.0, 2.0]. Default 1.0.
    pub volume: f32,
    /// Muted routes remain configured but contribute silence to the mix.
    pub muted: bool,
}

// ── Graph ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct AudioGraph {
    pub inputs: Vec<InputNode>,
    pub outputs: Vec<OutputNode>,
    pub routes: Vec<AudioRoute>,
    next_node_id: u32,
    next_route_id: u32,
}

impl AudioGraph {
    pub fn new() -> Self {
        Self::default()
    }

    // ── ID allocation ─────────────────────────────────────────────────────────

    fn alloc_node_id(&mut self) -> NodeId {
        let id = NodeId(self.next_node_id);
        self.next_node_id += 1;
        id
    }

    fn alloc_route_id(&mut self) -> RouteId {
        let id = RouteId(self.next_route_id);
        self.next_route_id += 1;
        id
    }

    // ── Node helpers ──────────────────────────────────────────────────────────

    fn get_or_create_input(&mut self, device_id: &str) -> NodeId {
        if let Some(n) = self.inputs.iter().find(|n| n.device_id == device_id) {
            return n.id;
        }
        let id = self.alloc_node_id();
        self.inputs.push(InputNode { id, device_id: device_id.to_string() });
        id
    }

    fn get_or_create_output(&mut self, device_id: &str) -> NodeId {
        if let Some(n) = self.outputs.iter().find(|n| n.device_id == device_id) {
            return n.id;
        }
        let id = self.alloc_node_id();
        self.outputs.push(OutputNode { id, device_id: device_id.to_string() });
        id
    }

    // ── Route operations ──────────────────────────────────────────────────────

    /// Create or update state for (input_id → output_id).
    /// Preserves existing volume/muted when updating an existing route.
    pub fn upsert_route(&mut self, input_id: &str, output_id: &str, state: RouteState) {
        let in_node = self.get_or_create_input(input_id);
        let out_node = self.get_or_create_output(output_id);
        if let Some(r) = self
            .routes
            .iter_mut()
            .find(|r| r.input == in_node && r.output == out_node)
        {
            r.state = state;
            return; // volume/muted preserved
        }
        let id = self.alloc_route_id();
        self.routes.push(AudioRoute {
            id,
            input: in_node,
            output: out_node,
            state,
            volume: 1.0,
            muted: false,
        });
    }

    /// Update gain/mute for an existing route. Returns false if route not found.
    pub fn set_route_gain(
        &mut self,
        input_id: &str,
        output_id: &str,
        volume: f32,
        muted: bool,
    ) -> bool {
        let in_node = match self.inputs.iter().find(|n| n.device_id == input_id) {
            Some(n) => n.id,
            None => return false,
        };
        let out_node = match self.outputs.iter().find(|n| n.device_id == output_id) {
            Some(n) => n.id,
            None => return false,
        };
        if let Some(r) = self
            .routes
            .iter_mut()
            .find(|r| r.input == in_node && r.output == out_node)
        {
            r.volume = volume;
            r.muted = muted;
            true
        } else {
            false
        }
    }

    /// Return the output device_id of the first Active route, if any.
    pub fn active_output(&self) -> Option<String> {
        self.routes
            .iter()
            .find(|r| r.state == RouteState::Active)
            .and_then(|r| {
                self.outputs.iter().find(|n| n.id == r.output).map(|n| n.device_id.clone())
            })
    }

    /// Return (device_name, volume, muted) for all Active inputs routing to output_id.
    pub fn active_inputs_for_output(&self, output_id: &str) -> Vec<(String, f32, bool)> {
        let out_node = match self.outputs.iter().find(|n| n.device_id == output_id) {
            Some(n) => n.id,
            None => return vec![],
        };
        self.routes
            .iter()
            .filter(|r| r.output == out_node && r.state == RouteState::Active)
            .filter_map(|r| {
                let name =
                    self.inputs.iter().find(|n| n.id == r.input)?.device_id.clone();
                Some((name, r.volume, r.muted))
            })
            .collect()
    }

    /// Set all routes to Disabled.
    pub fn deactivate_all(&mut self) {
        for r in self.routes.iter_mut() {
            r.state = RouteState::Disabled;
        }
    }

    /// Remove all nodes and routes. Node IDs are NOT reset (monotonically increasing).
    pub fn clear(&mut self) {
        self.inputs.clear();
        self.outputs.clear();
        self.routes.clear();
    }

    // ── IPC bridge ───────────────────────────────────────────────────────────

    /// Convert graph routes to the flat `Route` list returned by IPC commands.
    pub fn to_routes(&self) -> Vec<Route> {
        self.routes
            .iter()
            .map(|ar| {
                let input_id = self
                    .inputs
                    .iter()
                    .find(|n| n.id == ar.input)
                    .map(|n| n.device_id.clone())
                    .unwrap_or_default();
                let output_id = self
                    .outputs
                    .iter()
                    .find(|n| n.id == ar.output)
                    .map(|n| n.device_id.clone())
                    .unwrap_or_default();
                let (enabled, active) = match ar.state {
                    RouteState::Disabled => (false, false),
                    RouteState::Enabled => (true, false),
                    RouteState::Active => (true, true),
                };
                Route {
                    input_id,
                    output_id,
                    enabled,
                    active,
                    volume: ar.volume,
                    muted: ar.muted,
                }
            })
            .collect()
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_defaults_volume_muted() {
        let mut g = AudioGraph::new();
        g.upsert_route("mic", "speakers", RouteState::Active);
        let routes = g.to_routes();
        assert_eq!(routes.len(), 1);
        assert!((routes[0].volume - 1.0).abs() < f32::EPSILON);
        assert!(!routes[0].muted);
    }

    #[test]
    fn set_route_gain_updates_values() {
        let mut g = AudioGraph::new();
        g.upsert_route("mic", "speakers", RouteState::Active);
        assert!(g.set_route_gain("mic", "speakers", 0.5, true));
        let routes = g.to_routes();
        assert!((routes[0].volume - 0.5).abs() < f32::EPSILON);
        assert!(routes[0].muted);
    }

    #[test]
    fn upsert_preserves_volume_muted_on_state_change() {
        let mut g = AudioGraph::new();
        g.upsert_route("mic", "speakers", RouteState::Active);
        g.set_route_gain("mic", "speakers", 0.7, true);
        g.upsert_route("mic", "speakers", RouteState::Disabled);
        let routes = g.to_routes();
        assert!((routes[0].volume - 0.7).abs() < f32::EPSILON);
        assert!(routes[0].muted);
    }

    #[test]
    fn set_route_gain_returns_false_for_unknown_route() {
        let mut g = AudioGraph::new();
        assert!(!g.set_route_gain("nonexistent", "output", 0.5, false));
    }

    #[test]
    fn active_inputs_for_output_returns_active_only() {
        let mut g = AudioGraph::new();
        g.upsert_route("mic1", "spk", RouteState::Active);
        g.upsert_route("mic2", "spk", RouteState::Active);
        g.upsert_route("mic3", "spk", RouteState::Disabled);
        let inputs = g.active_inputs_for_output("spk");
        assert_eq!(inputs.len(), 2);
        assert!(inputs.iter().any(|(n, _, _)| n == "mic1"));
        assert!(inputs.iter().any(|(n, _, _)| n == "mic2"));
    }
}
