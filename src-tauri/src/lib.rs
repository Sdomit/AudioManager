mod audio;
mod presets;
mod state;

use audio::bus::{BusConfig, BusId, BusStatus};
use audio::devices::{DeviceInfo, DeviceListError};
use audio::graph::RouteState;
use audio::mixer::{EngineError, MixerInput};
use audio::routing::Route;
use presets::{PresetLoadResult, PresetLoadWarning, PresetRouteV1, PresetSummary};
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

/// Stop the engine for `bus_id` and restart it from current graph state.
///
/// Phase 8A: a bus runs only when all of these are true:
///   * `config.enabled`
///   * `config.output_device_id` is `Some(_)`
///   * The graph has at least one Active route to that device.
///
/// Errors set `bus.last_error` on the failing bus and bubble up. Other buses
/// are not touched.
fn rebuild_bus(inner: &mut AppInner, bus_id: BusId) -> Result<(), EngineError> {
    let (enabled, output_id, bus_vol, bus_muted) = {
        let bus = inner.buses.get_mut(&bus_id).ok_or_else(|| EngineError {
            message: format!("Unknown bus: {bus_id:?}"),
        })?;
        // Drop any prior engine before potentially starting a new one. Drop
        // joins the audio thread synchronously so WASAPI handles are released
        // before we attempt to reopen the same device below.
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
    let output_id = match output_id {
        Some(id) => id,
        None => return Ok(()),
    };

    let active = inner.graph.active_inputs_for_output(&output_id);
    if active.is_empty() {
        return Ok(());
    }

    let mixer_inputs: Vec<MixerInput> = active
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

/// True when bus A1's currently-assigned output device matches `output_id`.
/// Used by the Phase 8A compatibility shim: legacy single-bus commands only
/// operate on A1, and reject attempts to route to a different device while A1
/// is already bound elsewhere.
fn a1_accepts(inner: &AppInner, output_id: &str) -> bool {
    inner
        .buses
        .get(&BusId::A1)
        .and_then(|b| b.config.output_device_id.as_deref())
        .map(|dev| dev == output_id)
        .unwrap_or(true) // unassigned → free to bind
}

fn bind_a1_to(inner: &mut AppInner, output_id: &str) {
    if let Some(bus) = inner.buses.get_mut(&BusId::A1) {
        bus.config.output_device_id = Some(output_id.to_string());
        bus.config.enabled = true;
    }
}

fn apply_preset_routes(
    inner: &mut AppInner,
    routes: &[PresetRouteV1],
) -> Result<Vec<Route>, EngineError> {
    // Safe load: never auto-start audio. Tear down every bus engine and clear
    // the graph; user must enable routes manually after loading.
    for bus in inner.buses.values_mut() {
        bus.engine = None;
        bus.last_error = None;
    }
    inner.graph.clear();

    for route in routes {
        let state = if route.enabled { RouteState::Enabled } else { RouteState::Disabled };
        inner.graph.upsert_route(&route.input.id, &route.output.id, state);
        if !inner.graph.set_route_gain(
            &route.input.id,
            &route.output.id,
            route.volume.clamp(0.0, 2.0),
            route.muted,
        ) {
            return Err(EngineError {
                message: format!(
                    "Failed to apply preset route '{} → {}'",
                    route.input.id, route.output.id
                ),
            });
        }
    }

    Ok(inner.graph.to_routes())
}

// ── Phase 1 passthrough (compat: A1 only) ─────────────────────────────────────

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
struct SystemStatus {
    buses: Vec<BusStatus>,
    last_error: Option<String>,
}

#[tauri::command]
fn start_passthrough(
    state: tauri::State<AppState>,
    input_id: String,
    output_id: String,
) -> Result<(), EngineError> {
    let mut inner = state.inner.lock().unwrap();
    // Reset every bus and route — passthrough is exclusive single-bus mode.
    for bus in inner.buses.values_mut() {
        bus.engine = None;
        bus.last_error = None;
    }
    inner.graph.deactivate_all();
    bind_a1_to(&mut inner, &output_id);
    inner.graph.upsert_route(&input_id, &output_id, RouteState::Active);

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
    inner.graph.deactivate_all();
    inner.last_error = None;
    Ok(())
}

#[tauri::command]
fn get_passthrough_status(state: tauri::State<AppState>) -> PassthroughStatus {
    let inner = state.inner.lock().unwrap();
    let a1 = inner.buses.get(&BusId::A1);
    match a1.and_then(|b| b.engine.as_ref()) {
        Some(e) => PassthroughStatus {
            running: true,
            input_device: e.inputs.first().map(|i| i.device_name.clone()),
            output_device: Some(e.output_device_name.clone()),
        },
        None => PassthroughStatus { running: false, input_device: None, output_device: None },
    }
}

/// Legacy alias: returns bus A1's status in the old `EngineStatus` shape.
/// Reads A1's engine meters with reset — calling this in the same polling
/// cycle as `list_buses` will produce zero peaks on whichever call runs second.
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
    let preset = presets::build_preset_from_routes(&name, &inner.graph.to_routes())?;
    let path = presets::preset_file_path(&app, &preset.name)?;
    presets::write_preset_file(&path, &preset)?;
    inner.last_error = None;
    Ok(presets::preset_summary(&preset))
}

#[tauri::command]
fn load_preset(
    state: tauri::State<AppState>,
    app: tauri::AppHandle,
    name: String,
) -> Result<PresetLoadResult, EngineError> {
    let (preset, valid_routes, mut warnings) = presets::load_preset_with_warnings(&app, &name)?;
    let mut inner = state.inner.lock().unwrap();
    let routes = apply_preset_routes(&mut inner, &valid_routes)?;

    warnings.push(PresetLoadWarning {
        code: "safe_load".to_string(),
        message: "Preset loaded in safe mode. Routes are configured only; manually enable routes to start audio."
            .to_string(),
    });

    inner.last_error = None;
    Ok(PresetLoadResult {
        preset: presets::preset_summary(&preset),
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

// ── Phase 4 routing commands (compat: route through A1 only) ──────────────────

#[tauri::command]
fn get_routes(state: tauri::State<AppState>) -> Vec<Route> {
    state.inner.lock().unwrap().graph.to_routes()
}

/// Enable or disable a route. Phase 8A keeps the legacy single-bus contract:
/// every route still funnels through bus A1, so a different output device
/// must not be active on A1 when enabling.
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
        bind_a1_to(&mut inner, &output_id);
        inner.graph.upsert_route(&input_id, &output_id, RouteState::Active);
        if let Err(err) = rebuild_bus(&mut inner, BusId::A1) {
            return Err(store_last_error(&mut inner, err));
        }
    } else {
        inner.graph.upsert_route(&input_id, &output_id, RouteState::Disabled);
        if let Err(err) = rebuild_bus(&mut inner, BusId::A1) {
            return Err(store_last_error(&mut inner, err));
        }
    }

    inner.last_error = None;
    Ok(inner.graph.to_routes())
}

/// Stop all routes on every bus and clear the graph.
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

/// Update per-route gain and mute. Atomic when the route is active — no engine restart.
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

    if !inner.graph.set_route_gain(&input_id, &output_id, volume, muted) {
        return Err(new_last_error(
            &mut inner,
            format!("Route not found: {input_id} → {output_id}"),
        ));
    }

    // Atomic update — only when the running engine is on the same output bus.
    if let Some(bus) = inner.buses.get(&BusId::A1) {
        if let Some(engine) = bus.engine.as_ref() {
            if engine.is_output_device(&output_id) {
                engine.update_gain(&input_id, volume, muted);
            }
        }
    }

    inner.last_error = None;
    Ok(inner.graph.to_routes())
}

// ── Phase 8A bus commands ─────────────────────────────────────────────────────

/// Read the current status of every bus. Side effect: resets per-bus output
/// peak and clip flag (matches the existing meter polling contract). Callers
/// should pick either `list_buses` or `get_engine_status` per polling cycle,
/// not both.
#[tauri::command]
fn list_buses(state: tauri::State<AppState>) -> Vec<BusStatus> {
    let inner = state.inner.lock().unwrap();
    inner.buses.values().map(|b| b.read_status()).collect()
}

#[tauri::command]
fn get_system_status(state: tauri::State<AppState>) -> SystemStatus {
    let inner = state.inner.lock().unwrap();
    SystemStatus {
        buses: inner.buses.values().map(|b| b.read_status()).collect(),
        last_error: inner.last_error.clone(),
    }
}

/// Assign or unassign the output device for a bus. Rebuilds the bus engine
/// so the new device is picked up. Pass `None` to unassign and stop the bus.
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
        // Status still returned so the UI sees the per-bus last_error.
        let bus = inner.buses.get(&bus_id).expect("bus exists");
        return Ok(bus.read_status());
    }
    let bus = inner.buses.get(&bus_id).expect("bus exists");
    Ok(bus.read_status())
}

/// Atomically update a bus's volume/mute. No engine restart when the bus is
/// running. Volume clamped to [0.0, 2.0]; non-finite values fall back to 1.0.
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

/// Enable or disable a bus. Disabling stops the bus engine immediately.
/// Enabling rebuilds the bus, which only starts an engine when a device is
/// assigned AND the graph has at least one active route to that device.
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

/// Rename a bus. Trims whitespace; rejects empty names. Does not touch the
/// engine.
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
