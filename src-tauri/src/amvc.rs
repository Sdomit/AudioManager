//! Thin client for the `amvc-helper` user-mode binary.
//!
//! AudioManager shells out to `amvc-helper status --json` to learn whether
//! the virtual cable driver is installed. It never touches the driver directly.
//! If the helper binary is absent the result is `AmvcQueryResult::Unavailable`
//! — callers must treat that as a soft "no driver" state, not an error.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

/// Max time to wait for `amvc-helper status` before killing it and reporting
/// the helper as unavailable. Bounds the worst case so a hung helper can never
/// wedge the query path.
const HELPER_STATUS_TIMEOUT: Duration = Duration::from_secs(10);

/// Outcome returned to the frontend by `query_amvc_helper`.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AmvcQueryResult {
    /// Helper ran and produced valid JSON. `status` may still be "not-installed".
    Ok {
        status: String,
        found: u32,
        expected: u32,
        driver_in_store: bool,
        reboot_pending: bool,
        names_aligned: bool,
        detected: Vec<String>,
        missing: Vec<String>,
    },
    /// Helper binary absent, non-zero exit, or output could not be parsed.
    Unavailable { reason: String },
}

/// Internal JSON shape emitted by `amvc-helper status --json`.
///
/// `status` is the only required field — if it's missing, the helper output is
/// malformed and the caller surfaces `Unavailable`. Every other field defaults
/// to a safe value (0 for counts, false for flags, [] for lists) so a helper
/// that omits a field still yields a usable `Ok` result. This matches the
/// lenient TypeScript parser in `src/utils/amvc.ts`.
fn default_expected() -> u32 { 6 }

#[derive(serde::Deserialize)]
struct HelperOutput {
    status: String,
    #[serde(default)]
    found: u32,
    #[serde(default = "default_expected")]
    expected: u32,
    #[serde(default)]
    driver_in_store: bool,
    #[serde(default)]
    reboot_pending: bool,
    #[serde(default)]
    names_aligned: bool,
    #[serde(default)]
    detected: Vec<String>,
    #[serde(default)]
    missing: Vec<String>,
}

/// Run `amvc-helper status --json` with a hard timeout, returning its stdout
/// bytes on success. On spawn failure, non-zero exit, or timeout, returns the
/// `Unavailable` variant to surface directly. Blocking — call off the main
/// thread (see `query_amvc_helper`).
fn capture_helper_status(timeout: Duration) -> Result<Vec<u8>, AmvcQueryResult> {
    let mut child = Command::new("amvc-helper")
        .args(["status", "--json"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| AmvcQueryResult::Unavailable {
            reason: format!("helper not found or could not be launched: {e}"),
        })?;

    // Drain stdout on a separate thread so a large write can't deadlock the
    // child against a full pipe buffer while we poll for exit.
    let mut stdout = child.stdout.take().expect("stdout was piped");
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });

    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(AmvcQueryResult::Unavailable {
                        reason: format!("helper timed out after {}s", timeout.as_secs()),
                    });
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                return Err(AmvcQueryResult::Unavailable {
                    reason: format!("failed waiting on helper: {e}"),
                });
            }
        }
    };

    if !status.success() {
        return Err(AmvcQueryResult::Unavailable {
            reason: format!("helper exited with status {status}"),
        });
    }

    Ok(reader.join().unwrap_or_default())
}

pub fn run_helper_status() -> AmvcQueryResult {
    let stdout_bytes = match capture_helper_status(HELPER_STATUS_TIMEOUT) {
        Ok(bytes) => bytes,
        Err(unavailable) => return unavailable,
    };

    let stdout = match std::str::from_utf8(&stdout_bytes) {
        Ok(s) => s,
        Err(e) => {
            return AmvcQueryResult::Unavailable {
                reason: format!("helper output is not valid UTF-8: {e}"),
            };
        }
    };

    match serde_json::from_str::<HelperOutput>(stdout) {
        Ok(h) => AmvcQueryResult::Ok {
            status: h.status,
            found: h.found,
            expected: h.expected,
            driver_in_store: h.driver_in_store,
            reboot_pending: h.reboot_pending,
            names_aligned: h.names_aligned,
            detected: h.detected,
            missing: h.missing,
        },
        Err(e) => AmvcQueryResult::Unavailable {
            reason: format!("failed to parse helper JSON: {e}"),
        },
    }
}

