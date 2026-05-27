use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::audio::devices::{list_input_devices, list_output_devices, DeviceInfo};
use crate::audio::mixer::EngineError;
use crate::audio::routing::Route;

const SCHEMA_VERSION_V1: u32 = 1;
const MAX_PRESET_NAME_LEN: usize = 80;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresetDeviceRef {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresetRouteV1 {
    pub input: PresetDeviceRef,
    pub output: PresetDeviceRef,
    pub enabled: bool,
    pub volume: f32,
    pub muted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresetFileV1 {
    pub schema_version: u32,
    pub name: String,
    pub saved_at_utc: String,
    pub routes: Vec<PresetRouteV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresetSummary {
    pub name: String,
    pub saved_at_utc: String,
    pub route_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresetLoadWarning {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresetLoadResult {
    pub preset: PresetSummary,
    pub routes: Vec<Route>,
    pub warnings: Vec<PresetLoadWarning>,
}

pub fn normalize_preset_name(name: &str) -> Result<String, EngineError> {
    let normalized = name.trim();
    if normalized.is_empty() {
        return Err(EngineError { message: "Preset name cannot be empty".to_string() });
    }
    if normalized.chars().count() > MAX_PRESET_NAME_LEN {
        return Err(EngineError {
            message: format!(
                "Preset name is too long (max {MAX_PRESET_NAME_LEN} characters)"
            ),
        });
    }
    Ok(normalized.to_string())
}

pub fn preset_dir(app: &AppHandle) -> Result<PathBuf, EngineError> {
    let base = app.path().app_local_data_dir().map_err(|e| EngineError {
        message: format!("Failed to resolve app local data directory: {e}"),
    })?;
    Ok(base.join("presets"))
}

pub fn preset_file_path(app: &AppHandle, name: &str) -> Result<PathBuf, EngineError> {
    let normalized = normalize_preset_name(name)?;
    let safe_name = safe_file_stem(&normalized);
    if safe_name.is_empty() {
        return Err(EngineError {
            message: "Preset name is not valid for file storage".to_string(),
        });
    }
    Ok(preset_dir(app)?.join(format!("{safe_name}.json")))
}

pub fn write_preset_file(path: &Path, preset: &PresetFileV1) -> Result<(), EngineError> {
    let mut validated = preset.clone();
    validate_preset(&mut validated)?;

    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| EngineError {
            message: format!("Failed to create preset directory '{}': {e}", dir.display()),
        })?;
    }

    let tmp_path = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(&validated).map_err(|e| EngineError {
        message: format!("Failed to serialize preset JSON: {e}"),
    })?;

    fs::write(&tmp_path, &bytes).map_err(|e| EngineError {
        message: format!("Failed to write temporary preset file '{}': {e}", tmp_path.display()),
    })?;

    if path.exists() {
        fs::remove_file(path).map_err(|e| EngineError {
            message: format!("Failed to replace preset '{}': {e}", path.display()),
        })?;
    }

    if let Err(e) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(EngineError {
            message: format!(
                "Failed to finalize preset file from '{}' to '{}': {e}",
                tmp_path.display(),
                path.display()
            ),
        });
    }

    Ok(())
}

pub fn read_preset_file(path: &Path) -> Result<PresetFileV1, EngineError> {
    let raw = fs::read_to_string(path).map_err(|e| EngineError {
        message: format!("Failed to read preset file '{}': {e}", path.display()),
    })?;

    let mut preset: PresetFileV1 = serde_json::from_str(&raw).map_err(|e| EngineError {
        message: format!("Invalid preset JSON in '{}': {e}", path.display()),
    })?;

    validate_preset(&mut preset)?;
    Ok(preset)
}

pub fn validate_preset(preset: &mut PresetFileV1) -> Result<(), EngineError> {
    if preset.schema_version != SCHEMA_VERSION_V1 {
        return Err(EngineError {
            message: format!(
                "Unsupported preset schema_version {} (expected {SCHEMA_VERSION_V1})",
                preset.schema_version
            ),
        });
    }

    preset.name = normalize_preset_name(&preset.name)?;

    let mut seen = HashSet::<(String, String)>::new();
    for route in &mut preset.routes {
        route.input.id = route.input.id.trim().to_string();
        route.output.id = route.output.id.trim().to_string();

        if route.input.id.is_empty() {
            return Err(EngineError {
                message: "Preset route has empty input.id".to_string(),
            });
        }
        if route.output.id.is_empty() {
            return Err(EngineError {
                message: "Preset route has empty output.id".to_string(),
            });
        }

        route.input.name = route.input.name.trim().to_string();
        route.output.name = route.output.name.trim().to_string();
        if route.input.name.is_empty() {
            route.input.name = route.input.id.clone();
        }
        if route.output.name.is_empty() {
            route.output.name = route.output.id.clone();
        }

        if !route.volume.is_finite() {
            return Err(EngineError {
                message: format!(
                    "Preset route '{}' → '{}' has non-finite volume",
                    route.input.id, route.output.id
                ),
            });
        }
        route.volume = route.volume.clamp(0.0, 2.0);

        let key = (route.input.id.clone(), route.output.id.clone());
        if !seen.insert(key.clone()) {
            return Err(EngineError {
                message: format!(
                    "Preset contains duplicate route '{} → {}'",
                    key.0, key.1
                ),
            });
        }
    }

    Ok(())
}

pub fn preset_summary(preset: &PresetFileV1) -> PresetSummary {
    PresetSummary {
        name: preset.name.clone(),
        saved_at_utc: preset.saved_at_utc.clone(),
        route_count: preset.routes.len(),
    }
}

pub fn list_preset_summaries(app: &AppHandle) -> Result<Vec<PresetSummary>, EngineError> {
    let dir = preset_dir(app)?;
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut summaries = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| EngineError {
        message: format!("Failed to read preset directory '{}': {e}", dir.display()),
    })?;

    for entry in entries {
        let entry = entry.map_err(|e| EngineError {
            message: format!("Failed to read preset entry: {e}"),
        })?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }

        if let Ok(preset) = read_preset_file(&path) {
            summaries.push(preset_summary(&preset));
        }
    }

    summaries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(summaries)
}

