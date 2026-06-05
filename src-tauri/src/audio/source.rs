//! Input source descriptor — the typed reading of an `InputChannel.device_id`.
//!
//! The universal key threaded through graph routing, sends, gain, meters,
//! recorder taps, IPC, and UI is the opaque `device_id: String`. This module
//! gives that string a typed form so the mixer can branch on the capture
//! backend once, at engine-build time, without re-parsing strings on the
//! realtime path.
//!
//! Synthetic id scheme:
//!   * `sys:default`  → whole default render endpoint (system loopback)
//!   * `proc:<pid>`   → one application by PID (process loopback, tree-inclusive)
//!   * anything else  → a cpal input device, keyed by its reported name
//!
//! `proc:<pid>` always captures the process *tree* (a browser plays audio from
//! a child render process, a game from its main process — the tree covers
//! both). The single-process case is not expressible in the id and is not an
//! MVP goal, so `parse` always yields `include_tree: true`.

/// Reserved id prefix for process-loopback sources.
pub const PROC_PREFIX: &str = "proc:";

/// Reserved id namespace for system-loopback sources.
pub const SYS_PREFIX: &str = "sys:";

/// The one system-loopback id: the default render endpoint.
pub const SYS_LOOPBACK_ID: &str = "sys:default";

/// Typed reading of an input `device_id`. Round-trips with [`InputSourceSpec::to_id`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputSourceSpec {
    /// A cpal input device, keyed by its reported name.
    Device { name: String },
    /// WASAPI process loopback for one application (and its child processes).
    Process { pid: u32, include_tree: bool },
    /// WASAPI loopback of the whole default render endpoint.
    SystemLoopback,
}

impl InputSourceSpec {
    /// Classify a `device_id` into its capture backend.
    ///
    /// Total and infallible: any string that is not a recognized synthetic id
    /// is treated as a device name. Reserved-prefix collisions are refused at
    /// registration (see `is_reserved_id`), not here, so this stays pure.
    pub fn parse(id: &str) -> Self {
        if id == SYS_LOOPBACK_ID {
            return InputSourceSpec::SystemLoopback;
        }
        if let Some(rest) = id.strip_prefix(PROC_PREFIX) {
            if let Ok(pid) = rest.parse::<u32>() {
                return InputSourceSpec::Process { pid, include_tree: true };
            }
        }
        InputSourceSpec::Device { name: id.to_string() }
    }

    /// Render this spec back to its canonical `device_id`.
    pub fn to_id(&self) -> String {
        match self {
            InputSourceSpec::Device { name } => name.clone(),
            InputSourceSpec::Process { pid, .. } => format!("{PROC_PREFIX}{pid}"),
            InputSourceSpec::SystemLoopback => SYS_LOOPBACK_ID.to_string(),
        }
    }

}

/// True when `id` uses a reserved synthetic namespace and therefore must not be
/// registered as a plain cpal device name. A real device whose name collides
/// with a reserved prefix is refused at registration — the accepted tradeoff
/// for a string-keyed source scheme (risk register: "very low").
pub fn is_reserved_id(id: &str) -> bool {
    id.starts_with(PROC_PREFIX) || id.starts_with(SYS_PREFIX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_classifies_system_loopback() {
        assert_eq!(InputSourceSpec::parse("sys:default"), InputSourceSpec::SystemLoopback);
    }

    #[test]
    fn parse_classifies_process() {
        assert_eq!(
            InputSourceSpec::parse("proc:1234"),
            InputSourceSpec::Process { pid: 1234, include_tree: true }
        );
    }

    #[test]
    fn parse_falls_back_to_device() {
        assert_eq!(
            InputSourceSpec::parse("Microphone (Realtek)"),
            InputSourceSpec::Device { name: "Microphone (Realtek)".to_string() }
        );
    }

    #[test]
    fn parse_non_numeric_proc_is_device_not_process() {
        // A device literally named "proc:foo" is refused at registration by
        // is_reserved_id, but parse must stay total: non-numeric → Device.
        assert_eq!(
            InputSourceSpec::parse("proc:foo"),
            InputSourceSpec::Device { name: "proc:foo".to_string() }
        );
    }

    #[test]
    fn parse_unknown_sys_id_is_device() {
        // Only the exact `sys:default` is system loopback; other sys: ids fall
        // through to Device (and are refused at registration).
        assert_eq!(
            InputSourceSpec::parse("sys:something"),
            InputSourceSpec::Device { name: "sys:something".to_string() }
        );
    }

    #[test]
    fn round_trip_device() {
        let spec = InputSourceSpec::Device { name: "Line In".to_string() };
        assert_eq!(InputSourceSpec::parse(&spec.to_id()), spec);
    }

    #[test]
    fn round_trip_system_loopback() {
        let spec = InputSourceSpec::SystemLoopback;
        assert_eq!(InputSourceSpec::parse(&spec.to_id()), spec);
    }

    #[test]
    fn round_trip_process_tree() {
        let spec = InputSourceSpec::Process { pid: 9001, include_tree: true };
        assert_eq!(spec.to_id(), "proc:9001");
        assert_eq!(InputSourceSpec::parse(&spec.to_id()), spec);
    }

    #[test]
    fn reserved_ids_cover_both_namespaces() {
        assert!(is_reserved_id("proc:1"));
        assert!(is_reserved_id("sys:default"));
        assert!(is_reserved_id("sys:anything"));
        assert!(!is_reserved_id("Microphone"));
        assert!(!is_reserved_id("CABLE Output (VB-Audio Virtual Cable)"));
    }
}