/// Spawn `amvc-helper install` in the background. Returns immediately.
/// If the binary is absent, returns an error string (not a Tauri error) so
/// the frontend can show an appropriate message without crashing.
pub fn spawn_helper_install() -> Result<(), String> {
    Command::new("amvc-helper")
        .arg("install")
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to launch amvc-helper: {e}"))
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Async so Tauri runs it off the main thread; the blocking subprocess work is
/// pushed to the dedicated blocking pool via `spawn_blocking`. Without this the
/// synchronous `Command` call would run on the main thread and freeze the UI
/// until the helper returned.
#[tauri::command]
pub async fn query_amvc_helper() -> AmvcQueryResult {
    tauri::async_runtime::spawn_blocking(run_helper_status)
        .await
        .unwrap_or_else(|e| AmvcQueryResult::Unavailable {
            reason: format!("helper task failed to run: {e}"),
        })
}

#[tauri::command]
pub async fn launch_amvc_installer() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(spawn_helper_install)
        .await
        .map_err(|e| format!("installer task failed to run: {e}"))?
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(stdout: &str) -> AmvcQueryResult {
        match serde_json::from_str::<HelperOutput>(stdout) {
            Ok(h) => AmvcQueryResult::Ok {
                status: h.status,
                found: h.found,
                expected: h.expected,
                driver_in_store: h.driver_in_store,
                reboot_pending: h.reboot_pending,
                names_aligned: h.names_aligned,
                detected: h.detected,
                missing: h.missing,
            },
            Err(e) => AmvcQueryResult::Unavailable {
                reason: format!("failed to parse helper JSON: {e}"),
            },
        }
    }

    #[test]
    fn parses_healthy_output() {
        let json = r#"{
            "status": "installed-healthy",
            "found": 6,
            "expected": 6,
            "driver_in_store": true,
            "reboot_pending": false,
            "detected": [
                "AudioManager Cable 1 Playback",
                "AudioManager Cable 1 Recording",
                "AudioManager Cable 2 Playback",
                "AudioManager Cable 2 Recording",
                "AudioManager Stream Output",
                "AudioManager Voice Output"
            ],
            "missing": []
        }"#;
        match parse(json) {
            AmvcQueryResult::Ok { status, found, expected, detected, missing, .. } => {
                assert_eq!(status, "installed-healthy");
                assert_eq!(found, 6);
                assert_eq!(expected, 6);
                assert_eq!(detected.len(), 6);
                assert!(missing.is_empty());
            }
            AmvcQueryResult::Unavailable { reason } => panic!("expected Ok, got Unavailable: {reason}"),
        }
    }

    #[test]
    fn parses_not_installed() {
        let json = r#"{
            "status": "not-installed",
            "found": 0,
            "expected": 6,
            "driver_in_store": false,
            "reboot_pending": false,
            "detected": [],
            "missing": [
                "AudioManager Cable 1 Playback",
                "AudioManager Cable 1 Recording",
                "AudioManager Cable 2 Playback",
                "AudioManager Cable 2 Recording",
                "AudioManager Stream Output",
                "AudioManager Voice Output"
            ]
        }"#;
        match parse(json) {
            AmvcQueryResult::Ok { status, found, missing, .. } => {
                assert_eq!(status, "not-installed");
                assert_eq!(found, 0);
                assert_eq!(missing.len(), 6);
            }
            AmvcQueryResult::Unavailable { reason } => panic!("expected Ok: {reason}"),
        }
    }

    #[test]
    fn unavailable_on_invalid_json() {
        match parse("not json") {
            AmvcQueryResult::Unavailable { .. } => {}
            _ => panic!("expected Unavailable"),
        }
    }

    #[test]
    fn unavailable_on_missing_fields() {
        match parse(r#"{"found": 0}"#) {
            AmvcQueryResult::Unavailable { .. } => {}
            _ => panic!("expected Unavailable for missing required fields"),
        }
    }

    #[test]
    fn tolerates_missing_optional_fields_when_status_present() {
        // Only `status` is required. Everything else falls back to safe defaults
        // (matches the lenient TypeScript parser).
        match parse(r#"{"status": "not-installed"}"#) {
            AmvcQueryResult::Ok { status, found, expected, driver_in_store, reboot_pending, names_aligned, detected, missing } => {
                assert_eq!(status, "not-installed");
                assert_eq!(found, 0);
                assert_eq!(expected, 6);
                assert!(!driver_in_store);
                assert!(!reboot_pending);
                assert!(!names_aligned);
                assert!(detected.is_empty());
                assert!(missing.is_empty());
            }
            AmvcQueryResult::Unavailable { reason } => {
                panic!("expected Ok with defaults, got Unavailable: {reason}")
            }
        }
    }
}
