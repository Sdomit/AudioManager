//! Enumerate the audio sessions playing on the default render endpoint, so the
//! UI can offer a live list of applications to capture (#16), and resolve a
//! stable image name back to a live PID at engine-build time (#21).
//!
//! Each WASAPI render session maps to a process. We resolve PIDs to image names
//! via sysinfo. The picker dedups by image name and hands back a stable
//! `app:<image>` id (PIDs change across reboots; image names do not), so a
//! preset that captured `app:chrome.exe` reconnects to Chrome after a restart.

use serde::Serialize;

use crate::audio::mixer::EngineError;

/// One capturable application, surfaced to the AppPicker.
#[derive(Debug, Clone, Serialize)]
pub struct AudioSessionInfo {
    /// A representative live PID (for display, e.g. "PID 4242").
    pub pid: u32,
    /// Process image name (e.g. `chrome.exe`), or a `PID <n>` fallback.
    pub name: String,
    /// Stable id to pass to `add_input`: `app:<image>` when the name is known,
    /// else `proc:<pid>` for processes whose image name could not be resolved.
    pub source_id: String,
}

/// Distinct (pid, image-name) pairs for processes holding a render session.
/// Shared by the picker (#16) and the by-name PID resolver (#21).
#[cfg(windows)]
fn collect_render_sessions() -> Result<Vec<(u32, String)>, EngineError> {
    use std::collections::BTreeSet;

    use sysinfo::{Pid, ProcessRefreshKind, RefreshKind, System};
    use wasapi::{initialize_mta, DeviceEnumerator, Direction};

    let _ = initialize_mta();

    let enumerator = DeviceEnumerator::new()?;
    let device = enumerator.get_default_device(&Direction::Render)?;
    let manager = device.get_iaudiosessionmanager()?;
    let sessions = manager.get_audiosessionenumerator()?;

    let self_pid = std::process::id();
    let system = System::new_with_specifics(
        RefreshKind::nothing().with_processes(ProcessRefreshKind::everything()),
    );

    let mut out: Vec<(u32, String)> = Vec::new();
    let mut seen: BTreeSet<u32> = BTreeSet::new();
    let count = sessions.get_count()?;
    for i in 0..count {
        let Ok(control) = sessions.get_session(i) else {
            continue;
        };
        let Ok(pid) = control.get_process_id() else {
            continue;
        };
        if pid == 0 || pid == self_pid || !seen.insert(pid) {
            continue;
        }
        let name = system
            .process(Pid::from_u32(pid))
            .map(|p| p.name().to_string_lossy().to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| format!("PID {pid}"));
        out.push((pid, name));
    }
    Ok(out)
}

#[cfg(windows)]
pub fn list_audio_sessions() -> Result<Vec<AudioSessionInfo>, EngineError> {
    use std::collections::BTreeMap;

    use crate::audio::source::{APP_PREFIX, PROC_PREFIX};

    // Dedup by image name so the picker shows one stable entry per app, keeping
    // the lowest PID for display (a heuristic for the tree root). Sessions whose
    // name couldn't be resolved can't be addressed by name, so they keep a
    // transient proc:<pid> id.
    let mut by_name: BTreeMap<String, (u32, String)> = BTreeMap::new();
    let mut unnamed: Vec<(u32, String)> = Vec::new();
    for (pid, name) in collect_render_sessions()? {
        if name.starts_with("PID ") {
            unnamed.push((pid, name));
            continue;
        }
        by_name
            .entry(name.to_lowercase())
            .and_modify(|(p, _)| {
                if pid < *p {
                    *p = pid;
                }
            })
            .or_insert((pid, name));
    }

    let mut out: Vec<AudioSessionInfo> = by_name
        .into_values()
        .map(|(pid, name)| AudioSessionInfo {
            pid,
            source_id: format!("{APP_PREFIX}{name}"),
            name,
        })
        .collect();
    out.extend(unnamed.into_iter().map(|(pid, name)| AudioSessionInfo {
        pid,
        name,
        source_id: format!("{PROC_PREFIX}{pid}"),
    }));
    Ok(out)
}

/// Resolve a stable image name to a live PID that currently owns a render
/// session, choosing the lowest matching PID (the tree root). `Ok(None)` means
/// the app is not currently playing audio.
#[cfg(windows)]
pub fn resolve_pid_for_image(image_name: &str) -> Result<Option<u32>, EngineError> {
    let target = image_name.to_lowercase();
    Ok(collect_render_sessions()?
        .into_iter()
        .filter(|(_, name)| name.to_lowercase() == target)
        .map(|(pid, _)| pid)
        .min())
}

#[cfg(not(windows))]
pub fn list_audio_sessions() -> Result<Vec<AudioSessionInfo>, EngineError> {
    Err(EngineError {
        message: "Audio session enumeration is only supported on Windows.".to_string(),
    })
}

#[cfg(not(windows))]
pub fn resolve_pid_for_image(_image_name: &str) -> Result<Option<u32>, EngineError> {
    Err(EngineError {
        message: "Process loopback is only supported on Windows.".to_string(),
    })
}
