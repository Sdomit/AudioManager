//! Thin client for the `amvc-helper` user-mode binary.
//!
//! AudioManager shells out to `amvc-helper status --json` to learn whether
//! the virtual cable driver is installed. It never touches the driver directly.
//! If the helper binary is absent the result is `AmvcQueryResult::Unavailable`
//! — callers must treat that as a soft "no driver" state, not an error.

use std::process::Command;

use serde::Serialize;

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
        detected: Vec<String>,
        missing: Vec<String>,
    },
    /// Helper binary absent, non-zero exit, or output could not be parsed.
    Unavailable { reason: String },
}

/// Internal JSON shape emitted by `amvc-helper status --json`.
#[derive(serde::Deserialize)]
struct HelperOutput {
    status: String,
    found: u32,
    expected: u32,
    driver_in_store: bool,
    reboot_pending: bool,
    detected: Vec<String>,
    missing: Vec<String>,
}

pub fn run_helper_status() -> AmvcQueryResult {
    let output = match Command::new("amvc-helper").args(["status", "--json"]).output() {
        Ok(o) => o,
        Err(e) => {
            return AmvcQueryResult::Unavailable {
                reason: format!("helper not found or could not be launched: {e}"),
            };
        }
    };

    if !output.status.success() {
        return AmvcQueryResult::Unavailable {
            reason: format!("helper exited with status {}", output.status),
        };
    }

    let stdout = match std::str::from_utf8(&output.stdout) {
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

#[tauri::command]
pub fn query_amvc_helper() -> AmvcQueryResult {
    run_helper_status()
}

#[tauri::command]
pub fn launch_amvc_installer() -> Result<(), String> {
    spawn_helper_install()
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
}