pub fn build_preset_from_routes(name: &str, routes: &[Route]) -> Result<PresetFileV1, EngineError> {
    let normalized_name = normalize_preset_name(name)?;
    let input_names = list_input_devices().ok().map(index_by_id).unwrap_or_default();
    let output_names = list_output_devices().ok().map(index_by_id).unwrap_or_default();

    let mut preset = PresetFileV1 {
        schema_version: SCHEMA_VERSION_V1,
        name: normalized_name,
        saved_at_utc: now_utc_string(),
        routes: routes
            .iter()
            .map(|route| PresetRouteV1 {
                input: PresetDeviceRef {
                    id: route.input_id.clone(),
                    name: input_names
                        .get(&route.input_id)
                        .cloned()
                        .unwrap_or_else(|| route.input_id.clone()),
                },
                output: PresetDeviceRef {
                    id: route.output_id.clone(),
                    name: output_names
                        .get(&route.output_id)
                        .cloned()
                        .unwrap_or_else(|| route.output_id.clone()),
                },
                enabled: route.enabled,
                volume: route.volume,
                muted: route.muted,
            })
            .collect(),
    };

    validate_preset(&mut preset)?;
    Ok(preset)
}

pub fn delete_preset_file(app: &AppHandle, name: &str) -> Result<(), EngineError> {
    let path = preset_file_path(app, name)?;
    if !path.exists() {
        return Err(EngineError {
            message: format!("Preset '{}' does not exist", name.trim()),
        });
    }

    fs::remove_file(&path).map_err(|e| EngineError {
        message: format!("Failed to delete preset '{}': {e}", path.display()),
    })
}

pub fn load_preset_with_warnings(
    app: &AppHandle,
    name: &str,
) -> Result<(PresetFileV1, Vec<PresetRouteV1>, Vec<PresetLoadWarning>), EngineError> {
    let path = preset_file_path(app, name)?;
    let preset = read_preset_file(&path)?;

    let inputs = list_input_devices().map_err(|e| EngineError {
        message: format!("Failed to list current input devices: {}", e.message),
    })?;
    let outputs = list_output_devices().map_err(|e| EngineError {
        message: format!("Failed to list current output devices: {}", e.message),
    })?;

    let input_map = index_device_info(&inputs);
    let output_map = index_device_info(&outputs);

    let mut warnings = Vec::<PresetLoadWarning>::new();
    let mut valid_routes = Vec::<PresetRouteV1>::new();

    for route in &preset.routes {
        let input = input_map.get(&route.input.id);
        let output = output_map.get(&route.output.id);

        if input.is_none() || output.is_none() {
            warnings.push(PresetLoadWarning {
                code: "missing_device".to_string(),
                message: format!(
                    "Skipped route '{}' → '{}': missing {}{}",
                    route.input.name,
                    route.output.name,
                    if input.is_none() { "input" } else { "" },
                    if input.is_none() && output.is_none() {
                        " and output"
                    } else if output.is_none() {
                        "output"
                    } else {
                        ""
                    }
                ),
            });
            continue;
        }

        let input = input.expect("checked above");
        let output = output.expect("checked above");

        if input.default_sample_rate != output.default_sample_rate {
            warnings.push(PresetLoadWarning {
                code: "sample_rate_mismatch".to_string(),
                message: format!(
                    "Route '{}' → '{}' may fail when enabled: sample rate mismatch {} Hz vs {} Hz",
                    route.input.name,
                    route.output.name,
                    input.default_sample_rate,
                    output.default_sample_rate
                ),
            });
        }

        valid_routes.push(route.clone());
    }

    Ok((preset, valid_routes, warnings))
}

