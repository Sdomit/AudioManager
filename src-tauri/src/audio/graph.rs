use serde::{Deserialize, Serialize};

use crate::audio::routing::Route;

// ── Identity types ────────────────────────────────────────────────────────────

/// Opaque identifier for an input or output node within the graph.
/// u32 is sufficient for any realistic device count.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct NodeId(u32);

/// Opaque identifier for a route within the graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct RouteId(u32);

// ── Nodes ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InputNode {
    pub id: NodeId,
    pub device_id: String, // WASAPI display name; same as DeviceInfo.id
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputNode {
    pub id: NodeId,
    pub device_id: String,
}

// ── Route state ───────────────────────────────────────────────────────────────

/// Lifecycle state of a single audio route.
///
/// `Disabled` — user has not requested audio flow (or has stopped it).
/// `Enabled`  — user wants audio flow but engine is not running yet.
///              Reserved for Phase 4+ pre-configuration; Phase 3 goes
///              directly Disabled → Active on enable.
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
}

// ── Graph ─────────────────────────────────────────────────────────────────────

/// Internal representation of all configured audio paths.
///
/// Inputs and outputs are de-duplicated nodes. Routes are edges connecting
/// them. This separates device identity from connection intent, enabling
/// Phase 4+ features (per-node gain/mute, fan-out routing) without changing
/// the IPC surface — callers still see `Vec<Route>` via `to_routes()`.
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

    /// Create or update the route for (input_id → output_id) with the given state.
    pub fn upsert_route(&mut self, input_id: &str, output_id: &str, state: RouteState) {
        let in_node = self.get_or_create_input(input_id);
        let out_node = self.get_or_create_output(output_id);
        if let Some(r) = self
            .routes
            .iter_mut()
            .find(|r| r.input == in_node && r.output == out_node)
        {
            r.state = state;
            return;
        }
        let id = self.alloc_route_id();
        self.routes.push(AudioRoute { id, input: in_node, output: out_node, state });
    }

    /// Return the state of the route for (input_id → output_id), if it exists.
    pub fn find_route_state(&self, input_id: &str, output_id: &str) -> Option<&RouteState> {
        let in_node = self.inputs.iter().find(|n| n.device_id == input_id)?.id;
        let out_node = self.outputs.iter().find(|n| n.device_id == output_id)?.id;
        self.routes
            .iter()
            .find(|r| r.input == in_node && r.output == out_node)
            .map(|r| &r.state)
    }

    /// True if any route *other than* (input_id → output_id) is Active.
    pub fn has_other_active_route(&self, input_id: &str, output_id: &str) -> bool {
        let target_in = self.inputs.iter().find(|n| n.device_id == input_id).map(|n| n.id);
        let target_out = self.outputs.iter().find(|n| n.device_id == output_id).map(|n| n.id);
        self.routes.iter().any(|r| {
            r.state == RouteState::Active
                && !(Some(r.input) == target_in && Some(r.output) == target_out)
        })
    }

    /// Set all routes to Disabled (used when stopping all audio).
    pub fn deactivate_all(&mut self) {
        for r in self.routes.iter_mut() {
            r.state = RouteState::Disabled;
        }
    }

    /// Remove all nodes and routes.
    pub fn clear(&mut self) {
        self.inputs.clear();
        self.outputs.clear();
        self.routes.clear();
        // IDs are NOT reset — monotonically increasing IDs remain unique
        // across the session even after clear.
    }

    // ── IPC bridge ───────────────────────────────────────────────────────────

    /// Convert graph routes to the flat `Route` list that IPC commands return.
    /// Unknown node IDs produce empty strings (should never occur in practice).
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
                Route { input_id, output_id, enabled, active }
            })
            .collect()
    }
}
