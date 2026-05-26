mod audio;
mod state;

use audio::devices::{DeviceInfo, DeviceListError};
use audio::graph::RouteState;
use audio::passthrough::EngineError;
use audio::routing::Route;
use state::AppState;

// ── Device enumeration ────────────────────────────────────────────────────────

#[tauri::command]
fn list_input_devices() -> Result<Vec<DeviceInfo>, DeviceListError> {
    audio::devices::list_input_devices()
}

#[tauri::command]
fn list_output_devices() -> Result<Vec<DeviceInfo>, DeviceListError> {
    audio::devices::list_output_devices()
}

// ── Phase 1 passthrough (kept for backward compatibility) ─────────────────────
//
// These commands now sync graph state so the routes list stays consistent
// whether the caller uses the old direct API or the new set_route API.

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
    // Stop any existing engine; deactivate all graph routes.
    inner.engine = None;
    inner.graph.deactivate_all();
    // Start the new engine.
    let engine = audio::passthrough::start(&input_id, &output_id)?;
    inner.engine = Some(engine);
    // Upsert route as Active to keep the graph consistent.
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
            input_device: Some(e.input_device_name.clone()),
            output_device: Some(e.output_device_name.clone()),
        },
        None => PassthroughStatus {
            running: false,
            input_device: None,
            output_device: None,
        },
    }
}

// ── Phase 3 routing commands ──────────────────────────────────────────────────

#[tauri::command]
fn get_routes(state: tauri::State<AppState>) -> Vec<Route> {
    state.inner.lock().unwrap().graph.to_routes()
}

/// Enable or disable a single route.
///
/// Rules:
/// - At most one route may be active (engine running) at a time.
/// - Enabling a route when a *different* route is active returns an error.
/// - Enabling an already-active route is a no-op (returns current routes).
/// - Disabling stops the engine if this route was active.
/// - Routes are upserted into the graph; they persist until clear_routes.
///
/// Returns the full updated routes list so the frontend stays in sync.
#[tauri::command]
fn set_route(
    state: tauri::State<AppState>,
    input_id: String,
    output_id: String,
    enabled: bool,
) -> Result<Vec<Route>, EngineError> {
    let mut inner = state.inner.lock().unwrap();

    if enabled {
        // Conflict check: another route in the graph is Active.
        let route_conflict = inner.graph.has_other_active_route(&input_id, &output_id);

        // Conflict check: engine is running a route not yet reflected in the
        // graph (e.g., started via the legacy start_passthrough command).
        let engine_conflict = inner.engine.as_ref().map_or(false, |e| {
            !(e.input_device_name == input_id && e.output_device_name == output_id)
        });

        if route_conflict || engine_conflict {
            return Err(EngineError {
                message: "Phase 3 still supports only one active audio route. \
                          Stop the current route first."
                    .to_string(),
            });
        }

        // Already running this exact route — no-op.
        let already_active = inner.engine.as_ref().map_or(false, |e| {
            e.input_device_name == input_id && e.output_device_name == output_id
        });

        if !already_active {
            // Drop old engine (joins thread, releases device handles).
            inner.engine = None;
            let engine = audio::passthrough::start(&input_id, &output_id)?;
            inner.engine = Some(engine);
        }

        inner.graph.upsert_route(&input_id, &output_id, RouteState::Active);
    } else {
        // Disabling: stop engine if this route was the active one.
        let was_active = inner.graph.find_route_state(&input_id, &output_id)
            == Some(&RouteState::Active);

        let engine_was_this = inner.engine.as_ref().map_or(false, |e| {
            e.input_device_name == input_id && e.output_device_name == output_id
        });

        if was_active || engine_was_this {
            inner.engine = None;
        }

        inner.graph.upsert_route(&input_id, &output_id, RouteState::Disabled);
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
