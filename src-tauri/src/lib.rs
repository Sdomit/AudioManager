mod audio;
mod state;

use audio::devices::{DeviceInfo, DeviceListError};
use audio::graph::RouteState;
use audio::mixer::{EngineError, MixerInput};
use audio::routing::Route;
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

/// Stop the running engine and restart with all Active inputs for output_id.
/// Caller must have already updated graph state before calling.
fn rebuild_mixer(inner: &mut AppInner, output_id: &str) -> Result<(), EngineError> {
    inner.engine = None;
    let active = inner.graph.active_inputs_for_output(output_id);
    if active.is_empty() {
        return Ok(());
    }
    let mixer_inputs: Vec<MixerInput> = active
        .into_iter()
        .map(|(name, vol, muted)| MixerInput { device_name: name, gain: vol, muted })
        .collect();
    inner.engine = Some(audio::mixer::start(output_id, &mixer_inputs)?);
    Ok(())
}

// ── Phase 1 passthrough (thin wrapper over MixerEngine, kept for compatibility) ─

#[derive(serde::Serialize)]
struct PassthroughStatus {
    running: bool,
    input_device: Option<String>,
    output_device: Option<String>,
}

#[tauri::command]
fn start_passthrough(
    state: tauri::State<AppState>,
    input_id: String,
    output_id: String,
) -> Result<(), EngineError> {
    let mut inner = state.inner.lock().unwrap();
    inner.engine = None;
    inner.graph.deactivate_all();
    let engine = audio::mixer::start(
        &output_id,
        &[MixerInput { device_name: input_id.clone(), gain: 1.0, muted: false }],
    )?;
    inner.engine = Some(engine);
    inner.graph.upsert_route(&input_id, &output_id, RouteState::Active);
    Ok(())
}

#[tauri::command]
fn stop_passthrough(state: tauri::State<AppState>) -> Result<(), EngineError> {
    let mut inner = state.inner.lock().unwrap();
    inner.engine = None;
    inner.graph.deactivate_all();
    Ok(())
}

#[tauri::command]
fn get_passthrough_status(state: tauri::State<AppState>) -> PassthroughStatus {
    let inner = state.inner.lock().unwrap();
    match inner.engine.as_ref() {
        Some(e) => PassthroughStatus {
            running: true,
            input_device: e.inputs.first().map(|i| i.device_name.clone()),
            output_device: Some(e.output_device_name.clone()),
        },
        None => {
            PassthroughStatus { running: false, input_device: None, output_device: None }
        }
    }
}

// ── Phase 4 routing commands ──────────────────────────────────────────────────

#[tauri::command]
fn get_routes(state: tauri::State<AppState>) -> Vec<Route> {
    state.inner.lock().unwrap().graph.to_routes()
}

/// Enable or disable a single route.
///
/// Phase 4 rules:
/// - All Active routes must share the same output device (one output bus).
/// - Enabling a route to a different output than the currently active bus returns an error.
/// - Enabling a route rebuilds the mixer with all currently Active inputs + this one.
/// - Disabling a route rebuilds the mixer with remaining Active inputs.
/// - Disabling the last Active input stops the engine.
/// - Volume and mute are preserved across enable/disable cycles.
#[tauri::command]
fn set_route(
    state: tauri::State<AppState>,
    input_id: String,
    output_id: String,
    enabled: bool,
) -> Result<Vec<Route>, EngineError> {
    let mut inner = state.inner.lock().unwrap();

    if enabled {
        // Reject if a different output bus is already active.
        if let Some(active_out) = inner.graph.active_output() {
            if active_out != output_id {
                return Err(EngineError {
                    message: "Phase 4 supports one output bus. \
                              Stop the current output before enabling another."
                        .to_string(),
                });
            }
        }
        // Also check engine directly (e.g. set via start_passthrough).
        if let Some(eng) = &inner.engine {
            if eng.output_device_name != output_id {
                return Err(EngineError {
                    message: "Phase 4 supports one output bus. \
                              Stop the current output before enabling another."
                        .to_string(),
                });
            }
        }

        inner.graph.upsert_route(&input_id, &output_id, RouteState::Active);
        rebuild_mixer(&mut inner, &output_id)?;
    } else {
        inner.graph.upsert_route(&input_id, &output_id, RouteState::Disabled);
        rebuild_mixer(&mut inner, &output_id)?;
    }

    Ok(inner.graph.to_routes())
}

/// Stop all routes and clear the graph.
#[tauri::command]
fn clear_routes(state: tauri::State<AppState>) -> Result<(), EngineError> {
    let mut inner = state.inner.lock().unwrap();
    inner.engine = None;
    inner.graph.clear();
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
        return Err(EngineError {
            message: format!("Route not found: {input_id} → {output_id}"),
        });
    }

    // Atomic update — only when the running engine is on the same output bus.
    // A different-output engine must not have its slots modified here.
    if let Some(engine) = &inner.engine {
        if engine.is_output_device(&output_id) {
            engine.update_gain(&input_id, volume, muted);
        }
    }

    Ok(inner.graph.to_routes())
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
            get_routes,
            set_route,
            clear_routes,
            set_route_gain,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
