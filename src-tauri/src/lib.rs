mod amvc;
mod audio;
mod net;
mod presets;
mod state;

use std::collections::BTreeMap;
use std::path::PathBuf;

use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

use audio::bus::{BusConfig, BusId, BusStatus};
use audio::devices::{DeviceInfo, DeviceListError};
use audio::graph::InputChannel;
use audio::mixer::{EngineError, MixerInput};
use audio::source::InputSourceSpec;
use audio::recorder::{
    self, CallbackTapKind, RecorderSettings, RecordingFile, RecordingInfo, StartRecorderRequest,
    TapSpec,
};
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

/// List applications currently holding a session on the default render
/// endpoint. Each entry carries a ready `proc:<pid>` source id for `add_input`.
#[tauri::command]
fn list_audio_sessions() -> Result<Vec<audio::session::AudioSessionInfo>, EngineError> {
    audio::session::list_audio_sessions()
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/// Stop and remove every recorder whose tap is attached to `bus_id`.
///
/// Internal helper used by `tear_down_engine`. Must be called BEFORE the
/// bus's engine is dropped — this way the `Remove` command reaches the
/// still-running audio callback, which releases the ring producer, and
/// the writer thread drains cleanly.
fn stop_recorders_for_bus(inner: &mut AppInner, bus_id: BusId) {
    let ids: Vec<String> = inner
        .recorders
        .iter()
        .filter(|(_, h)| h.engine_bus == bus_id)
        .map(|(id, _)| id.clone())
        .collect();
    for id in ids {
        if let Some(handle) = inner.recorders.remove(&id) {
            let _ = handle.stop();
        }
    }
}

/// Drop the engine on `bus_id` AND ensure every recorder attached to that
/// bus is stopped first. Single source of truth for bus-engine teardown
/// — callers MUST go through this helper instead of writing `bus.engine
/// = None` directly. That convention used to be enforced by code review
/// only; routing it through one function eliminates the regression
/// surface where a new teardown path could forget the recorder cleanup
/// and leak writer threads polling a dead consumer.
fn tear_down_engine(inner: &mut AppInner, bus_id: BusId) {
    stop_recorders_for_bus(inner, bus_id);
    if let Some(bus) = inner.buses.get_mut(&bus_id) {
        bus.engine = None;
    }
}

/// Tear down every bus engine (and every recorder) at once. Used by
/// full-wipe paths: passthrough start/stop, clear_routes, preset apply.
fn tear_down_all_engines(inner: &mut AppInner) {
    for bus_id in BusId::ALL {
        tear_down_engine(inner, bus_id);
    }
}

fn resolve_recordings_dir(app: &tauri::AppHandle) -> Result<PathBuf, EngineError> {
    let base = app.path().app_local_data_dir().map_err(|e| EngineError {
        message: format!("Failed to resolve app local data dir: {e}"),
    })?;
    let settings = RecorderSettings::load_or_default(&base);
    Ok(settings.recordings_dir)
}

fn app_local_dir(app: &tauri::AppHandle) -> Result<PathBuf, EngineError> {
    app.path().app_local_data_dir().map_err(|e| EngineError {
        message: format!("Failed to resolve app local data dir: {e}"),
    })
}

/// Stop the engine for `bus_id` and restart it from current matrix state.
///
/// A bus runs only when all of these are true:
///   * `config.enabled`
///   * `config.output_device_id` is `Some(_)`
///   * The graph has at least one enabled send to `bus_id`
fn rebuild_bus(inner: &mut AppInner, bus_id: BusId) -> Result<(), EngineError> {
    // Centralized teardown: stops recorders first, then drops the engine
    // so WASAPI handles are released before the restart attempt.
    tear_down_engine(inner, bus_id);
    let (enabled, output_id, bus_vol, bus_muted) = {
        let bus = inner.buses.get_mut(&bus_id).ok_or_else(|| EngineError {
            message: format!("Unknown bus: {bus_id:?}"),
        })?;
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
        .map(|(id, vol, muted)| MixerInput {
            source: InputSourceSpec::parse(&id),
            gain: vol,
            muted,
        })
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

/// Validate that `device_id` names a usable input source before it is added to
/// the graph or used to (re)build a bus.
///
///   * Device ids must match a currently-enumerated cpal input device.
///   * `sys:default` (system loopback) and `proc:<pid>` (process loopback) are
///     accepted on Windows; the precise OS-version gate is enforced at capture
///     time by the loopback module.
///   * A plain device id that poaches a reserved synthetic prefix (`proc:` /
///     `sys:`) is refused so it can never shadow a loopback source.
fn ensure_input_source(device_id: &str) -> Result<(), EngineError> {
    match InputSourceSpec::parse(device_id) {
        InputSourceSpec::Device { name } => {
            if audio::source::is_reserved_id(&name) {
                return Err(EngineError {
                    message: format!(
                        "'{name}' uses a reserved id prefix (proc:/sys:) and cannot be \
                         registered as a device."
                    ),
                });
            }
            let inputs = audio::devices::list_input_devices().map_err(|err| EngineError {
                message: format!("Failed to list input devices: {}", err.message),
            })?;
            if inputs.iter().any(|device| device.id == name) {
                Ok(())
            } else {
                Err(EngineError { message: format!("Input device not found: {name}") })
            }
        }
        InputSourceSpec::SystemLoopback
        | InputSourceSpec::Process { .. }
        | InputSourceSpec::ProcessByName { .. } => ensure_loopback_supported(),
        // Phone sources are platform-agnostic and always valid to register: the
        // feed is passive (silent until the phone connects), so a stale or
        // not-yet-connected session is accepted rather than rejected.
        InputSourceSpec::RemotePhone { .. } => Ok(()),
    }
}

/// Platform gate for loopback capture. The exact Windows build requirement
/// (1803 for system, 2004 for process) is checked at capture time where the
/// failure can be surfaced per-mode; here we only refuse non-Windows hosts.
fn ensure_loopback_supported() -> Result<(), EngineError> {
    #[cfg(windows)]
    {
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err(EngineError {
            message: "Loopback capture (system / per-app) is only supported on Windows."
                .to_string(),
        })
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
    tear_down_all_engines(inner);
    for bus in inner.buses.values_mut() {
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
    ensure_input_source(&input_id)?;

    let mut inner = state.inner.lock().unwrap();
    tear_down_all_engines(&mut inner);
    for bus in inner.buses.values_mut() {
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
    tear_down_all_engines(&mut inner);
    for bus in inner.buses.values_mut() {
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
    tear_down_all_engines(&mut inner);
    for bus in inner.buses.values_mut() {
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
    ensure_input_source(&device_id)?;
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

    // Removing a phone input also ends its pairing session so the phone
    // disconnects rather than lingering as an orphaned, routable-again source.
    // Keep its persisted trust — this is a disconnect, not a revoke.
    if let InputSourceSpec::RemotePhone { session_id } = InputSourceSpec::parse(&device_id) {
        net::session::remove(&session_id, "disconnected");
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

// ── Recording ─────────────────────────────────────────────────────────────────

/// Resolve target engine + callback tap kind + WAV header info for a spec.
/// Internal helper — called by every start_* path below.
fn resolve_tap(
    inner: &AppInner,
    spec: &TapSpec,
) -> Result<
    (
        BusId,
        CallbackTapKind,
        u16,
        u32,
        std::sync::mpsc::Sender<recorder::TapCommand>,
    ),
    EngineError,
> {
    match spec {
        TapSpec::BusOut { bus_id } => {
            let bus = inner.buses.get(bus_id).ok_or_else(|| EngineError {
                message: format!("Unknown bus: {bus_id:?}"),
            })?;
            let engine = bus.engine.as_ref().ok_or_else(|| EngineError {
                message: format!(
                    "Bus {bus_id:?} is not running. Enable a routed input first."
                ),
            })?;
            Ok((
                *bus_id,
                CallbackTapKind::BusOut,
                engine.out_channels,
                engine.sample_rate,
                engine.tap_command_tx.clone(),
            ))
        }
        TapSpec::InputPost { device_id, bus_id } => {
            let bus = inner.buses.get(bus_id).ok_or_else(|| EngineError {
                message: format!("Unknown bus: {bus_id:?}"),
            })?;
            let engine = bus.engine.as_ref().ok_or_else(|| EngineError {
                message: format!("Bus {bus_id:?} is not running"),
            })?;
            let (idx, channels) = engine.input_index(device_id).ok_or_else(|| EngineError {
                message: format!(
                    "Input '{device_id}' is not active on bus {bus_id:?}"
                ),
            })?;
            Ok((
                *bus_id,
                CallbackTapKind::InputPost {
                    input_index: idx,
                    channels: channels as usize,
                },
                channels,
                engine.sample_rate,
                engine.tap_command_tx.clone(),
            ))
        }
        TapSpec::InputPre { device_id } => {
            // Pick the first running engine that has this input. Multiple
            // engines may carry the same device — they're independent CPAL
            // streams, but pre-gain samples are equivalent.
            for (bus_id, bus) in inner.buses.iter() {
                if let Some(engine) = bus.engine.as_ref() {
                    if let Some((idx, channels)) = engine.input_index(device_id) {
                        return Ok((
                            *bus_id,
                            CallbackTapKind::InputPre {
                                input_index: idx,
                                channels: channels as usize,
                            },
                            channels,
                            engine.sample_rate,
                            engine.tap_command_tx.clone(),
                        ));
                    }
                }
            }
            Err(EngineError {
                message: format!(
                    "Input '{device_id}' is not active on any running bus"
                ),
            })
        }
    }
}

fn start_recording_inner(
    inner: &mut AppInner,
    recordings_dir: &std::path::Path,
    session_subdir: Option<&str>,
    spec: TapSpec,
) -> Result<RecordingInfo, EngineError> {
    let (engine_bus, kind, channels, sample_rate, tap_tx) = resolve_tap(inner, &spec)?;
    let handle = recorder::start_recorder(StartRecorderRequest {
        spec: spec.clone(),
        kind,
        channels,
        sample_rate,
        engine_bus,
        engine_tap_tx: &tap_tx,
        recordings_dir,
        session_subdir,
    })?;
    let info = handle.info();
    inner.recorders.insert(handle.id.clone(), handle);
    Ok(info)
}

#[tauri::command]
fn start_recording(
    state: tauri::State<AppState>,
    app: tauri::AppHandle,
    spec: TapSpec,
) -> Result<RecordingInfo, EngineError> {
    let recordings_dir = resolve_recordings_dir(&app)?;
    let mut inner = state.inner.lock().unwrap();
    let result = start_recording_inner(&mut inner, &recordings_dir, None, spec);
    if let Err(err) = &result {
        inner.last_error = Some(err.message.clone());
    }
    result
}

#[tauri::command]
fn start_master_recording(
    state: tauri::State<AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<RecordingInfo>, EngineError> {
    let recordings_dir = resolve_recordings_dir(&app)?;
    let mut inner = state.inner.lock().unwrap();
    let running_buses: Vec<BusId> = inner
        .buses
        .iter()
        .filter(|(_, bus)| bus.engine.is_some())
        .map(|(id, _)| *id)
        .collect();
    if running_buses.is_empty() {
        return Err(new_last_error(
            &mut inner,
            "Master record: no buses are running.",
        ));
    }
    let session = format!(
        "master_{}",
        chrono::Local::now().format("%Y-%m-%d_%H%M%S")
    );
    let mut out = Vec::with_capacity(running_buses.len());
    for bus_id in running_buses {
        match start_recording_inner(
            &mut inner,
            &recordings_dir,
            Some(&session),
            TapSpec::BusOut { bus_id },
        ) {
            Ok(info) => out.push(info),
            Err(err) => {
                inner.last_error = Some(err.message.clone());
            }
        }
    }
    if out.is_empty() {
        return Err(EngineError {
            message: "Master record: no buses could be tapped.".to_string(),
        });
    }
    Ok(out)
}

#[tauri::command]
fn stop_recording(
    state: tauri::State<AppState>,
    id: String,
) -> Result<RecordingInfo, EngineError> {
    let mut inner = state.inner.lock().unwrap();
    let handle = inner.recorders.remove(&id).ok_or_else(|| EngineError {
        message: format!("Recording '{id}' not found"),
    })?;
    Ok(handle.stop())
}

#[tauri::command]
fn stop_all_recordings(state: tauri::State<AppState>) -> Vec<RecordingInfo> {
    let mut inner = state.inner.lock().unwrap();
    let ids: Vec<String> = inner.recorders.keys().cloned().collect();
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(handle) = inner.recorders.remove(&id) {
            out.push(handle.stop());
        }
    }
    out
}

#[tauri::command]
fn list_active_recordings(state: tauri::State<AppState>) -> Vec<RecordingInfo> {
    let inner = state.inner.lock().unwrap();
    inner.recorders.values().map(|h| h.info()).collect()
}

#[tauri::command]
fn list_recording_files(
    app: tauri::AppHandle,
) -> Result<Vec<RecordingFile>, EngineError> {
    let dir = resolve_recordings_dir(&app)?;
    recorder::list_recording_files(&dir)
}

#[tauri::command]
fn get_recordings_dir(app: tauri::AppHandle) -> Result<String, EngineError> {
    let dir = resolve_recordings_dir(&app)?;
    Ok(dir.display().to_string())
}

#[tauri::command]
fn set_recordings_dir(
    app: tauri::AppHandle,
    path: String,
) -> Result<String, EngineError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(EngineError {
            message: "Recordings directory cannot be empty".to_string(),
        });
    }
    let dir = PathBuf::from(trimmed);
    std::fs::create_dir_all(&dir).map_err(|e| EngineError {
        message: format!("Failed to create '{}': {e}", dir.display()),
    })?;
    let base = app_local_dir(&app)?;
    let mut settings = RecorderSettings::load_or_default(&base);
    settings.recordings_dir = dir.clone();
    settings.save(&base)?;
    Ok(dir.display().to_string())
}

#[tauri::command]
fn delete_recording_file(path: String) -> Result<(), EngineError> {
    let p = PathBuf::from(path);
    recorder::delete_recording_file(&p)
}

#[tauri::command]
fn open_recordings_folder(app: tauri::AppHandle) -> Result<(), EngineError> {
    let dir = resolve_recordings_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| EngineError {
        message: format!("Failed to create '{}': {e}", dir.display()),
    })?;
    app.opener()
        .open_path(dir.display().to_string(), None::<&str>)
        .map_err(|e| EngineError {
            message: format!("Failed to open recordings folder: {e}"),
        })
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
            recorders: BTreeMap::new(),
            last_error: Some("stale".to_string()),
        };

        apply_preset_state(&mut inner, &preset).unwrap();
        assert!(inner.buses.values().all(|bus| bus.engine.is_none()));
        assert!(legacy_routes(&inner).iter().all(|route| !route.active));
        assert!(inner.last_error.is_none());
    }
}

// ── Phone Wireless Audio (#39-#45) ────────────────────────────────────────────
// Pairing/session commands for the LAN phone client. Media (WebRTC) and the
// mixer-side remote input land in later phases; see docs/phone/architecture.md.

/// Payload returned by `phone_create_session`. The URL carries the pairing
/// token in its fragment — render it as a QR code, never log it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PhoneSessionCreated {
    id: String,
    label: String,
    port: u16,
    /// Pairing URL per LAN interface, primary first.
    urls: Vec<String>,
}

#[tauri::command]
fn phone_server_status() -> net::PhoneServerStatus {
    net::server_status()
}

#[tauri::command]
fn phone_create_session(
    app: tauri::AppHandle,
    label: Option<String>,
) -> Result<PhoneSessionCreated, EngineError> {
    let data_dir = app_local_dir(&app)?;
    let port = net::ensure_server(&data_dir).map_err(|message| EngineError { message })?;
    let (id, token) = net::session::create_session(label);
    let urls: Vec<String> = net::lan_ips()
        .iter()
        .map(|ip| net::pairing_url(ip, port, &id, &token))
        .collect();
    let status = net::session::status(&id).ok_or_else(|| EngineError {
        message: "session vanished after creation".to_string(),
    })?;
    Ok(PhoneSessionCreated {
        id,
        label: status.label,
        port,
        urls,
    })
}

#[tauri::command]
fn phone_list_sessions() -> Vec<net::session::PhoneSessionStatus> {
    net::session::list()
}

#[tauri::command]
fn phone_accept_client(
    state: tauri::State<AppState>,
    session_id: String,
) -> Result<(), EngineError> {
    let persisted =
        net::session::accept(&session_id).map_err(|message| EngineError { message })?;
    // Surface the phone as a normal mixer input. Adding it to the graph does not
    // route it anywhere (no sends yet), so no bus rebuild is needed — the user
    // wires it to buses like any other input. Done even when persistence failed,
    // so the phone is usable this session.
    let device_id = format!("{}{session_id}", audio::source::PHONE_PREFIX);
    {
        let mut inner = state.inner.lock().unwrap();
        if !inner.graph.list_inputs().iter().any(|c| c.device_id == device_id) {
            inner.graph.add_input(&device_id);
        }
    }
    // Trust could not be saved (corrupt store / disk error): the phone works now
    // but won't auto-reconnect after a restart — surface it rather than implying
    // a durable pairing.
    if !persisted {
        return Err(EngineError {
            message: "Phone connected, but it could not be saved as a trusted device \
                      (storage error); it will not auto-reconnect after a restart."
                .to_string(),
        });
    }
    Ok(())
}

#[tauri::command]
fn phone_reject_client(session_id: String) -> Result<(), EngineError> {
    net::session::reject(&session_id, "user-declined").map_err(|message| EngineError { message })
}

/// Disconnect a phone WITHOUT revoking persisted trust: end the live session
/// (pushes `bye`) and drop its mixer input. The device stays paired and can
/// auto-reconnect — this is "close this connection", used by the live "Phones"
/// list and by the pairing sheet when it discards an old QR session. Deliberately
/// does NOT call paired::forget (see phone_remove_session: that command is reused
/// for QR refresh, so forgetting here would silently distrust an accepted phone).
fn disconnect_phone(
    state: &tauri::State<AppState>,
    session_id: &str,
    bye_reason: &str,
) -> Result<(), EngineError> {
    net::session::remove(session_id, bye_reason);
    let device_id = format!("{}{session_id}", audio::source::PHONE_PREFIX);
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
    if inner.graph.remove_input(&device_id) {
        for bus_id in affected {
            if let Err(err) = rebuild_bus(&mut inner, bus_id) {
                return Err(store_last_error(&mut inner, err));
            }
        }
    }
    Ok(())
}

/// Revoke a device's persisted trust AND disconnect it (the "Paired devices →
/// Remove" / kick action). forget-before-remove: revoke the store entry BEFORE
/// dropping the live session, else a reconnect in the gap could auto-resume from
/// the still-present entry and defeat the kick. A non-durable revoke (disk write
/// failed) is surfaced AFTER the live kick — the device is gone this session but
/// could resurrect from the stale file on next launch, so the caller must see it.
fn revoke_phone(
    state: &tauri::State<AppState>,
    session_id: &str,
) -> Result<(), EngineError> {
    let durable = net::paired::forget(session_id);
    // Kick: "session-removed" tells the phone to clear its saved creds (a plain
    // disconnect uses "disconnected" and keeps trust).
    let disconnected = disconnect_phone(state, session_id, "session-removed");
    // Surface a non-durable revoke FIRST — it is the security-relevant signal
    // (the device could resurrect from a stale store file) and must not be
    // swallowed if the disconnect's graph rebuild happens to error.
    durable.map_err(|message| EngineError { message })?;
    disconnected
}

/// Disconnect a phone session (live "Phones" list / QR refresh). Keeps the
/// device paired — to revoke trust, use phone_forget.
#[tauri::command]
fn phone_remove_session(
    state: tauri::State<AppState>,
    session_id: String,
) -> Result<(), EngineError> {
    // Plain disconnect: keep trust, transient reason so the phone does NOT wipe
    // its saved creds (it can auto-reconnect later).
    disconnect_phone(&state, &session_id, "disconnected")
}

/// The persisted trusted devices for the "Paired devices" management list.
/// Never includes the token/digest.
#[tauri::command]
fn phone_list_paired() -> Vec<net::paired::PairedDeviceStatus> {
    net::paired::list()
}

/// Revoke a device from the "Paired devices" list: delete persisted trust so it
/// cannot auto-reconnect, end any live session (pushes `bye`), and drop its
/// mixer input. forget-before-remove, same as phone_remove_session.
#[tauri::command]
fn phone_forget(
    state: tauri::State<AppState>,
    session_id: String,
) -> Result<(), EngineError> {
    revoke_phone(&state, &session_id)
}

/// Whether boot-time autostart of the phone server is enabled (opt-in, default
/// false). The UI ("Paired devices") reads this to render the toggle.
#[tauri::command]
fn phone_get_autostart(app: tauri::AppHandle) -> Result<bool, EngineError> {
    let dir = app_local_dir(&app)?;
    Ok(net::PhoneSettings::load_or_default(&dir).autostart)
}

/// Enable/disable bringing the phone server up at app launch so trusted phones
/// can reconnect without opening the pairing sheet. Persisted; takes effect on
/// next launch. Additive — does not touch the current session's server.
#[tauri::command]
fn phone_set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), EngineError> {
    let dir = app_local_dir(&app)?;
    let mut settings = net::PhoneSettings::load_or_default(&dir);
    settings.autostart = enabled;
    settings.save(&dir).map_err(|message| EngineError { message })
}

/// Set a phone session's latency mode ("fastest" | "balanced" | "stable"). The
/// jitter feeder picks the new target depth live — no reconnect needed.
#[tauri::command]
fn phone_set_latency_mode(session_id: String, mode: String) -> Result<(), EngineError> {
    let parsed = net::jitter::LatencyMode::from_str(&mode).ok_or_else(|| EngineError {
        message: format!("unknown latency mode: {mode}"),
    })?;
    if net::session::set_latency(&session_id, parsed) {
        Ok(())
    } else {
        Err(EngineError {
            message: "unknown session".to_string(),
        })
    }
}

// ── Tauri entry point ─────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new())
        .setup(|app| {
            // pairing-v2 #1 (Phase 2): when a trusted phone auto-resumes, re-add
            // its mixer-graph input (the graph was reset on restart). The net
            // layer fires this hook; only the app side can reach AppState's graph.
            // Mirrors phone_accept_client — a silent passive feed until routed.
            let resume_handle = app.handle().clone();
            net::set_resume_hook(Box::new(move |session_id: &str| {
                let device_id = format!("{}{session_id}", audio::source::PHONE_PREFIX);
                let state = resume_handle.state::<AppState>();
                let mut inner = state.inner.lock().unwrap();
                if !inner
                    .graph
                    .list_inputs()
                    .iter()
                    .any(|c| c.device_id == device_id)
                {
                    inner.graph.add_input(&device_id);
                }
            }));

            // pairing-v2 #1: load the persisted trusted-device store so a
            // returning phone can auto-reconnect (Phase 2 consumes it).
            // Panic-free by contract — any failure leaves an empty store and the
            // app still launches with default QR pairing intact.
            if let Ok(dir) = app.path().app_local_data_dir() {
                net::paired::init(dir.join(net::paired::STORE_FILE_NAME));
                // Periodically flush in-memory last_seen bumps and prune expired
                // devices, off the async runtime. The store file inherits the
                // per-user %LOCALAPPDATA% ACL (same as the TLS key beside it) — no
                // world-readable exposure, no custom DACL needed.
                net::paired::spawn_maintenance();
                // Opt-in (default false): only when the user has enabled
                // autostart AND we authoritatively loaded a non-empty trusted
                // store do we bring the LAN server up at boot. Otherwise this is
                // a no-op and boot is byte-for-byte the current MVP. The
                // on-demand ensure_server (pairing sheet) is unchanged and
                // idempotent, so the two coexist.
                if net::PhoneSettings::load_or_default(&dir).autostart
                    && net::paired::has_trusted_devices()
                {
                    if let Err(e) = net::ensure_server(&dir) {
                        eprintln!("[phone] boot autostart failed: {e}");
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_input_devices,
            list_output_devices,
            list_audio_sessions,
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
            start_recording,
            start_master_recording,
            stop_recording,
            stop_all_recordings,
            list_active_recordings,
            list_recording_files,
            get_recordings_dir,
            set_recordings_dir,
            delete_recording_file,
            open_recordings_folder,
            amvc::query_amvc_helper,
            amvc::launch_amvc_installer,
            phone_server_status,
            phone_create_session,
            phone_list_sessions,
            phone_accept_client,
            phone_reject_client,
            phone_remove_session,
            phone_set_latency_mode,
            phone_list_paired,
            phone_forget,
            phone_get_autostart,
            phone_set_autostart,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // Persist any last_seen bumps still only in RAM — a short run
                // that reconnected but quit before the 5-min maintenance flush.
                net::paired::flush_if_dirty();
            }
        });
}
