//! Enumerate the audio sessions playing on the default render endpoint, so the
//! UI can offer a live list of applications to capture (#16).
//!
//! Each WASAPI render session maps to a process. We collect the distinct PIDs,
//! resolve each to its image name for display, and hand back a ready-to-use
//! `proc:<pid>` source id. The caller adds it through the normal `add_input`
//! path — `InputSourceSpec::parse` turns `proc:<pid>` into a process-loopback
//! source, so no dedicated add command is needed.

use serde::Serialize;

use crate::audio::mixer::EngineError;

/// One capturable application, surfaced to the AppPicker.
#[derive(Debug, Clone, Serialize)]
pub struct AudioSessionInfo {
    /// Target process id.
    pub pid: u32,
    /// Resolved process image name (e.g. `chrome.exe`), or a `PID <n>` fallback.
    pub name: String,
    /// Synthetic input id to pass straight to `add_input`: `proc:<pid>`.
    pub source_id: String,
}

#[cfg(windows)]
pub fn list_audio_sessions() -> Result<Vec<AudioSessionInfo>, EngineError> {
    use std::collections::BTreeSet;

    use sysinfo::{Pid, ProcessRefreshKind, RefreshKind, System};
    use wasapi::{initialize_mta, DeviceEnumerator, Direction};

    use crate::audio::source::PROC_PREFIX;

    let _ = initialize_mta();

    let enumerator = DeviceEnumerator::new()?;
    let device = enumerator.get_default_device(&Direction::Render)?;
    let manager = device.get_iaudiosessionmanager()?;
    let sessions = manager.get_audiosessionenumerator()?;

    let self_pid = std::process::id();

    // Dedup by PID — one app can hold several sessions. BTreeSet keeps the
    // picker order deterministic (ascending PID).
    let mut pids: BTreeSet<u32> = BTreeSet::new();
    let count = sessions.get_count()?;
    for i in 0..count {
        let Ok(control) = sessions.get_session(i) else {
            continue;
        };
        let Ok(pid) = control.get_process_id() else {
            continue;
        };
        // PID 0 is the system mix; skip it and our own process.
        if pid == 0 || pid == self_pid {
            continue;
        }
        pids.insert(pid);
    }

    let system = System::new_with_specifics(
        RefreshKind::nothing().with_processes(ProcessRefreshKind::everything()),
    );

    let out = pids
        .into_iter()
        .map(|pid| {
            let name = system
                .process(Pid::from_u32(pid))
                .map(|p| p.name().to_string_lossy().to_string())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| format!("PID {pid}"));
            AudioSessionInfo {
                pid,
                name,
                source_id: format!("{PROC_PREFIX}{pid}"),
            }
        })
        .collect();

    Ok(out)
}

#[cfg(not(windows))]
pub fn list_audio_sessions() -> Result<Vec<AudioSessionInfo>, EngineError> {
    Err(EngineError {
        message: "Audio session enumeration is only supported on Windows.".to_string(),
    })
}
