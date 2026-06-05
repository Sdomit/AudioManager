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
}

impl InputChannel {
    pub fn new(device_id: impl Into<String>) -> Self {
        Self {
            device_id: device_id.into(),
            gain: 1.0,
            muted: false,
            sends: BusId::ALL.into_iter().map(InputSend::default_for).collect(),
            dsp: DspConfig::default(),
        }
    }

    pub fn clamp_gain(v: f32) -> f32 {
        if !v.is_finite() {
            1.0
        } else {
            v.clamp(0.0, 2.0)
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
        let effective_gain = input.gain * send.volume;
        let gain = if effective_gain.is_finite() {
            effective_gain.max(0.0)
        } else {
            1.0
        };
        Some((gain, input.muted || send.muted, send.enabled))
    }

    pub fn effective_inputs_for_bus(&self, bus_id: BusId) -> Vec<(String, f32, bool)> {
        self.inputs
            .iter()
            .filter_map(|input| {
                let send = input.sends.iter().find(|send| send.bus_id == bus_id)?;
                if !send.enabled {
                    return None;
                }
                let effective_gain = input.gain * send.volume;
                let gain = if effective_gain.is_finite() {
                    effective_gain.max(0.0)
                } else {
                    1.0
                };
                let muted = input.muted || send.muted;
                Some((input.device_id.clone(), gain, muted))
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
}
