mod audio;
mod state;

use audio::devices::{DeviceInfo, DeviceListError};
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
// These commands now sync route state so the routes list stays consistent
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
    // Stop any existing engine; clear all active flags.
    inner.engine = None;
    for r in inner.routes.iter_mut() {
        r.active = false;
        r.enabled = false;
    }
    // Start the new engine.
    let engine = audio::passthrough::start(&input_id, &output_id)?;
    inner.engine = Some(engine);
    // Upsert route to keep the list consistent.
    upsert_route(&mut inner.routes, &input_id, &output_id, true, true);
    Ok(())
}

#[tauri::command]
fn stop_passthrough(state: tauri::State<AppState>) -> Result<(), EngineError> {
    let mut inner = state.inner.lock().unwrap();
    inner.engine = None;
    for r in inner.routes.iter_mut() {
        r.active = false;
        r.enabled = false;
    }
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

// ── Phase 2 routing commands ──────────────────────────────────────────────────

#[tauri::command]
fn get_routes(state: tauri::State<AppState>) -> Vec<Route> {
    state.inner.lock().unwrap().routes.clone()
}

/// Enable or disable a single route.
///
/// Rules:
/// - At most one route may be active (engine running) at a time.
/// - Enabling a route when a *different* route is active returns an error.
/// - Enabling an already-active route is a no-op (returns current routes).
/// - Disabling stops the engine if this route was active.
/// - Routes are upserted into the routes list; they persist until clear_routes.
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
        // Conflict check: another route in the list is active.
        let route_conflict = inner
            .routes
            .iter()
            .any(|r| r.active && !r.matches(&input_id, &output_id));

        // Conflict check: engine is running a route not tracked in the list
        // (e.g., started via the old start_passthrough command).
        let engine_conflict = inner.engine.as_ref().map_or(false, |e| {
            !(e.input_device_name == input_id && e.output_device_name == output_id)
        });

        if route_conflict || engine_conflict {
            return Err(EngineError {
                message: "Phase 2 supports only one active route. \
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

        upsert_route(&mut inner.routes, &input_id, &output_id, true, true);
    } else {
        // Disabling: stop engine if this route was the active one.
        let was_active = inner
            .routes
            .iter()
            .any(|r| r.matches(&input_id, &output_id) && r.active);

        let engine_was_this = inner.engine.as_ref().map_or(false, |e| {
            e.input_device_name == input_id && e.output_device_name == output_id
        });

        if was_active || engine_was_this {
            inner.engine = None;
        }

        upsert_route(&mut inner.routes, &input_id, &output_id, false, false);
    }

    Ok(inner.routes.clone())
}

/// Stop all routes and clear the routes list.
#[tauri::command]
fn clear_routes(state: tauri::State<AppState>) -> Result<(), EngineError> {
    let mut inner = state.inner.lock().unwrap();
    inner.engine = None;
    inner.routes.clear();
    Ok(())
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn upsert_route(
    routes: &mut Vec<Route>,
    input_id: &str,
    output_id: &str,
    enabled: bool,
    active: bool,
) {
    match routes.iter_mut().find(|r| r.matches(input_id, output_id)) {
        Some(r) => {
            r.enabled = enabled;
            r.active = active;
        }
        None => {
            let mut route = Route::new(input_id, output_id);
            route.enabled = enabled;
            route.active = active;
            routes.push(route);
        }
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
            get_routes,
            set_route,
            clear_routes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
