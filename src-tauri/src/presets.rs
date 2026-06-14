use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::audio::bus::{BusConfig, BusId, BusRuntime};
use crate::audio::devices::{list_input_devices, list_output_devices, DeviceInfo};
use crate::audio::graph::{AudioGraph, InputChannel, InputSend};
use crate::audio::mixer::EngineError;
use crate::audio::routing::Route;

const SCHEMA_VERSION_V1: u32 = 1;
const SCHEMA_VERSION_V2: u32 = 2;
const MAX_PRESET_NAME_LEN: usize = 80;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PresetDeviceRef {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PresetRouteV1 {
    pub input: PresetDeviceRef,
    pub output: PresetDeviceRef,
    pub enabled: bool,
    pub volume: f32,
    pub muted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PresetFileV1 {
    pub schema_version: u32,
    pub name: String,
    pub saved_at_utc: String,
    pub routes: Vec<PresetRouteV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PresetSendV2 {
    pub bus_id: BusId,
    pub enabled: bool,
    pub volume: f32,
    pub muted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PresetInputV2 {
    pub device: PresetDeviceRef,
    pub gain: f32,
    pub muted: bool,
    pub sends: Vec<PresetSendV2>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PresetBusV2 {
    pub id: BusId,
    pub name: String,
    pub output: Option<PresetDeviceRef>,
    pub volume: f32,
    pub muted: bool,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PresetFileV2 {
    pub schema_version: u32,
    pub name: String,
    pub saved_at_utc: String,
    pub buses: Vec<PresetBusV2>,
    pub inputs: Vec<PresetInputV2>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PresetFile {
    V1(PresetFileV1),
    V2(PresetFileV2),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresetSummary {
    pub name: String,
    pub saved_at_utc: String,
    pub route_count: usize,
    pub schema_version: u32,
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

pub struct PresetLoadData {
    pub summary: PresetSummary,
    pub preset_v2: PresetFileV2,
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

pub fn write_preset_file(path: &Path, preset: &PresetFileV2) -> Result<(), EngineError> {
    let mut validated = preset.clone();
    validate_preset_v2(&mut validated)?;

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

pub fn read_preset_file(path: &Path) -> Result<PresetFile, EngineError> {
    let raw = fs::read_to_string(path).map_err(|e| EngineError {
        message: format!("Failed to read preset file '{}': {e}", path.display()),
    })?;
    parse_preset_json(&raw, path)
}

pub fn validate_preset_v1(preset: &mut PresetFileV1) -> Result<(), EngineError> {
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
                    "Preset route '{}' -> '{}' has non-finite volume",
                    route.input.id, route.output.id
                ),
            });
        }
        route.volume = route.volume.clamp(0.0, 2.0);

        let key = (route.input.id.clone(), route.output.id.clone());
        if !seen.insert(key.clone()) {
            return Err(EngineError {
                message: format!("Preset contains duplicate route '{} -> {}'", key.0, key.1),
            });
        }
    }

    Ok(())
}

pub fn validate_preset_v2(preset: &mut PresetFileV2) -> Result<(), EngineError> {
    if preset.schema_version != SCHEMA_VERSION_V2 {
        return Err(EngineError {
            message: format!(
                "Unsupported preset schema_version {} (expected {SCHEMA_VERSION_V2})",
                preset.schema_version
            ),
        });
    }

    preset.name = normalize_preset_name(&preset.name)?;
    normalize_buses(&mut preset.buses)?;
    normalize_inputs(&mut preset.inputs)?;
    Ok(())
}

pub fn preset_summary(preset: &PresetFile) -> PresetSummary {
    match preset {
        PresetFile::V1(v1) => PresetSummary {
            name: v1.name.clone(),
            saved_at_utc: v1.saved_at_utc.clone(),
            route_count: v1.routes.len(),
            schema_version: SCHEMA_VERSION_V1,
        },
        PresetFile::V2(v2) => PresetSummary {
            name: v2.name.clone(),
            saved_at_utc: v2.saved_at_utc.clone(),
            route_count: v2
                .inputs
                .iter()
                .map(|input| input.sends.iter().filter(|send| send.enabled).count())
                .sum(),
            schema_version: SCHEMA_VERSION_V2,
        },
    }
}

pub fn preset_summary_v2(preset: &PresetFileV2) -> PresetSummary {
    preset_summary(&PresetFile::V2(preset.clone()))
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

pub fn build_preset_v2(
    name: &str,
    buses: &BTreeMap<BusId, BusRuntime>,
    graph: &AudioGraph,
) -> Result<PresetFileV2, EngineError> {
    let input_names = list_input_devices().ok().map(index_by_id).unwrap_or_default();
    let output_names = list_output_devices().ok().map(index_by_id).unwrap_or_default();
    build_preset_v2_with_maps(name, buses, graph, &input_names, &output_names)
}

pub fn migrate_v1_to_v2(
    v1: &PresetFileV1,
) -> Result<(PresetFileV2, Vec<PresetLoadWarning>), EngineError> {
    let mut source = v1.clone();
    validate_preset_v1(&mut source)?;

    let mut warnings = vec![PresetLoadWarning {
        code: "v1_migrated".to_string(),
        message:
            "Legacy preset loaded into A1 only. Reassign extra buses and save again to upgrade."
                .to_string(),
    }];

    let mut a1_output: Option<PresetDeviceRef> = None;
    let mut distinct_outputs = HashSet::<String>::new();
    let mut inputs_by_id = HashMap::<String, PresetInputV2>::new();

    for route in &source.routes {
        distinct_outputs.insert(route.output.id.clone());
        if a1_output.is_none() {
            a1_output = Some(route.output.clone());
        }

        if let Some(existing) = inputs_by_id.get_mut(&route.input.id) {
            if let Some(a1_send) = existing.sends.iter_mut().find(|send| send.bus_id == BusId::A1)
            {
                warnings.push(PresetLoadWarning {
                    code: "v1_route_collapsed".to_string(),
                    message: format!(
                        "Legacy input '{}' had multiple routes. Only the first route was kept for A1.",
                        route.input.name
                    ),
                });
                a1_send.enabled = a1_send.enabled || route.enabled;
            }
            continue;
        }

        let mut sends = default_sends();
        if let Some(a1_send) = sends.iter_mut().find(|send| send.bus_id == BusId::A1) {
            a1_send.enabled = route.enabled;
            a1_send.volume = route.volume;
            a1_send.muted = route.muted;
        }

        inputs_by_id.insert(
            route.input.id.clone(),
            PresetInputV2 {
                device: route.input.clone(),
                gain: 1.0,
                muted: false,
                sends,
            },
        );
    }

    if distinct_outputs.len() > 1 {
        warnings.push(PresetLoadWarning {
            code: "v1_output_conflict".to_string(),
            message:
                "Legacy preset referenced multiple outputs. A1 was assigned to the first output."
                    .to_string(),
        });
    }

    let mut buses = default_buses();
    if let Some(a1) = buses.iter_mut().find(|bus| bus.id == BusId::A1) {
        a1.output = a1_output;
        a1.enabled = source.routes.iter().any(|route| route.enabled);
    }

    let mut migrated = PresetFileV2 {
        schema_version: SCHEMA_VERSION_V2,
        name: source.name,
        saved_at_utc: source.saved_at_utc,
        buses,
        inputs: inputs_by_id.into_values().collect(),
    };
    validate_preset_v2(&mut migrated)?;
    Ok((migrated, warnings))
}

pub fn load_preset_with_warnings(
    app: &AppHandle,
    name: &str,
) -> Result<PresetLoadData, EngineError> {
    let path = preset_file_path(app, name)?;
    let parsed = read_preset_file(&path)?;
    let summary = preset_summary(&parsed);

    let (preset_v2, mut warnings) = match parsed {
        PresetFile::V1(v1) => migrate_v1_to_v2(&v1)?,
        PresetFile::V2(v2) => (v2, Vec::new()),
    };

    warnings.extend(build_load_warnings(&preset_v2)?);
    Ok(PresetLoadData { summary, preset_v2, warnings })
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

fn parse_preset_json(raw: &str, path: &Path) -> Result<PresetFile, EngineError> {
    let value: serde_json::Value = serde_json::from_str(raw).map_err(|e| EngineError {
        message: format!("Invalid preset JSON in '{}': {e}", path.display()),
    })?;
    let schema = schema_version_from_value(&value)?;

    match schema {
        SCHEMA_VERSION_V1 => {
            let mut preset: PresetFileV1 =
                serde_json::from_value(value).map_err(|e| EngineError {
                    message: format!("Invalid preset JSON in '{}': {e}", path.display()),
                })?;
            validate_preset_v1(&mut preset)?;
            Ok(PresetFile::V1(preset))
        }
        SCHEMA_VERSION_V2 => {
            let mut preset: PresetFileV2 =
                serde_json::from_value(value).map_err(|e| EngineError {
                    message: format!("Invalid preset JSON in '{}': {e}", path.display()),
                })?;
            validate_preset_v2(&mut preset)?;
            Ok(PresetFile::V2(preset))
        }
        other => Err(EngineError {
            message: format!(
                "Unsupported preset schema_version {other} (supported: {SCHEMA_VERSION_V1}, {SCHEMA_VERSION_V2})"
            ),
        }),
    }
}

fn schema_version_from_value(value: &serde_json::Value) -> Result<u32, EngineError> {
    let Some(raw) = value.get("schema_version").and_then(|v| v.as_u64()) else {
        return Err(EngineError {
            message: "Preset schema_version must be a number".to_string(),
        });
    };

    u32::try_from(raw).map_err(|_| EngineError {
        message: format!("Unsupported preset schema_version {raw}"),
    })
}

fn normalize_buses(buses: &mut Vec<PresetBusV2>) -> Result<(), EngineError> {
    let mut by_id = HashMap::<BusId, PresetBusV2>::new();
    for mut bus in buses.drain(..) {
        if by_id.contains_key(&bus.id) {
            return Err(EngineError {
                message: format!("Preset contains duplicate bus '{}'", bus_id_str(bus.id)),
            });
        }

        bus.name = bus.name.trim().to_string();
        if bus.name.is_empty() {
            bus.name = bus.id.default_name().to_string();
        }

        if let Some(output) = &mut bus.output {
            output.id = output.id.trim().to_string();
            output.name = output.name.trim().to_string();
            if output.id.is_empty() {
                bus.output = None;
            } else if output.name.is_empty() {
                output.name = output.id.clone();
            }
        }

        if !bus.volume.is_finite() {
            return Err(EngineError {
                message: format!("Preset bus '{}' has non-finite volume", bus_id_str(bus.id)),
            });
        }
        bus.volume = BusConfig::clamp_volume(bus.volume);
        by_id.insert(bus.id, bus);
    }

    let mut normalized = Vec::with_capacity(BusId::ALL.len());
    for id in BusId::ALL {
        normalized.push(by_id.remove(&id).unwrap_or_else(|| default_bus(id)));
    }
    *buses = normalized;
    Ok(())
}

fn normalize_inputs(inputs: &mut Vec<PresetInputV2>) -> Result<(), EngineError> {
    let mut seen_inputs = HashSet::<String>::new();
    for input in inputs {
        input.device.id = input.device.id.trim().to_string();
        if input.device.id.is_empty() {
            return Err(EngineError {
                message: "Preset input has empty device.id".to_string(),
            });
        }

        input.device.name = input.device.name.trim().to_string();
        if input.device.name.is_empty() {
            input.device.name = input.device.id.clone();
        }

        if !input.gain.is_finite() {
            return Err(EngineError {
                message: format!("Preset input '{}' has non-finite gain", input.device.id),
            });
        }
        input.gain = InputChannel::clamp_gain(input.gain);

        if !seen_inputs.insert(input.device.id.clone()) {
            return Err(EngineError {
                message: format!("Preset contains duplicate input '{}'", input.device.id),
            });
        }

        normalize_sends(&input.device.id, &mut input.sends)?;
    }

    Ok(())
}

fn normalize_sends(input_id: &str, sends: &mut Vec<PresetSendV2>) -> Result<(), EngineError> {
    let mut by_bus = HashMap::<BusId, PresetSendV2>::new();
    for mut send in sends.drain(..) {
        if by_bus.contains_key(&send.bus_id) {
            return Err(EngineError {
                message: format!(
                    "Preset input '{}' has duplicate send for bus '{}'",
                    input_id,
                    bus_id_str(send.bus_id)
                ),
            });
        }
        if !send.volume.is_finite() {
            return Err(EngineError {
                message: format!(
                    "Preset input '{}' send '{}' has non-finite volume",
                    input_id,
                    bus_id_str(send.bus_id)
                ),
            });
        }
        send.volume = InputSend::clamp_volume(send.volume);
        by_bus.insert(send.bus_id, send);
    }

    let mut normalized = Vec::with_capacity(BusId::ALL.len());
    for bus_id in BusId::ALL {
        normalized.push(by_bus.remove(&bus_id).unwrap_or_else(|| default_send(bus_id)));
    }
    *sends = normalized;
    Ok(())
}

fn build_preset_v2_with_maps(
    name: &str,
    buses: &BTreeMap<BusId, BusRuntime>,
    graph: &AudioGraph,
    input_names: &HashMap<String, String>,
    output_names: &HashMap<String, String>,
) -> Result<PresetFileV2, EngineError> {
    let normalized_name = normalize_preset_name(name)?;
    let mut buses_v2 = Vec::with_capacity(BusId::ALL.len());
    for bus_id in BusId::ALL {
        let runtime = buses.get(&bus_id).ok_or_else(|| EngineError {
            message: format!("Missing bus runtime for '{}'", bus_id_str(bus_id)),
        })?;
        let output = runtime.config.output_device_id.as_ref().map(|output_id| PresetDeviceRef {
            id: output_id.clone(),
            name: output_names
                .get(output_id)
                .cloned()
                .unwrap_or_else(|| output_id.clone()),
        });
        buses_v2.push(PresetBusV2 {
            id: bus_id,
            name: runtime.config.name.clone(),
            output,
            volume: runtime.config.volume,
            muted: runtime.config.muted,
            enabled: runtime.config.enabled,
        });
    }

    let mut inputs_v2 = Vec::with_capacity(graph.inputs.len());
    for input in &graph.inputs {
        inputs_v2.push(PresetInputV2 {
            device: PresetDeviceRef {
                id: input.device_id.clone(),
                name: input_names
                    .get(&input.device_id)
                    .cloned()
                    .unwrap_or_else(|| input.device_id.clone()),
            },
            gain: input.gain,
            muted: input.muted,
            sends: input
                .sends
                .iter()
                .map(|send| PresetSendV2 {
                    bus_id: send.bus_id,
                    enabled: send.enabled,
                    volume: send.volume,
                    muted: send.muted,
                })
                .collect(),
        });
    }

    let mut preset = PresetFileV2 {
        schema_version: SCHEMA_VERSION_V2,
        name: normalized_name,
        saved_at_utc: now_utc_string(),
        buses: buses_v2,
        inputs: inputs_v2,
    };
    validate_preset_v2(&mut preset)?;
    Ok(preset)
}

fn build_load_warnings(preset: &PresetFileV2) -> Result<Vec<PresetLoadWarning>, EngineError> {
    let inputs = list_input_devices().map_err(|e| EngineError {
        message: format!("Failed to list current input devices: {}", e.message),
    })?;
    let outputs = list_output_devices().map_err(|e| EngineError {
        message: format!("Failed to list current output devices: {}", e.message),
    })?;

    let input_map = index_device_info(&inputs);
    let output_map = index_device_info(&outputs);
    let bus_map: HashMap<BusId, &PresetBusV2> = preset.buses.iter().map(|bus| (bus.id, bus)).collect();

    let mut warnings = Vec::<PresetLoadWarning>::new();

    for bus in &preset.buses {
        if let Some(output) = &bus.output {
            if !output_map.contains_key(&output.id) {
                warnings.push(PresetLoadWarning {
                    code: "missing_device".to_string(),
                    message: format!(
                        "Bus '{}' output '{}' is unavailable on this system.",
                        bus_id_str(bus.id),
                        output.name
                    ),
                });
            }
        }
    }

    for input in &preset.inputs {
        // Synthetic sources (system / process / app loopback, and phone over
        // WebRTC) are not cpal input devices — their availability is decided at
        // capture time, not against the device list — so checking them here
        // produced a bogus "unavailable" warning. Skip them. A phone whose
        // session is gone simply loads silent and shows a Disconnected badge.
        if crate::audio::source::is_reserved_id(&input.device.id) {
            continue;
        }
        let maybe_input = input_map.get(&input.device.id);
        if maybe_input.is_none() {
            warnings.push(PresetLoadWarning {
                code: "missing_device".to_string(),
                message: format!("Input '{}' is unavailable on this system.", input.device.name),
            });
            continue;
        }
        let input_info = maybe_input.expect("checked above");

        for send in input.sends.iter().filter(|send| send.enabled) {
            let Some(bus) = bus_map.get(&send.bus_id) else {
                continue;
            };
            let Some(output_ref) = &bus.output else {
                continue;
            };
            let Some(output_info) = output_map.get(&output_ref.id) else {
                continue;
            };

            if input_info.default_sample_rate != output_info.default_sample_rate {
                warnings.push(PresetLoadWarning {
                    code: "sample_rate_mismatch".to_string(),
                    message: format!(
                        "Input '{}' to bus '{}' may fail when enabled: sample rate mismatch {} Hz vs {} Hz.",
                        input.device.name,
                        bus_id_str(send.bus_id),
                        input_info.default_sample_rate,
                        output_info.default_sample_rate
                    ),
                });
            }
        }
    }

    Ok(warnings)
}

fn default_bus(id: BusId) -> PresetBusV2 {
    PresetBusV2 {
        id,
        name: id.default_name().to_string(),
        output: None,
        volume: 1.0,
        muted: false,
        enabled: false,
    }
}

fn default_buses() -> Vec<PresetBusV2> {
    BusId::ALL.into_iter().map(default_bus).collect()
}

fn default_send(bus_id: BusId) -> PresetSendV2 {
    PresetSendV2 {
        bus_id,
        enabled: false,
        volume: 1.0,
        muted: false,
    }
}

fn default_sends() -> Vec<PresetSendV2> {
    BusId::ALL.into_iter().map(default_send).collect()
}

fn bus_id_str(id: BusId) -> &'static str {
    match id {
        BusId::A1 => "A1",
        BusId::A2 => "A2",
        BusId::B1 => "B1",
        BusId::B2 => "B2",
    }
}

fn safe_file_stem(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut last_dash = false;

    for ch in name.chars() {
        let mapped = if ch.is_ascii_alphanumeric() || ch == '_' {
            ch.to_ascii_lowercase()
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
        assert_eq!(safe_file_stem("CON"), "con-preset");
    }

    #[test]
    fn validate_v2_rejects_duplicate_bus_ids() {
        let mut preset = PresetFileV2 {
            schema_version: SCHEMA_VERSION_V2,
            name: "dup bus".to_string(),
            saved_at_utc: "0".to_string(),
            buses: vec![default_bus(BusId::A1), default_bus(BusId::A1)],
            inputs: vec![],
        };

        assert!(validate_preset_v2(&mut preset).is_err());
    }

    #[test]
    fn validate_v2_rejects_duplicate_input_ids() {
        let mut preset = PresetFileV2 {
            schema_version: SCHEMA_VERSION_V2,
            name: "dup input".to_string(),
            saved_at_utc: "0".to_string(),
            buses: default_buses(),
            inputs: vec![
                PresetInputV2 {
                    device: PresetDeviceRef { id: "mic".to_string(), name: "Mic".to_string() },
                    gain: 1.0,
                    muted: false,
                    sends: default_sends(),
                },
                PresetInputV2 {
                    device: PresetDeviceRef { id: " mic ".to_string(), name: "Mic 2".to_string() },
                    gain: 1.0,
                    muted: false,
                    sends: default_sends(),
                },
            ],
        };

        assert!(validate_preset_v2(&mut preset).is_err());
    }

    #[test]
    fn validate_v2_rejects_duplicate_sends_per_input() {
        let mut preset = PresetFileV2 {
            schema_version: SCHEMA_VERSION_V2,
            name: "dup send".to_string(),
            saved_at_utc: "0".to_string(),
            buses: default_buses(),
            inputs: vec![PresetInputV2 {
                device: PresetDeviceRef { id: "mic".to_string(), name: "Mic".to_string() },
                gain: 1.0,
                muted: false,
                sends: vec![default_send(BusId::A1), default_send(BusId::A1)],
            }],
        };

        assert!(validate_preset_v2(&mut preset).is_err());
    }

    #[test]
    fn validate_v2_normalizes_missing_buses_and_clamps_volumes() {
        let mut preset = PresetFileV2 {
            schema_version: SCHEMA_VERSION_V2,
            name: "normalize".to_string(),
            saved_at_utc: "0".to_string(),
            buses: vec![PresetBusV2 {
                id: BusId::A1,
                name: "".to_string(),
                output: Some(PresetDeviceRef {
                    id: "  speaker  ".to_string(),
                    name: " ".to_string(),
                }),
                volume: 9.0,
                muted: false,
                enabled: true,
            }],
            inputs: vec![PresetInputV2 {
                device: PresetDeviceRef { id: " mic ".to_string(), name: "".to_string() },
                gain: 3.0,
                muted: false,
                sends: vec![PresetSendV2 {
                    bus_id: BusId::A1,
                    enabled: true,
                    volume: 9.0,
                    muted: false,
                }],
            }],
        };

        validate_preset_v2(&mut preset).unwrap();
        assert_eq!(preset.buses.len(), 4);
        assert_eq!(preset.inputs[0].sends.len(), 4);
        assert_eq!(preset.buses[0].name, "A1 Monitor");
        assert_eq!(preset.inputs[0].device.id, "mic");
        assert_eq!(preset.inputs[0].device.name, "mic");
        assert!((preset.inputs[0].gain - 2.0).abs() < f32::EPSILON);
        assert!((preset.inputs[0].sends[0].volume - 2.0).abs() < f32::EPSILON);
    }

    #[test]
    fn migrate_v1_maps_routes_into_a1_only() {
        let v1 = PresetFileV1 {
            schema_version: SCHEMA_VERSION_V1,
            name: "legacy".to_string(),
            saved_at_utc: "0".to_string(),
            routes: vec![PresetRouteV1 {
                input: PresetDeviceRef { id: "mic".to_string(), name: "Mic".to_string() },
                output: PresetDeviceRef { id: "spk".to_string(), name: "Speaker".to_string() },
                enabled: true,
                volume: 0.7,
                muted: true,
            }],
        };

        let (v2, _warnings) = migrate_v1_to_v2(&v1).unwrap();
        assert_eq!(v2.schema_version, SCHEMA_VERSION_V2);
        assert_eq!(v2.buses.len(), 4);
        let a1 = v2.buses.iter().find(|bus| bus.id == BusId::A1).unwrap();
        assert_eq!(a1.output.as_ref().unwrap().id, "spk");
        assert!(a1.enabled);
        assert!(v2.buses.iter().filter(|bus| bus.id != BusId::A1).all(|bus| !bus.enabled));

        assert_eq!(v2.inputs.len(), 1);
        let input = &v2.inputs[0];
        let a1_send = input.sends.iter().find(|send| send.bus_id == BusId::A1).unwrap();
        assert!(a1_send.enabled);
        assert!((a1_send.volume - 0.7).abs() < f32::EPSILON);
        assert!(a1_send.muted);
        assert!(
            input
                .sends
                .iter()
                .filter(|send| send.bus_id != BusId::A1)
                .all(|send| !send.enabled)
        );
    }

    #[test]
    fn migrate_v1_emits_required_warning() {
        let v1 = PresetFileV1 {
            schema_version: SCHEMA_VERSION_V1,
            name: "legacy".to_string(),
            saved_at_utc: "0".to_string(),
            routes: vec![],
        };

        let (_v2, warnings) = migrate_v1_to_v2(&v1).unwrap();
        assert!(warnings.iter().any(|warning| {
            warning.code == "v1_migrated"
                && warning.message
                    == "Legacy preset loaded into A1 only. Reassign extra buses and save again to upgrade."
        }));
    }

    #[test]
    fn save_v2_build_includes_buses_and_inputs() {
        let mut buses = BusRuntime::default_set();
        {
            let a1 = buses.get_mut(&BusId::A1).unwrap();
            a1.config.output_device_id = Some("spk".to_string());
            a1.config.enabled = true;
        }

        let mut graph = AudioGraph::new();
        graph.add_input("mic");
        graph.set_input_gain("mic", 1.4, true);
        graph.set_send("mic", BusId::A1, true);
        graph.set_send_gain("mic", BusId::A1, 0.5, false);
        graph.set_send("mic", BusId::B1, true);

        let mut input_names = HashMap::new();
        input_names.insert("mic".to_string(), "Mic Name".to_string());
        let mut output_names = HashMap::new();
        output_names.insert("spk".to_string(), "Speaker Name".to_string());

        let preset =
            build_preset_v2_with_maps("test", &buses, &graph, &input_names, &output_names).unwrap();
        assert_eq!(preset.schema_version, SCHEMA_VERSION_V2);
        assert_eq!(preset.buses.len(), 4);
        assert_eq!(preset.inputs.len(), 1);
        assert_eq!(preset.inputs[0].sends.len(), 4);
        assert_eq!(preset.inputs[0].device.name, "Mic Name");
        let a1 = preset.buses.iter().find(|bus| bus.id == BusId::A1).unwrap();
        assert_eq!(a1.output.as_ref().unwrap().name, "Speaker Name");
    }

    #[test]
    fn invalid_schema_version_fails_clearly() {
        let path = PathBuf::from("preset.json");
        let err = parse_preset_json(
            r#"{"schema_version":99,"name":"x","saved_at_utc":"0","routes":[]}"#,
            &path,
        )
        .unwrap_err();
        assert!(err.message.contains("Unsupported preset schema_version 99"));
    }
}
