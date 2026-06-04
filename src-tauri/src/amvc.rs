use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Serialize, Deserialize)]
pub struct AmvcStatus {
    pub status: String,
    pub found: usize,
    pub expected: usize,
    pub driver_in_store: bool,
    pub reboot_pending: bool,
    pub names_aligned: bool,
    pub detected: Vec<String>,
    pub missing: Vec<String>,
}

fn helper_path() -> String {
    if let Ok(mut path) = std::env::current_exe() {
        path.set_file_name("amvc-helper.exe");
        if path.exists() {
            return path.to_string_lossy().into_owned();
        }
    }
    "amvc-helper".to_string()
}

fn run_helper(args: &[&str]) -> Result<String, String> {
    let helper = helper_path();
    let out = Command::new(&helper)
        .args(args)
        .output()
        .map_err(|e| format!("amvc-helper not found: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    if !out.status.success() {
        return Err(if stderr.trim().is_empty() { stdout } else { stderr });
    }
    Ok(stdout)
}

#[tauri::command]
pub fn amvc_status() -> Result<AmvcStatus, String> {
    let helper = helper_path();
    let out = Command::new(&helper)
        .args(["status", "--json"])
        .output()
        .map_err(|e| format!("amvc-helper not found: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("amvc-helper status failed: {stderr}"));
    }
    serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("parse failed: {e}"))
}

#[tauri::command]
pub fn amvc_install(inf_path: String) -> Result<String, String> {
    run_helper(&["install", &inf_path, "--execute"])
}

#[tauri::command]
pub fn amvc_repair(inf_path: String) -> Result<String, String> {
    run_helper(&["repair", &inf_path, "--execute"])
}

#[tauri::command]
pub fn amvc_uninstall() -> Result<String, String> {
    run_helper(&["uninstall", "--execute"])
}

#[tauri::command]
pub fn amvc_rename_endpoints() -> Result<String, String> {
    run_helper(&["rename-endpoints"])
}
