use serde::{Deserialize, Serialize};

use crate::audio::bus::BusId;
use crate::audio::dsp::DspConfig;
use crate::audio::routing::Route;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InputSend {
    pub bus_id: BusId,
    pub enabled: bool,
    /// Per-send gain in [0.0, 2.0]. Default 1.0.
    pub volume: f32,
    pub muted: bool,
}

impl InputSend {
    pub fn default_for(bus_id: BusId) -> Self {
        Self {
            bus_id,
            enabled: false,
            volume: 1.0,
            muted: false,
        }
    }

    pub fn clamp_volume(v: f32) -> f32 {
        if !v.is_finite() {
            1.0
        } else {
            v.clamp(0.0, 2.0)
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InputChannel {
    pub device_id: String,
    /// Input master gain in [0.0, 2.0]. Default 1.0.
    pub gain: f32,
    pub muted: bool,
    pub sends: Vec<InputSend>,
    /// Per-input DSP chain (HPF/gate/EQ/comp/limiter). `serde(default)` so graph
    /// and preset data saved before #32 deserialize as a bypassed chain.
    #[serde(default)]
    pub dsp: DspConfig,
    /// Monitor preview (#feature1): when true, the input is force-routed to the
    /// monitor bus (A1) for headphone listening, regardless of its persisted A1
    /// send. This is a transient listen flag — it never mutates `sends`, and if
    /// the A1 send is already enabled it adds no second contribution.
    /// `serde(default)` so pre-#feature1 graphs/presets load as monitor-off.
    #[serde(default)]
    pub monitor: bool,
    /// Optional user-facing display name (#feature8). `None` → the frontend
    /// derives a name from `device_id`. Phone inputs are auto-labelled with the
    /// paired device's hostname; any input can be renamed. `serde(default)` so
    /// older graphs/presets load with no custom label.
    #[serde(default)]
    pub label: Option<String>,
    /// Input boost / trim (#feature-boost): a clean-gain multiplier applied on
    /// top of the fader, for quiet sources (camera / shotgun mics). Range
    /// [1.0, 5.0] where 1.0 = +0 (off / 100%) and 5.0 = 500% (~+14 dB). Kept
    /// separate from `gain` so the fader stays a normal 0..unity..+6 dB control
    /// and the boost round-trips losslessly. `serde(default_boost)` so older
    /// graphs/presets load at unity (no boost).
    #[serde(default = "default_boost")]
    pub boost: f32,
}

fn default_boost() -> f32 {
    1.0
}

impl InputChannel {
    pub fn new(device_id: impl Into<String>) -> Self {
        Self {
            device_id: device_id.into(),
            gain: 1.0,
            muted: false,
            sends: BusId::ALL.into_iter().map(InputSend::default_for).collect(),
            dsp: DspConfig::default(),
            monitor: false,
            label: None,
            boost: 1.0,
        }
    }

    pub fn clamp_gain(v: f32) -> f32 {
        if !v.is_finite() {
            1.0
        } else {
            v.clamp(0.0, 2.0)
        }
    }

    /// Clamp the boost multiplier to [1.0, 5.0] (100%..500%); non-finite → 1.0.
    pub fn clamp_boost(v: f32) -> f32 {
        if !v.is_finite() {
            1.0
        } else {
            v.clamp(1.0, 5.0)
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct AudioGraph {
    pub inputs: Vec<InputChannel>,
}

impl AudioGraph {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn list_inputs(&self) -> Vec<InputChannel> {
        self.inputs.clone()
    }

    pub fn has_input(&self, device_id: &str) -> bool {
        self.inputs.iter().any(|input| input.device_id == device_id)
    }

    pub fn add_input(&mut self, device_id: &str) -> bool {
        if self.has_input(device_id) {
            return false;
        }
        self.inputs.push(InputChannel::new(device_id));
        true
    }

    pub fn remove_input(&mut self, device_id: &str) -> bool {
        let before = self.inputs.len();
        self.inputs.retain(|input| input.device_id != device_id);
        before != self.inputs.len()
    }

    pub fn clear(&mut self) {
        self.inputs.clear();
    }

    pub fn set_input_gain(&mut self, device_id: &str, gain: f32, muted: bool) -> bool {
        let Some(input) = self
            .inputs
            .iter_mut()
            .find(|input| input.device_id == device_id)
        else {
            return false;
        };
        input.gain = InputChannel::clamp_gain(gain);
        input.muted = muted;
        true
    }

    /// Set (or clear, with `None`) an input's display label (#feature8). Blank
    /// strings are normalised to `None`. Returns false if no input matches.
    pub fn set_label(&mut self, device_id: &str, label: Option<String>) -> bool {
        let Some(input) = self
            .inputs
            .iter_mut()
            .find(|input| input.device_id == device_id)
        else {
            return false;
        };
        input.label = label.filter(|s| !s.trim().is_empty());
        true
    }

    /// Swap an input's underlying device, preserving gain / mute / sends / DSP /
    /// monitor / label (#feature7). Returns false if `old_id` is absent or
    /// `new_id` already exists (caller treats false as "input unchanged"); the
    /// graph is left untouched in both failure cases.
    pub fn replace_input_device(&mut self, old_id: &str, new_id: &str) -> bool {
        if old_id == new_id {
            return self.has_input(old_id);
        }
        if self.has_input(new_id) {
            return false;
        }
        let Some(input) = self
            .inputs
            .iter_mut()
            .find(|input| input.device_id == old_id)
        else {
            return false;
        };
        input.device_id = new_id.to_string();
        true
    }

    /// Store a per-input DSP config, clamped to safe ranges. Returns false if no
    /// input matches `device_id`.
    pub fn set_input_dsp(&mut self, device_id: &str, mut dsp: DspConfig) -> bool {
        let Some(input) = self
            .inputs
            .iter_mut()
            .find(|input| input.device_id == device_id)
        else {
            return false;
        };
        dsp.clamp();
        input.dsp = dsp;
        true
    }

    /// Set an input's boost/trim multiplier (#feature-boost), clamped to
    /// [1.0, 5.0]. Returns false if no input matches `device_id`.
    pub fn set_boost(&mut self, device_id: &str, boost: f32) -> bool {
        let Some(input) = self
            .inputs
            .iter_mut()
            .find(|input| input.device_id == device_id)
        else {
            return false;
        };
        input.boost = InputChannel::clamp_boost(boost);
        true
    }

    /// Toggle monitor preview for an input (#feature1). Does not touch `sends`,
    /// so the persisted routing is unchanged. Returns false if no input matches.
    pub fn set_monitor(&mut self, device_id: &str, enabled: bool) -> bool {
        let Some(input) = self
            .inputs
            .iter_mut()
            .find(|input| input.device_id == device_id)
        else {
            return false;
        };
        input.monitor = enabled;
        true
    }

    pub fn set_send(&mut self, device_id: &str, bus_id: BusId, enabled: bool) -> bool {
        let Some(send) = self.find_send_mut(device_id, bus_id) else {
            return false;
        };
        send.enabled = enabled;
        true
    }

    pub fn set_send_gain(
        &mut self,
        device_id: &str,
        bus_id: BusId,
        volume: f32,
        muted: bool,
    ) -> bool {
        let Some(send) = self.find_send_mut(device_id, bus_id) else {
            return false;
        };
        send.volume = InputSend::clamp_volume(volume);
        send.muted = muted;
        true
    }

    pub fn get_send(&self, device_id: &str, bus_id: BusId) -> Option<&InputSend> {
        self.inputs
            .iter()
            .find(|input| input.device_id == device_id)?
            .sends
            .iter()
            .find(|send| send.bus_id == bus_id)
    }

    pub fn get_input(&self, device_id: &str) -> Option<&InputChannel> {
        self.inputs
            .iter()
            .find(|input| input.device_id == device_id)
    }

    pub fn effective_input_for_bus(
        &self,
        device_id: &str,
        bus_id: BusId,
    ) -> Option<(f32, bool, bool)> {
        let input = self.get_input(device_id)?;
        let send = input.sends.iter().find(|send| send.bus_id == bus_id)?;
        // Monitor preview force-activates the input on the monitor bus (A1) at
        // unity send, without an enabled send (#feature1).
        let monitor_only = bus_id == BusId::A1 && input.monitor && !send.enabled;
        let send_volume = if send.enabled { send.volume } else { 1.0 };
        // Boost/trim (#feature-boost) multiplies on top of fader * send.
        let effective_gain = input.gain * send_volume * input.boost;
        let gain = if effective_gain.is_finite() {
            effective_gain.max(0.0)
        } else {
            1.0
        };
        let muted = input.muted || (send.enabled && send.muted);
        Some((gain, muted, send.enabled || monitor_only))
    }

    pub fn effective_inputs_for_bus(&self, bus_id: BusId) -> Vec<(String, f32, bool, DspConfig)> {
        let is_monitor_bus = bus_id == BusId::A1;
        self.inputs
            .iter()
            .filter_map(|input| {
                let send = input.sends.iter().find(|send| send.bus_id == bus_id)?;
                // Monitor preview routes the input to the monitor bus (A1) even
                // when its A1 send is disabled. An already-enabled send takes the
                // normal path, so a monitored input is never counted twice.
                let monitor_only = is_monitor_bus && input.monitor && !send.enabled;
                if !send.enabled && !monitor_only {
                    return None;
                }
                // Monitor-only uses unity send (the input fader still applies).
                let send_volume = if send.enabled { send.volume } else { 1.0 };
                // Boost/trim (#feature-boost) multiplies on top of fader * send.
                let effective_gain = input.gain * send_volume * input.boost;
                let gain = if effective_gain.is_finite() {
                    effective_gain.max(0.0)
                } else {
                    1.0
                };
                let muted = input.muted || (send.enabled && send.muted);
                Some((input.device_id.clone(), gain, muted, input.dsp.clone()))
            })
            .collect()
    }

    pub fn to_legacy_routes_a1(
        &self,
        a1_output_device: Option<&str>,
        a1_running: bool,
    ) -> Vec<Route> {
        let Some(output_id) = a1_output_device else {
            return vec![];
        };

        self.inputs
            .iter()
            .filter_map(|input| {
                let send = input.sends.iter().find(|send| send.bus_id == BusId::A1)?;
                if !send.enabled && (send.volume - 1.0).abs() < f32::EPSILON && !send.muted {
                    return None;
                }
                Some(Route {
                    input_id: input.device_id.clone(),
                    output_id: output_id.to_string(),
                    enabled: send.enabled,
                    active: send.enabled && a1_running,
                    volume: send.volume,
                    muted: send.muted,
                })
            })
            .collect()
    }

    fn find_send_mut(&mut self, device_id: &str, bus_id: BusId) -> Option<&mut InputSend> {
        self.inputs
            .iter_mut()
            .find(|input| input.device_id == device_id)?
            .sends
            .iter_mut()
            .find(|send| send.bus_id == bus_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_defaults_include_all_bus_sends() {
        let input = InputChannel::new("mic");
        assert_eq!(input.sends.len(), 4);
        assert!(input.sends.iter().any(|send| send.bus_id == BusId::A1));
        assert!(input.sends.iter().any(|send| send.bus_id == BusId::A2));
        assert!(input.sends.iter().any(|send| send.bus_id == BusId::B1));
        assert!(input.sends.iter().any(|send| send.bus_id == BusId::B2));
        assert!(input.sends.iter().all(|send| !send.enabled));
    }

    #[test]
    fn set_send_gain_clamps_values() {
        let mut graph = AudioGraph::new();
        graph.add_input("mic");
        assert!(graph.set_send_gain("mic", BusId::A1, 9.0, true));
        let send = graph.get_send("mic", BusId::A1).unwrap();
        assert!((send.volume - 2.0).abs() < f32::EPSILON);
        assert!(send.muted);
    }

    #[test]
    fn new_input_has_bypassed_dsp() {
        let input = InputChannel::new("mic");
        assert_eq!(input.dsp, DspConfig::default());
    }

    #[test]
    fn set_input_dsp_clamps_and_stores() {
        let mut graph = AudioGraph::new();
        graph.add_input("mic");
        let mut cfg = DspConfig::default();
        cfg.compressor.enabled = true;
        cfg.compressor.ratio = 99.0; // out of range -> clamps to 20
        assert!(graph.set_input_dsp("mic", cfg));
        let stored = &graph.get_input("mic").unwrap().dsp;
        assert!(stored.compressor.enabled);
        assert_eq!(stored.compressor.ratio, 20.0);
        assert!(!graph.set_input_dsp("missing", DspConfig::default()));
    }

    #[test]
    fn input_channel_deserializes_without_dsp_field() {
        // Graph data saved before #32 has no `dsp` key.
        let json = r#"{"device_id":"mic","gain":1.0,"muted":false,"sends":[]}"#;
        let input: InputChannel = serde_json::from_str(json).unwrap();
        assert_eq!(input.dsp, DspConfig::default());
    }

    #[test]
    fn effective_gain_uses_input_master_and_send_gain() {
        let mut graph = AudioGraph::new();
        graph.add_input("mic");
        graph.set_input_gain("mic", 1.5, false);
        graph.set_send("mic", BusId::A1, true);
        graph.set_send_gain("mic", BusId::A1, 0.5, false);
        let inputs = graph.effective_inputs_for_bus(BusId::A1);
        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].0, "mic");
        assert!((inputs[0].1 - 0.75).abs() < f32::EPSILON);
        assert!(!inputs[0].2);
    }

    #[test]
    fn effective_muted_or_of_input_and_send() {
        let mut graph = AudioGraph::new();
        graph.add_input("mic");
        graph.set_send("mic", BusId::A1, true);
        graph.set_send_gain("mic", BusId::A1, 1.0, true);
        let muted_from_send = graph.effective_inputs_for_bus(BusId::A1);
        assert!(muted_from_send[0].2);

        graph.set_send_gain("mic", BusId::A1, 1.0, false);
        graph.set_input_gain("mic", 1.0, true);
        let muted_from_input = graph.effective_inputs_for_bus(BusId::A1);
        assert!(muted_from_input[0].2);
    }

    #[test]
    fn remove_input_drops_all_bus_sends() {
        let mut graph = AudioGraph::new();
        graph.add_input("mic");
        graph.set_send("mic", BusId::A1, true);
        assert_eq!(graph.effective_inputs_for_bus(BusId::A1).len(), 1);
        assert!(graph.remove_input("mic"));
        assert!(graph.effective_inputs_for_bus(BusId::A1).is_empty());
        assert!(graph.list_inputs().is_empty());
    }

    #[test]
    fn monitor_routes_to_a1_without_enabling_send_and_leaves_routing_untouched() {
        let mut graph = AudioGraph::new();
        graph.add_input("mic");
        // No sends enabled: not in any bus yet.
        assert!(graph.effective_inputs_for_bus(BusId::A1).is_empty());

        // Monitor preview force-routes to A1 at unity, without touching sends.
        assert!(graph.set_monitor("mic", true));
        let a1 = graph.effective_inputs_for_bus(BusId::A1);
        assert_eq!(a1.len(), 1);
        assert_eq!(a1[0].0, "mic");
        assert!((a1[0].1 - 1.0).abs() < f32::EPSILON); // unity
        // Persisted A1 send is still disabled (no routing mutation).
        assert!(!graph.get_send("mic", BusId::A1).unwrap().enabled);
        // Monitor does not leak into other buses.
        assert!(graph.effective_inputs_for_bus(BusId::A2).is_empty());

        graph.set_monitor("mic", false);
        assert!(graph.effective_inputs_for_bus(BusId::A1).is_empty());
    }

    #[test]
    fn monitor_does_not_duplicate_an_enabled_a1_send() {
        let mut graph = AudioGraph::new();
        graph.add_input("mic");
        graph.set_send("mic", BusId::A1, true);
        graph.set_send_gain("mic", BusId::A1, 0.5, false);
        graph.set_monitor("mic", true);
        let a1 = graph.effective_inputs_for_bus(BusId::A1);
        // Exactly one contribution, using the configured send volume (not unity).
        assert_eq!(a1.len(), 1);
        assert!((a1[0].1 - 0.5).abs() < f32::EPSILON);
    }

    #[test]
    fn boost_multiplies_effective_gain_and_clamps() {
        let mut graph = AudioGraph::new();
        graph.add_input("mic");
        graph.set_send("mic", BusId::A1, true); // unity send, unity fader
        // Default boost is unity → effective gain 1.0.
        assert!((graph.effective_inputs_for_bus(BusId::A1)[0].1 - 1.0).abs() < f32::EPSILON);

        // 3x boost → 300% effective gain.
        assert!(graph.set_boost("mic", 3.0));
        assert!((graph.effective_inputs_for_bus(BusId::A1)[0].1 - 3.0).abs() < f32::EPSILON);

        // Clamp: above 5.0 saturates at 5.0 (500%), below 1.0 floors at 1.0.
        graph.set_boost("mic", 9.0);
        assert!((graph.get_input("mic").unwrap().boost - 5.0).abs() < f32::EPSILON);
        graph.set_boost("mic", 0.2);
        assert!((graph.get_input("mic").unwrap().boost - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn replace_input_device_preserves_config() {
        let mut graph = AudioGraph::new();
        graph.add_input("old_mic");
        graph.set_input_gain("old_mic", 0.5, true);
        graph.set_send("old_mic", BusId::B1, true);
        graph.set_monitor("old_mic", true);
        graph.set_label("old_mic", Some("Studio Mic".into()));

        assert!(graph.replace_input_device("old_mic", "new_mic"));

        // Old id gone, new id present, all per-input state carried over.
        assert!(!graph.has_input("old_mic"));
        let input = graph.get_input("new_mic").expect("new id present");
        assert_eq!(input.device_id, "new_mic");
        assert!((input.gain - 0.5).abs() < f32::EPSILON);
        assert!(input.muted);
        assert!(input.monitor);
        assert_eq!(input.label.as_deref(), Some("Studio Mic"));
        assert!(graph.get_send("new_mic", BusId::B1).unwrap().enabled);
    }

    #[test]
    fn replace_input_device_rejects_collision_and_missing() {
        let mut graph = AudioGraph::new();
        graph.add_input("a");
        graph.add_input("b");
        // Target id already exists → reject, leaving both inputs intact.
        assert!(!graph.replace_input_device("a", "b"));
        assert!(graph.has_input("a"));
        assert!(graph.has_input("b"));
        // Unknown source id → reject.
        assert!(!graph.replace_input_device("ghost", "c"));
        assert!(!graph.has_input("c"));
    }

    #[test]
    fn set_label_blank_clears_to_none() {
        let mut graph = AudioGraph::new();
        graph.add_input("mic");
        graph.set_label("mic", Some("Name".into()));
        assert_eq!(graph.get_input("mic").unwrap().label.as_deref(), Some("Name"));
        graph.set_label("mic", Some("   ".into()));
        assert_eq!(graph.get_input("mic").unwrap().label, None);
    }
}
