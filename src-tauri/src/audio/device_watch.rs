//! Hotplug device watcher foundation (Phase 11).
//!
//! Pure snapshot/diff logic for detecting audio endpoint arrival and
//! removal. A background thread in `lib.rs` polls `take_snapshot` every
//! `POLL_INTERVAL`, diffs consecutive snapshots with `diff_snapshots`,
//! and reacts (engine teardown/rebuild + `devices-changed` event emit).
//! Keeping the diff logic here, free of Tauri and engine state, makes it
//! unit-testable.

use std::collections::BTreeSet;
use std::time::Duration;

use serde::Serialize;

use crate::audio::devices;

/// How often the watcher thread re-enumerates devices. WASAPI enumeration
/// is cheap (no streams are opened), so a 2 s cadence keeps hotplug
/// latency low without measurable cost.
pub const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Point-in-time set of device names, split by direction.
///
/// Device names double as ids throughout the app (see `devices.rs`), so a
/// name set is sufficient to detect arrival/removal.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DeviceSnapshot {
    pub inputs: BTreeSet<String>,
    pub outputs: BTreeSet<String>,
}

/// Enumerate current device names. Errors when either enumeration fails —
/// callers must skip that poll cycle entirely rather than treat the failure
/// as a mass device removal.
pub fn take_snapshot() -> Result<DeviceSnapshot, String> {
    let inputs = devices::list_input_devices().map_err(|e| e.message)?;
    let outputs = devices::list_output_devices().map_err(|e| e.message)?;
    Ok(DeviceSnapshot {
        inputs: inputs.into_iter().map(|d| d.id).collect(),
        outputs: outputs.into_iter().map(|d| d.id).collect(),
    })
}

/// Added/removed endpoints between two snapshots. Serialized as the
/// `devices-changed` Tauri event payload (snake_case, matching the rest of
/// the IPC surface).
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
pub struct DeviceDiff {
    pub added_inputs: Vec<String>,
    pub removed_inputs: Vec<String>,
    pub added_outputs: Vec<String>,
    pub removed_outputs: Vec<String>,
}

impl DeviceDiff {
    pub fn is_empty(&self) -> bool {
        self.added_inputs.is_empty()
            && self.removed_inputs.is_empty()
            && self.added_outputs.is_empty()
            && self.removed_outputs.is_empty()
    }
}

/// Set-difference both directions for both device kinds. Output vectors are
/// sorted (BTreeSet iteration order) so payloads are deterministic.
pub fn diff_snapshots(prev: &DeviceSnapshot, next: &DeviceSnapshot) -> DeviceDiff {
    DeviceDiff {
        added_inputs: next.inputs.difference(&prev.inputs).cloned().collect(),
        removed_inputs: prev.inputs.difference(&next.inputs).cloned().collect(),
        added_outputs: next.outputs.difference(&prev.outputs).cloned().collect(),
        removed_outputs: prev.outputs.difference(&next.outputs).cloned().collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(inputs: &[&str], outputs: &[&str]) -> DeviceSnapshot {
        DeviceSnapshot {
            inputs: inputs.iter().map(|s| s.to_string()).collect(),
            outputs: outputs.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn identical_snapshots_diff_empty() {
        let a = snap(&["mic"], &["speakers"]);
        let diff = diff_snapshots(&a, &a.clone());
        assert!(diff.is_empty());
    }

    #[test]
    fn detects_added_and_removed_inputs() {
        let prev = snap(&["mic", "usb-mic"], &[]);
        let next = snap(&["mic", "headset"], &[]);
        let diff = diff_snapshots(&prev, &next);
        assert_eq!(diff.added_inputs, vec!["headset".to_string()]);
        assert_eq!(diff.removed_inputs, vec!["usb-mic".to_string()]);
        assert!(diff.added_outputs.is_empty());
        assert!(diff.removed_outputs.is_empty());
        assert!(!diff.is_empty());
    }

    #[test]
    fn detects_added_and_removed_outputs() {
        let prev = snap(&[], &["speakers", "cable"]);
        let next = snap(&[], &["speakers", "hdmi"]);
        let diff = diff_snapshots(&prev, &next);
        assert_eq!(diff.added_outputs, vec!["hdmi".to_string()]);
        assert_eq!(diff.removed_outputs, vec!["cable".to_string()]);
        assert!(diff.added_inputs.is_empty());
        assert!(diff.removed_inputs.is_empty());
    }

    #[test]
    fn input_and_output_with_same_name_diff_independently() {
        // Virtual cables expose identically-named capture and render
        // endpoints; removing one direction must not hide the other.
        let prev = snap(&["AudioManager Cable 1"], &["AudioManager Cable 1"]);
        let next = snap(&[], &["AudioManager Cable 1"]);
        let diff = diff_snapshots(&prev, &next);
        assert_eq!(diff.removed_inputs, vec!["AudioManager Cable 1".to_string()]);
        assert!(diff.removed_outputs.is_empty());
    }

    #[test]
    fn diff_output_is_sorted() {
        let prev = snap(&[], &[]);
        let next = snap(&["zeta", "alpha"], &[]);
        let diff = diff_snapshots(&prev, &next);
        assert_eq!(
            diff.added_inputs,
            vec!["alpha".to_string(), "zeta".to_string()]
        );
    }

    #[test]
    fn diff_serializes_snake_case_payload() {
        let diff = DeviceDiff {
            added_inputs: vec!["mic".into()],
            removed_inputs: vec![],
            added_outputs: vec![],
            removed_outputs: vec!["cable".into()],
        };
        let json = serde_json::to_value(&diff).unwrap();
        assert_eq!(json["added_inputs"][0], "mic");
        assert_eq!(json["removed_outputs"][0], "cable");
        assert_eq!(json["added_outputs"].as_array().unwrap().len(), 0);
    }
}
