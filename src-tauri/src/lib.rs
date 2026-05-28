mod audio;
mod presets;
mod state;

use std::collections::BTreeMap;

use audio::bus::{BusConfig, BusId, BusStatus};
use audio::devices::{DeviceInfo, DeviceListError};
use audio::graph::InputChannel;
use audio::mixer::{EngineError, MixerInput};
use audio::routing::Route;
use presets::{PresetFileV2, PresetLoadResult, PresetLoadWarning, PresetSummary};
use state::{AppInner, AppState};

// ── Device enumeration ────────────────────────────────────────────────────────

#[tauri::command]
fn list_input_devices() -> Result<Vec<DeviceInfo>, DeviceListError> {
    audio::devices::list_input_devices()
}

#[tauri::command]
fn list_output_devices() -> Result<Vec<DeviceInfo>, DeviceListError> {
    audio::devices::list_output_devices()
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/// Stop the engine for `bus_id` and restart it from current matrix state.
///
/// A bus runs only when all of these are true:
///   * `config.enabled`
///   * `config.output_device_id` is `Some(_)`
///   * The graph has at least one enabled send to `bus_id`
fn rebuild_bus(inner: &mut AppInner, bus_id: BusId) -> Result<(), EngineError> {
    let (enabled, output_id, bus_vol, bus_muted) = {
        let bus = inner.buses.get_mut(&bus_id).ok_or_else(|| EngineError {
            message: format!("Unknown bus: {bus_id:?}"),
        })?;
        // Drop first so WASAPI handles are released before a restart attempt.
        bus.engine = None;
        (
            bus.config.enabled,
            bus.config.output_device_id.clone(),
            bus.config.volume,
            bus.config.muted,
        )
    };

    if !enabled {
        return Ok(());
    }
    let Some(output_id) = output_id else {
        return Ok(());
    };

    let active_inputs = inner.graph.effective_inputs_for_bus(bus_id);
    if active_inputs.is_empty() {
        return Ok(());
    }

    let mixer_inputs: Vec<MixerInput> = active_inputs
        .into_iter()
        .map(|(name, vol, muted)| MixerInput { device_name: name, gain: vol, muted })
        .collect();

    match audio::mixer::start(&output_id, &mixer_inputs, bus_vol, bus_muted) {
        Ok(engine) => {
            let bus = inner.buses.get_mut(&bus_id).expect("bus exists");
            bus.engine = Some(engine);
            bus.last_error = None;
            Ok(())
        }
        Err(err) => {
            let bus = inner.buses.get_mut(&bus_id).expect("bus exists");
            bus.last_error = Some(err.message.clone());
            Err(err)
        }
    }
}

fn store_last_error(inner: &mut AppInner, err: EngineError) -> EngineError {
    inner.last_error = Some(err.message.clone());
    err
}

fn new_last_error(inner: &mut AppInner, message: impl Into<String>) -> EngineError {
    let message = message.into();
    inner.last_error = Some(message.clone());
    EngineError { message }
}

fn ensure_input_name(device_id: &str) -> Result<(), EngineError> {
    let inputs = audio::devices::list_input_devices().map_err(|err| EngineError {
        message: format!("Failed to list input devices: {}", err.message),
    })?;
    if inputs.iter().any(|device| device.id == device_id) {
        Ok(())
    } else {
        Err(EngineError { message: format!("Input device not found: {device_id}") })
    }
}

/// True when bus A1's currently-assigned output device matches `output_id`.
/// Legacy single-output commands still operate on A1 for compatibility.
fn a1_accepts(inner: &AppInner, output_id: &str) -> bool {
    inner
        .buses
        .get(&BusId::A1)
        .and_then(|b| b.config.output_device_id.as_deref())
        .map(|dev| dev == output_id)
        .unwrap_or(true)
}

fn bind_a1_to(inner: &mut AppInner, output_id: &str) {
    if let Some(bus) = inner.buses.get_mut(&BusId::A1) {
        bus.config.output_device_id = Some(output_id.to_string());
        bus.config.enabled = true;
    }
}

fn legacy_routes(inner: &AppInner) -> Vec<Route> {
    let a1 = inner.buses.get(&BusId::A1);
    let output = a1.and_then(|bus| bus.config.output_device_id.as_deref());
    let running = a1.and_then(|bus| bus.engine.as_ref()).is_some();
    inner.graph.to_legacy_routes_a1(output, running)
}

fn apply_preset_state(
    inner: &mut AppInner,
    preset: &PresetFileV2,
) -> Result<(), EngineError> {
    for bus in inner.buses.values_mut() {
        bus.engine = None;
        bus.last_error = None;
    }
    inner.graph.clear();

    for bus_preset in &preset.buses {
        let bus = inner.buses.get_mut(&bus_preset.id).ok_or_else(|| EngineError {
            message: format!("Unknown bus: {:?}", bus_preset.id),
        })?;
        bus.config.name = bus_preset.name.clone();
        bus.config.output_device_id = bus_preset.output.as_ref().map(|output| output.id.clone());
        bus.config.volume = BusConfig::clamp_volume(bus_preset.volume);
        bus.config.muted = bus_preset.muted;
        bus.config.enabled = bus_preset.enabled;
        bus.engine = None;
        bus.last_error = None;
    }

    for input_preset in &preset.inputs {
        if !inner.graph.has_input(&input_preset.device.id) {
            inner.graph.add_input(&input_preset.device.id);
        }

        if !inner
            .graph
            .set_input_gain(&input_preset.device.id, input_preset.gain, input_preset.muted)
        {
            return Err(EngineError {
                message: format!("Failed to apply preset input '{}'", input_preset.device.id),
            });
        }

        for send in &input_preset.sends {
            if !inner.graph.set_send(&input_preset.device.id, send.bus_id, send.enabled) {
                return Err(EngineError {
                    message: format!(
                        "Failed to apply preset send '{}:{:?}'",
                        input_preset.device.id, send.bus_id
                    ),
                });
            }
            if !inner
                .graph
                .set_send_gain(&input_preset.device.id, send.bus_id, send.volume, send.muted)
            {
                return Err(EngineError {
                    message: format!(
                        "Failed to apply preset send gain '{}:{:?}'",
                        input_preset.device.id, send.bus_id
                    ),
                });
            }
        }
    }

    inner.last_error = None;
    Ok(())
}

// ── IPC status payloads ───────────────────────────────────────────────────────

#[derive(serde::Serialize)]
struct PassthroughStatus {
    running: bool,
    input_device: Option<String>,
    output_device: Option<String>,
}

#[derive(serde::Serialize)]
struct EngineStatus {
    status: &'static str,
    output_device: Option<String>,
    active_inputs: Vec<String>,
    input_peaks: Vec<f32>,
    output_peak: f32,
    clipped_recently: bool,
    last_error: Option<String>,
}

#[derive(serde::Serialize)]
struct InputPeakStatus {
    device_id: String,
    peak: f32,
}

#[derive(serde::Serialize)]
struct SystemStatus {
    buses: Vec<BusStatus>,
    inputs: Vec<InputChannel>,
    input_peaks: Vec<InputPeakStatus>,
    last_error: Option<String>,
}

// ── Phase 1 passthrough (compat: A1 only) ─────────────────────────────────────

#[tauri::command]
fn start_passthrough(
    state: tauri::State<AppState>,
    input_id: String,
    output_id: String,
) -> Result<(), EngineError> {
    ensure_input_name(&input_id)?;

    let mut inner = state.inner.lock().unwrap();
    for bus in inner.buses.values_mut() {
        bus.engine = None;
        bus.last_error = None;
    }
    inner.graph.clear();
    inner.graph.add_input(&input_id);
    inner.graph.set_send(&input_id, BusId::A1, true);
    bind_a1_to(&mut inner, &output_id);

    if let Err(err) = rebuild_bus(&mut inner, BusId::A1) {
        return Err(store_last_error(&mut inner, err));
    }
    inner.last_error = None;
    Ok(())
}

#[tauri::command]
fn stop_passthrough(state: tauri::State<AppState>) -> Result<(), EngineError> {
    let mut inner = state.inner.lock().unwrap();
    for bus in inner.buses.values_mut() {
        bus.engine = None;
        bus.last_error = None;
    }
    inner.graph.clear();
    inner.last_error = None;
    Ok(())
}

#[tauri::command]
fn get_passthrough_status(state: tauri::State<AppState>) -> PassthroughStatus {
    let inner = state.inner.lock().unwrap();
    let a1 = inner.buses.get(&BusId::A1);
    match a1.and_then(|b| b.engine.as_ref()) {
        Some(engine) => PassthroughStatus {
            running: true,
            input_device: engine.inputs.first().map(|i| i.device_name.clone()),
            output_device: Some(engine.output_device_name.clone()),
        },
        None => PassthroughStatus { running: false, input_device: None, output_device: None },
    }
}

/// Legacy alias: returns bus A1's status in the old `EngineStatus` shape.
#[tauri::command]
fn get_engine_status(state: tauri::State<AppState>) -> EngineStatus {
    let inner = state.inner.lock().unwrap();
    let a1 = inner.buses.get(&BusId::A1);
    match a1.and_then(|b| b.engine.as_ref()) {
        Some(engine) => {
            let (input_peaks, output_peak, clipped_recently) = engine.read_and_reset_meters();
            EngineStatus {
                status: "running",
                output_device: Some(engine.output_device_name.clone()),
                active_inputs: engine
                    .inputs
                    .iter()
                    .map(|input| input.device_name.clone())
                    .collect(),
                input_peaks,
                output_peak,
                clipped_recently,
                last_error: a1.and_then(|b| b.last_error.clone()).or(inner.last_error.clone()),
            }
        }
        None => {
            let a1_err = a1.and_then(|b| b.last_error.clone());
            let any_err = a1_err.clone().or(inner.last_error.clone());
            EngineStatus {
                status: if any_err.is_some() { "error" } else { "stopped" },
                output_device: None,
                active_inputs: vec![],
                input_peaks: vec![],
                output_peak: 0.0,
                clipped_recently: false,
                last_error: any_err,
            }
        }
    }
}

// ── Presets (Phase 6 V1 compatibility) ───────────────────────────────────────

#[tauri::command]
fn list_presets(app: tauri::AppHandle) -> Result<Vec<PresetSummary>, EngineError> {
    presets::list_preset_summaries(&app)
}

#[tauri::command]
fn save_preset(
    state: tauri::State<AppState>,
    app: tauri::AppHandle,
    name: String,
) -> Result<PresetSummary, EngineError> {
    let mut inner = state.inner.lock().unwrap();
    let preset = presets::build_preset_v2(&name, &inner.buses, &inner.graph)?;
    let path = presets::preset_file_path(&app, &preset.name)?;
    presets::write_preset_file(&path, &preset)?;
    inner.last_error = None;
    Ok(presets::preset_summary_v2(&preset))
}

#[tauri::command]
fn load_preset(
    state: tauri::State<AppState>,
    app: tauri::AppHandle,
    name: String,
) -> Result<PresetLoadResult, EngineError> {
    let loaded = presets::load_preset_with_warnings(&app, &name)?;
    let mut inner = state.inner.lock().unwrap();
    apply_preset_state(&mut inner, &loaded.preset_v2)?;
    let routes = legacy_routes(&inner);
    let mut warnings = loaded.warnings;

    warnings.push(PresetLoadWarning {
        code: "safe_load".to_string(),
        message: "Preset loaded safely. Audio remains stopped until buses are manually enabled."
            .to_string(),
    });

    inner.last_error = None;
    Ok(PresetLoadResult {
        preset: loaded.summary,
        routes,
        warnings,
    })
}

#[tauri::command]
fn delete_preset(
    state: tauri::State<AppState>,
    app: tauri::AppHandle,
    name: String,
) -> Result<(), EngineError> {
    let mut inner = state.inner.lock().unwrap();
    presets::delete_preset_file(&app, &name)?;
    inner.last_error = None;
    Ok(())
}

// ── Legacy route commands (A1 compatibility) ─────────────────────────────────

#[tauri::command]
fn get_routes(state: tauri::State<AppState>) -> Vec<Route> {
    let inner = state.inner.lock().unwrap();
    legacy_routes(&inner)
}

#[tauri::command]
fn set_route(
    state: tauri::State<AppState>,
    input_id: String,
    output_id: String,
    enabled: bool,
) -> Result<Vec<Route>, EngineError> {
    let mut inner = state.inner.lock().unwrap();

    if enabled {
        if !a1_accepts(&inner, &output_id) {
            return Err(new_last_error(
                &mut inner,
                "Bus A1 is bound to a different output device. \
                 Stop the current output before enabling another.",
            ));
        }
        if !inner.graph.has_input(&input_id) {
            inner.graph.add_input(&input_id);
        }
        bind_a1_to(&mut inner, &output_id);
        inner.graph.set_send(&input_id, BusId::A1, true);
    } else {
        if !inner.graph.has_input(&input_id) {
            inner.graph.add_input(&input_id);
        }
        inner.graph.set_send(&input_id, BusId::A1, false);
    }

    if let Err(err) = rebuild_bus(&mut inner, BusId::A1) {
        return Err(store_last_error(&mut inner, err));
    }

    inner.last_error = None;
    Ok(legacy_routes(&inner))
}

#[tauri::command]
fn clear_routes(state: tauri::State<AppState>) -> Result<(), EngineError> {
    let mut inner = state.inner.lock().unwrap();
    for bus in inner.buses.values_mut() {
        bus.engine = None;
        bus.last_error = None;
    }
    inner.graph.clear();
    inner.last_error = None;
    Ok(())
}

#[tauri::command]
fn set_route_gain(
    state: tauri::State<AppState>,
    input_id: String,
    output_id: String,
    volume: f32,
    muted: bool,
) -> Result<Vec<Route>, EngineError> {
    let volume = volume.clamp(0.0, 2.0);
    let mut inner = state.inner.lock().unwrap();
    let a1_output = inner
        .buses
        .get(&BusId::A1)
        .and_then(|bus| bus.config.output_device_id.as_ref())
        .cloned();

    if a1_output.as_deref() != Some(output_id.as_str()) || !inner.graph.has_input(&input_id) {
        return Err(new_last_error(
            &mut inner,
            format!("Route not found: {input_id} → {output_id}"),
        ));
    }

    if !inner.graph.set_send_gain(&input_id, BusId::A1, volume, muted) {
        return Err(new_last_error(
            &mut inner,
            format!("Route not found: {input_id} → {output_id}"),
        ));
    }

    if let Some((effective_gain, effective_muted, enabled)) =
        inner.graph.effective_input_for_bus(&input_id, BusId::A1)
    {
        if enabled {
            if let Some(bus) = inner.buses.get(&BusId::A1) {
                if let Some(engine) = bus.engine.as_ref() {
                    if engine.is_output_device(&output_id) {
                        engine.update_gain(&input_id, effective_gain, effective_muted);
                    }
                }
            }
        }
    }

    inner.last_error = None;
    Ok(legacy_routes(&inner))
}

// ── Phase 8B matrix commands ──────────────────────────────────────────────────

#[tauri::command]
fn list_inputs(state: tauri::State<AppState>) -> Vec<InputChannel> {
    state.inner.lock().unwrap().graph.list_inputs()
}

#[tauri::command]
fn add_input(
    state: tauri::State<AppState>,
    device_id: String,
) -> Result<Vec<InputChannel>, EngineError> {
    ensure_input_name(&device_id)?;
    let mut inner = state.inner.lock().unwrap();
    inner.graph.add_input(&device_id);
    inner.last_error = None;
    Ok(inner.graph.list_inputs())
}

#[tauri::command]
fn remove_input(
    state: tauri::State<AppState>,
    device_id: String,
) -> Result<Vec<InputChannel>, EngineError> {
    let mut inner = state.inner.lock().unwrap();
    let affected: Vec<BusId> = BusId::ALL
        .into_iter()
        .filter(|bus_id| {
            inner
                .graph
                .get_send(&device_id, *bus_id)
                .map(|send| send.enabled)
                .unwrap_or(false)
        })
        .collect();

    if !inner.graph.remove_input(&device_id) {
        return Err(new_last_error(
            &mut inner,
            format!("Input not found: {device_id}"),
        ));
    }

    for bus_id in affected {
        if let Err(err) = rebuild_bus(&mut inner, bus_id) {
            return Err(store_last_error(&mut inner, err));
        }
    }

    inner.last_error = None;
    Ok(inner.graph.list_inputs())
}

#[tauri::command]
fn set_input_gain(
    state: tauri::State<AppState>,
    device_id: String,
    gain: f32,
    muted: bool,
) -> Result<Vec<InputChannel>, EngineError> {
    let mut inner = state.inner.lock().unwrap();
    if !inner.graph.set_input_gain(&device_id, gain, muted) {
        return Err(new_last_error(
            &mut inner,
            format!("Input not found: {device_id}"),
        ));
    }

    for bus_id in BusId::ALL {
        if let Some((effective_gain, effective_muted, enabled)) =
            inner.graph.effective_input_for_bus(&device_id, bus_id)
        {
            if enabled {
                if let Some(bus) = inner.buses.get(&bus_id) {
                    if let Some(engine) = bus.engine.as_ref() {
                        engine.update_gain(&device_id, effective_gain, effective_muted);
                    }
                }
            }
        }
    }

    inner.last_error = None;
    Ok(inner.graph.list_inputs())
}

#[tauri::command]
fn set_send(
    state: tauri::State<AppState>,
    device_id: String,
    bus_id: BusId,
    enabled: bool,
) -> Result<Vec<InputChannel>, EngineError> {
    let mut inner = state.inner.lock().unwrap();
    if !inner.graph.set_send(&device_id, bus_id, enabled) {
        return Err(new_last_error(
            &mut inner,
            format!("Input not found: {device_id}"),
        ));
    }
    if let Err(err) = rebuild_bus(&mut inner, bus_id) {
        return Err(store_last_error(&mut inner, err));
    }

    inner.last_error = None;
    Ok(inner.graph.list_inputs())
}

#[tauri::command]
fn set_send_gain(
    state: tauri::State<AppState>,
    device_id: String,
    bus_id: BusId,
    volume: f32,
    muted: bool,
) -> Result<Vec<InputChannel>, EngineError> {
    let mut inner = state.inner.lock().unwrap();
    if !inner.graph.set_send_gain(&device_id, bus_id, volume, muted) {
        return Err(new_last_error(
            &mut inner,
            format!("Input not found: {device_id}"),
        ));
    }

    if let Some((effective_gain, effective_muted, enabled)) =
        inner.graph.effective_input_for_bus(&device_id, bus_id)
    {
        if enabled {
            if let Some(bus) = inner.buses.get(&bus_id) {
                if let Some(engine) = bus.engine.as_ref() {
                    engine.update_gain(&device_id, effective_gain, effective_muted);
                }
            }
        }
    }

    inner.last_error = None;
    Ok(inner.graph.list_inputs())
}

// ── Phase 8A/8B bus commands ──────────────────────────────────────────────────

#[tauri::command]
fn list_buses(state: tauri::State<AppState>) -> Vec<BusStatus> {
    let inner = state.inner.lock().unwrap();
    inner.buses.values().map(|b| b.read_status()).collect()
}

#[tauri::command]
fn get_system_status(state: tauri::State<AppState>) -> SystemStatus {
    let inner = state.inner.lock().unwrap();

    let mut input_peaks_by_device: BTreeMap<String, f32> = BTreeMap::new();
    let mut buses = Vec::with_capacity(inner.buses.len());

    for bus in inner.buses.values() {
        let (output_peak, clipped_recently) = match bus.engine.as_ref() {
            Some(engine) => {
                let (input_peaks, output_peak, clipped_recently) = engine.read_and_reset_meters();
                for (idx, info) in engine.inputs.iter().enumerate() {
                    let peak = input_peaks.get(idx).copied().unwrap_or(0.0);
                    input_peaks_by_device
                        .entry(info.device_name.clone())
                        .and_modify(|current| {
                            if peak > *current {
                                *current = peak;
                            }
                        })
                        .or_insert(peak);
                }
                (output_peak, clipped_recently)
            }
            None => (0.0, false),
        };
        buses.push(bus.status_from_meters(output_peak, clipped_recently));
    }

    let input_peaks = input_peaks_by_device
        .into_iter()
        .map(|(device_id, peak)| InputPeakStatus { device_id, peak })
        .collect();

    SystemStatus {
        buses,
        inputs: inner.graph.list_inputs(),
        input_peaks,
        last_error: inner.last_error.clone(),
    }
}

#[tauri::command]
fn set_bus_device(
    state: tauri::State<AppState>,
    bus_id: BusId,
    output_device_id: Option<String>,
) -> Result<BusStatus, EngineError> {
    let mut inner = state.inner.lock().unwrap();
    {
        let bus = inner.buses.get_mut(&bus_id).ok_or_else(|| EngineError {
            message: format!("Unknown bus: {bus_id:?}"),
        })?;
        bus.config.output_device_id = output_device_id;
    }
    if let Err(err) = rebuild_bus(&mut inner, bus_id) {
        let _ = store_last_error(&mut inner, err.clone());
        let bus = inner.buses.get(&bus_id).expect("bus exists");
        return Ok(bus.read_status());
    }
    let bus = inner.buses.get(&bus_id).expect("bus exists");
    Ok(bus.read_status())
}

#[tauri::command]
fn set_bus_volume(
    state: tauri::State<AppState>,
    bus_id: BusId,
    volume: f32,
    muted: bool,
) -> Result<BusStatus, EngineError> {
    let volume = BusConfig::clamp_volume(volume);
    let mut inner = state.inner.lock().unwrap();
    let bus = inner.buses.get_mut(&bus_id).ok_or_else(|| EngineError {
        message: format!("Unknown bus: {bus_id:?}"),
    })?;
    bus.config.volume = volume;
    bus.config.muted = muted;
    if let Some(engine) = bus.engine.as_ref() {
        engine.update_bus_volume(volume, muted);
    }
    Ok(bus.read_status())
}

#[tauri::command]
fn set_bus_enabled(
    state: tauri::State<AppState>,
    bus_id: BusId,
    enabled: bool,
) -> Result<BusStatus, EngineError> {
    let mut inner = state.inner.lock().unwrap();
    {
        let bus = inner.buses.get_mut(&bus_id).ok_or_else(|| EngineError {
            message: format!("Unknown bus: {bus_id:?}"),
        })?;
        bus.config.enabled = enabled;
    }
    if let Err(err) = rebuild_bus(&mut inner, bus_id) {
        let _ = store_last_error(&mut inner, err.clone());
        let bus = inner.buses.get(&bus_id).expect("bus exists");
        return Ok(bus.read_status());
    }
    let bus = inner.buses.get(&bus_id).expect("bus exists");
    Ok(bus.read_status())
}

#[tauri::command]
fn rename_bus(
    state: tauri::State<AppState>,
    bus_id: BusId,
    name: String,
) -> Result<BusStatus, EngineError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(EngineError { message: "Bus name cannot be empty".to_string() });
    }
    let mut inner = state.inner.lock().unwrap();
    let bus = inner.buses.get_mut(&bus_id).ok_or_else(|| EngineError {
        message: format!("Unknown bus: {bus_id:?}"),
    })?;
    bus.config.name = trimmed.to_string();
    Ok(bus.read_status())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::bus::BusRuntime;
    use crate::audio::graph::AudioGraph;

    fn preset_bus(id: BusId) -> presets::PresetBusV2 {
        presets::PresetBusV2 {
            id,
            name: id.default_name().to_string(),
            output: None,
            volume: 1.0,
            muted: false,
            enabled: false,
        }
    }

    #[test]
    fn load_preset_state_does_not_start_any_engine() {
        let mut buses = vec![
            preset_bus(BusId::A1),
            preset_bus(BusId::A2),
            preset_bus(BusId::B1),
            preset_bus(BusId::B2),
        ];
        buses[0].enabled = true;
        buses[0].output = Some(presets::PresetDeviceRef {
            id: "speaker".to_string(),
            name: "Speaker".to_string(),
        });

        let preset = PresetFileV2 {
            schema_version: 2,
            name: "test".to_string(),
            saved_at_utc: "0".to_string(),
            buses,
            inputs: vec![presets::PresetInputV2 {
                device: presets::PresetDeviceRef {
                    id: "mic".to_string(),
                    name: "Mic".to_string(),
                },
                gain: 1.0,
                muted: false,
                sends: vec![
                    presets::PresetSendV2 {
                        bus_id: BusId::A1,
                        enabled: true,
                        volume: 1.0,
                        muted: false,
                    },
                    presets::PresetSendV2 {
                        bus_id: BusId::A2,
                        enabled: false,
                        volume: 1.0,
                        muted: false,
                    },
                    presets::PresetSendV2 {
                        bus_id: BusId::B1,
                        enabled: false,
                        volume: 1.0,
                        muted: false,
                    },
                    presets::PresetSendV2 {
                        bus_id: BusId::B2,
                        enabled: false,
                        volume: 1.0,
                        muted: false,
                    },
                ],
            }],
        };

        let mut inner = AppInner {
            buses: BusRuntime::default_set(),
            graph: AudioGraph::new(),
            last_error: Some("stale".to_string()),
        };

        apply_preset_state(&mut inner, &preset).unwrap();
        assert!(inner.buses.values().all(|bus| bus.engine.is_none()));
        assert!(legacy_routes(&inner).iter().all(|route| !route.active));
        assert!(inner.last_error.is_none());
    }
}

// ── Tauri entry point ─────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            list_input_devices,
            list_output_devices,
            start_passthrough,
            stop_passthrough,
            get_passthrough_status,
            get_engine_status,
            list_presets,
            save_preset,
            load_preset,
            delete_preset,
            get_routes,
            set_route,
            clear_routes,
            set_route_gain,
            list_inputs,
            add_input,
            remove_input,
            set_input_gain,
            set_send,
            set_send_gain,
            list_buses,
            get_system_status,
            set_bus_device,
            set_bus_volume,
            set_bus_enabled,
            rename_bus,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
