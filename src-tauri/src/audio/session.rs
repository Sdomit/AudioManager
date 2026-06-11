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

/// Resolve a stable image name to the **tree-root** PID of a live instance
/// whose process tree currently owns a render session. `Ok(None)` means the app
/// is not currently playing audio.
///
/// Browsers (and other multi-process apps) play audio from a child
/// renderer/utility process, not the main process. Capturing that child with
/// `include_tree` would miss its siblings — i.e. the other tabs. So we walk up
/// to the top-most ancestor sharing the image name (the main browser process)
/// and return it; capturing *that* with `include_tree` grabs every renderer,
/// covering all tabs.
#[cfg(windows)]
pub fn resolve_pid_for_image(image_name: &str) -> Result<Option<u32>, EngineError> {
    use sysinfo::{Pid, ProcessRefreshKind, RefreshKind, System};

    let matches: Vec<u32> = collect_render_sessions()?
        .into_iter()
        .filter(|(_, name)| name.eq_ignore_ascii_case(image_name))
        .map(|(pid, _)| pid)
        .collect();
    if matches.is_empty() {
        return Ok(None);
    }

    let system = System::new_with_specifics(
        RefreshKind::nothing().with_processes(ProcessRefreshKind::everything()),
    );
    let parent_of = |pid: u32| -> Option<(u32, String)> {
        let ppid = system.process(Pid::from_u32(pid))?.parent()?.as_u32();
        let pname = system
            .process(Pid::from_u32(ppid))?
            .name()
            .to_string_lossy()
            .to_string();
        Some((ppid, pname))
    };

    // Lowest root PID = the oldest / main instance when several are running.
    Ok(matches
        .into_iter()
        .map(|pid| walk_to_root(pid, image_name, &parent_of))
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

/// Walk up the process tree from `start` while each parent shares `image_name`,
/// returning the top-most same-named ancestor (the tree root). `parent_of`
/// yields `(parent_pid, parent_image_name)`, or `None` at the top / for a
/// missing process. Bounded to 64 hops so a malformed or cyclic tree can never
/// spin. Pure and platform-independent so the heuristic is unit-testable.
#[cfg(any(windows, test))]
fn walk_to_root<F>(start: u32, image_name: &str, parent_of: &F) -> u32
where
    F: Fn(u32) -> Option<(u32, String)>,
{
    let mut cur = start;
    for _ in 0..64 {
        match parent_of(cur) {
            Some((ppid, pname)) if pname.eq_ignore_ascii_case(image_name) => cur = ppid,
            _ => break,
        }
    }
    cur
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn walk_to_root_climbs_browser_tree_to_main_process() {
        // chrome.exe(100) -> chrome.exe(200) -> chrome.exe(300); root parent is
        // explorer.exe, so 100 is the top-most same-named ancestor.
        let mut t: HashMap<u32, (u32, String)> = HashMap::new();
        t.insert(100, (10, "explorer.exe".into()));
        t.insert(200, (100, "chrome.exe".into()));
        t.insert(300, (200, "chrome.exe".into()));
        let parent_of = |pid: u32| t.get(&pid).cloned();

        assert_eq!(walk_to_root(300, "chrome.exe", &parent_of), 100);
        assert_eq!(walk_to_root(200, "chrome.exe", &parent_of), 100);
        assert_eq!(walk_to_root(100, "chrome.exe", &parent_of), 100);
    }

    #[test]
    fn walk_to_root_stops_at_foreign_parent() {
        // Single-process app under a different-image parent stays put.
        let parent_of = |pid: u32| match pid {
            500 => Some((10, "explorer.exe".to_string())),
            _ => None,
        };
        assert_eq!(walk_to_root(500, "spotify.exe", &parent_of), 500);
    }

    #[test]
    fn walk_to_root_is_case_insensitive() {
        let parent_of = |pid: u32| match pid {
            2 => Some((1, "Chrome.exe".to_string())),
            _ => None,
        };
        assert_eq!(walk_to_root(2, "chrome.exe", &parent_of), 1);
    }

    #[test]
    fn walk_to_root_guards_against_cycles() {
        // Pathological same-named cycle must terminate within the hop bound.
        let parent_of = |pid: u32| match pid {
            1 => Some((2, "x.exe".to_string())),
            2 => Some((1, "x.exe".to_string())),
            _ => None,
        };
        let r = walk_to_root(1, "x.exe", &parent_of);
        assert!(r == 1 || r == 2);
    }
}
