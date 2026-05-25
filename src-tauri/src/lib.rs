mod audio;
mod state;

use audio::devices::{DeviceInfo, DeviceListError};
use audio::passthrough::EngineError;
use state::AppState;

#[tauri::command]
fn list_input_devices() -> Result<Vec<DeviceInfo>, DeviceListError> {
    audio::devices::list_input_devices()
}

#[tauri::command]
fn list_output_devices() -> Result<Vec<DeviceInfo>, DeviceListError> {
    audio::devices::list_output_devices()
}

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
    let mut guard = state.engine.lock().unwrap();
    // Drop existing engine first — releases device handles before opening new ones.
    *guard = None;
    let engine = audio::passthrough::start(&input_id, &output_id)?;
    *guard = Some(engine);
    Ok(())
}

#[tauri::command]
fn stop_passthrough(state: tauri::State<AppState>) -> Result<(), EngineError> {
    let mut guard = state.engine.lock().unwrap();
    *guard = None;
    Ok(())
}

#[tauri::command]
fn get_passthrough_status(state: tauri::State<AppState>) -> PassthroughStatus {
    let guard = state.engine.lock().unwrap();
    match guard.as_ref() {
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