fn safe_file_stem(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut last_dash = false;

    for ch in name.chars() {
        let mapped = if ch.is_ascii_alphanumeric() || ch == '_' {
            ch.to_ascii_lowercase()
        } else if ch == '-' || ch.is_whitespace() {
            '-'
        } else {
            '-'
        };

        if mapped == '-' {
            if last_dash {
                continue;
            }
            last_dash = true;
            out.push(mapped);
        } else {
            last_dash = false;
            out.push(mapped);
        }
    }

    let mut out = out.trim_matches(|c: char| c == '-' || c == '.').to_string();
    if out.is_empty() {
        return out;
    }

    let reserved = [
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6",
        "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7",
        "lpt8", "lpt9",
    ];

    if reserved.contains(&out.as_str()) {
        out.push_str("-preset");
    }

    out
}

fn now_utc_string() -> String {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(dur) => format!("{}", dur.as_secs()),
        Err(_) => "0".to_string(),
    }
}

fn index_by_id(devices: Vec<DeviceInfo>) -> HashMap<String, String> {
    devices.into_iter().map(|d| (d.id, d.name)).collect()
}

fn index_device_info(devices: &[DeviceInfo]) -> HashMap<String, DeviceInfo> {
    devices.iter().map(|d| (d.id.clone(), d.clone())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_preset_name_rejects_empty() {
        assert!(normalize_preset_name("   ").is_err());
    }

    #[test]
    fn normalize_preset_name_trims_whitespace() {
        assert_eq!(normalize_preset_name("  Podcast Setup  ").unwrap(), "Podcast Setup");
    }

    #[test]
    fn safe_file_stem_cleans_unsafe_chars() {
        assert_eq!(safe_file_stem("My/Unsafe:Preset?"), "my-unsafe-preset");
    }

    #[test]
    fn validate_rejects_duplicate_route_pair() {
        let mut preset = PresetFileV1 {
            schema_version: SCHEMA_VERSION_V1,
            name: "dup".to_string(),
            saved_at_utc: "0".to_string(),
            routes: vec![
                PresetRouteV1 {
                    input: PresetDeviceRef { id: "mic".to_string(), name: "mic".to_string() },
                    output: PresetDeviceRef {
                        id: "spk".to_string(),
                        name: "spk".to_string(),
                    },
                    enabled: true,
                    volume: 1.0,
                    muted: false,
                },
                PresetRouteV1 {
                    input: PresetDeviceRef { id: "mic".to_string(), name: "mic".to_string() },
                    output: PresetDeviceRef {
                        id: "spk".to_string(),
                        name: "spk".to_string(),
                    },
                    enabled: false,
                    volume: 0.4,
                    muted: true,
                },
            ],
        };

        assert!(validate_preset(&mut preset).is_err());
    }

    #[test]
    fn validate_clamps_volume() {
        let mut preset = PresetFileV1 {
            schema_version: SCHEMA_VERSION_V1,
            name: "vol".to_string(),
            saved_at_utc: "0".to_string(),
            routes: vec![PresetRouteV1 {
                input: PresetDeviceRef { id: "mic".to_string(), name: "mic".to_string() },
                output: PresetDeviceRef { id: "spk".to_string(), name: "spk".to_string() },
                enabled: true,
                volume: 9.0,
                muted: false,
            }],
        };

        validate_preset(&mut preset).unwrap();
        assert!((preset.routes[0].volume - 2.0).abs() < f32::EPSILON);
    }
}
