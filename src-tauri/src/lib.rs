mod amvc;
mod amvc_sync;
mod app_settings;
mod audio;
mod net;
mod presets;
mod state;

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

use audio::bus::{BusConfig, BusId, BusRuntime, BusStatus};
use audio::device_watch::{self, DeviceDiff, DeviceSnapshot};
use audio::devices::{DeviceInfo, DeviceListError};
use audio::dsp::{AutomixConfig, AutomixGroupUpdate, BusDspConfig, DspConfig, MAX_AUTOMIX_GROUPS};
use audio::endpoint_ctl;
use audio::graph::InputChannel;
use audio::mixer::{EngineError, MixerEngine, MixerInput};
use audio::recorder::{
    self, CallbackTapKind, RecordFormat, RecorderSettings, RecordingFile, RecordingInfo,
    StartRecorderRequest, TapSpec,
};
use audio::routing::Route;
use audio::source::InputSourceSpec;
use presets::{PresetFileV2, PresetLoadResult, PresetLoadWarning, PresetSummary};
use state::{AppInner, AppState, AutomixGroupDef};

// ── Device enumeration ────────────────────────────────────────────────────────

#[tauri::command]
fn list_input_devices() -> Result<Vec<DeviceInfo>, DeviceListError> {
    audio::devices::list_input_devices()
}

#[tauri::command]
fn list_output_devices() -> Result<Vec<DeviceInfo>, DeviceListError> {
    audio::devices::list_output_devices()
}

// ── OS audio endpoint control (Mini Controller) ───────────────────────────────
// COM-backed: real MMDevice ids, per-endpoint volume/mute, and OS default
// switching. Separate from the cpal enumeration above (cpal ids are names).

#[tauri::command]
fn audio_list_endpoints(
    direction: endpoint_ctl::Direction,
) -> Result<Vec<endpoint_ctl::EndpointInfo>, endpoint_ctl::EndpointError> {
    endpoint_ctl::list_endpoints(direction)
}

#[tauri::command]
fn audio_default_endpoint(
    direction: endpoint_ctl::Direction,
) -> Result<Option<String>, endpoint_ctl::EndpointError> {
    endpoint_ctl::default_endpoint_id(direction)
}

#[tauri::command]
fn audio_set_default_endpoint(id: String) -> Result<(), endpoint_ctl::EndpointError> {
    endpoint_ctl::set_default_endpoint(&id)
}

#[tauri::command]
fn audio_get_endpoint_volume(
    id: String,
) -> Result<endpoint_ctl::EndpointVolume, endpoint_ctl::EndpointError> {
    endpoint_ctl::get_endpoint_volume(&id)
}

#[tauri::command]
fn audio_set_endpoint_volume(id: String, level: f32) -> Result<(), endpoint_ctl::EndpointError> {
    endpoint_ctl::set_endpoint_volume(&id, level)
}

#[tauri::command]
fn audio_set_endpoint_mute(id: String, muted: bool) -> Result<(), endpoint_ctl::EndpointError> {
    endpoint_ctl::set_endpoint_mute(&id, muted)
}

/// The global shortcut the mini controller actually registered after the
/// fallback chain (e.g. "Ctrl+Alt+M"), or None if every candidate was taken.
static MINI_HOTKEY: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// Label of the active mini-controller global shortcut, for the hotkey overlay.
#[tauri::command]
fn get_mini_hotkey() -> Option<String> {
    MINI_HOTKEY.lock().unwrap().clone()
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

/// Resolve the automix groups to per-engine `AutomixGroupUpdate`s: each group's
/// member device ids → this engine's input-slot bitmask. Groups with no member
/// present in this engine are dropped (they don't affect it); the realtime layer
/// caps at [`MAX_AUTOMIX_GROUPS`]. Input slots ≥ 32 can't be masked, but the
/// engine enforces ≤ 8 inputs so that never bites.
///
/// Gating is therefore *per bus*: each bus runs its own engine over only the
/// inputs routed to it, so only members routed to THIS bus enter its mask. A
/// group split across buses gates within each bus independently, and a member
/// sitting alone on a bus stays at unity — there is no cross-bus sharing. The
/// frontend warns when a group's members don't share a common bus (see
/// `automixCoverage.ts`); true cross-engine gating is intentionally not
/// attempted (independent device clocks make it ill-defined).
fn automix_updates_for_engine(
    groups: &[AutomixGroupDef],
    engine: &MixerEngine,
) -> Vec<AutomixGroupUpdate> {
    groups
        .iter()
        .filter_map(|g| {
            let mut mask = 0u32;
            for dev in &g.members {
                if let Some((idx, _)) = engine.input_index(dev) {
                    if idx < 32 {
                        mask |= 1 << idx;
                    }
                }
            }
            if mask == 0 {
                return None;
            }
            Some(AutomixGroupUpdate {
                enabled: g.config.enabled,
                member_mask: mask,
                config: g.config,
            })
        })
        .take(MAX_AUTOMIX_GROUPS)
        .collect()
}

/// Re-resolve and publish automix groups to every running engine. Call after a
/// group definition changes; the per-engine rebuild path publishes on its own.
fn republish_automix_all(inner: &AppInner) {
    for bus in inner.buses.values() {
        if let Some(engine) = bus.engine.as_ref() {
            let updates = automix_updates_for_engine(&inner.automix_groups, engine);
            engine.update_automix(&updates);
        }
    }
}

/// Stop the engine for `bus_id` and restart it from current matrix state.
///
/// A bus runs only when all of these are true:
///   * `config.enabled`
///   * `config.output_device_id` is `Some(_)`
///   * The graph has at least one enabled send to `bus_id`
fn rebuild_bus(inner: &mut AppInner, bus_id: BusId) -> Result<(), EngineError> {
    rebuild_bus_filtered(inner, bus_id, None)
}

/// Read structural bus state without consuming the interval meter/xrun
/// accumulators. Loudness is a rolling snapshot rather than interval telemetry,
/// so it remains available to the slower structural refresh.
fn structural_bus_status(bus: &BusRuntime) -> BusStatus {
    let mut status = bus.status_from_meters(0.0, false);
    if let Some(engine) = bus.engine.as_ref() {
        status.loudness = engine.read_loudness();
    }
    status
}

/// Apply a structural bus setting only if its rebuilt engine can be restored.
/// Rebuilds stop the current engine first, so rollback must also rebuild the
/// previous configuration rather than merely assigning the old fields back.
fn rebuild_bus_with_config_change<F>(
    inner: &mut AppInner,
    bus_id: BusId,
    change: F,
) -> Result<(), EngineError>
where
    F: FnOnce(&mut BusConfig),
{
    let previous = inner
        .buses
        .get(&bus_id)
        .map(|bus| bus.config.clone())
        .ok_or_else(|| EngineError {
            message: format!("Unknown bus: {bus_id:?}"),
        })?;
    change(&mut inner.buses.get_mut(&bus_id).expect("bus exists").config);

    if let Err(err) = rebuild_bus(inner, bus_id) {
        inner.buses.get_mut(&bus_id).expect("bus exists").config = previous;
        let _ = rebuild_bus(inner, bus_id);
        return Err(store_last_error(inner, err));
    }

    inner.last_error = None;
    Ok(())
}

/// Like `rebuild_bus`, but when `available_inputs` is given, inputs absent
/// from the set are silently skipped instead of failing the whole engine
/// start. Used by the hotplug watcher: when an input device unplugs, the
/// bus restarts with the remaining inputs rather than going fully silent.
/// User-driven paths keep `rebuild_bus` (no filter) so a misconfigured
/// input still surfaces "Input device not found" as a hard error.
fn rebuild_bus_filtered(
    inner: &mut AppInner,
    bus_id: BusId,
    available_inputs: Option<&BTreeSet<String>>,
) -> Result<(), EngineError> {
    // Centralized teardown: stops recorders first, then drops the engine
    // so WASAPI handles are released before the restart attempt.
    tear_down_engine(inner, bus_id);
    // Snapshot automix groups before the mutable bus borrow so the new engine
    // can be seeded with resolved group masks without re-borrowing `inner`.
    let automix_groups = inner.automix_groups.clone();
    let (enabled, output_id, bus_vol, bus_muted, bus_dsp, buffer_size_frames) = {
        let bus = inner.buses.get_mut(&bus_id).ok_or_else(|| EngineError {
            message: format!("Unknown bus: {bus_id:?}"),
        })?;
        (
            bus.config.enabled,
            bus.config.output_device_id.clone(),
            bus.config.volume,
            bus.config.muted,
            bus.config.dsp.clone(),
            bus.config.buffer_size_frames,
        )
    };

    if !enabled {
        return Ok(());
    }
    let Some(output_id) = output_id else {
        return Ok(());
    };

    let active_inputs: Vec<(String, f32, bool, DspConfig)> = inner
        .graph
        .effective_inputs_for_bus(bus_id)
        .into_iter()
        .filter(|(name, _, _, _)| available_inputs.map_or(true, |set| set.contains(name)))
        .collect();
    if active_inputs.is_empty() {
        return Ok(());
    }

    let mixer_inputs: Vec<MixerInput> = active_inputs
        .into_iter()
        .map(|(id, vol, muted, dsp)| MixerInput {
            source: InputSourceSpec::parse(&id),
            gain: vol,
            muted,
            dsp,
        })
        .collect();

    match audio::mixer::start(
        &output_id,
        &mixer_inputs,
        bus_vol,
        bus_muted,
        bus_dsp,
        buffer_size_frames,
    ) {
        Ok(engine) => {
            let input_errors: Vec<String> = engine
                .inputs
                .iter()
                .filter_map(|i| {
                    i.error
                        .as_ref()
                        .map(|e| format!("{}: {}", i.device_name, e))
                })
                .collect();
            let live_inputs = engine.inputs.iter().filter(|i| i.error.is_none()).count();
            if live_inputs == 0 && !input_errors.is_empty() {
                // Every input failed — nothing to run. Treat as a bus failure so
                // the UI shows the error and Err-branching callers still see it.
                // `engine` (all-silent) drops here, stopping its thread (#PR31-3).
                let message = input_errors.join("; ");
                let bus = inner.buses.get_mut(&bus_id).expect("bus exists");
                bus.last_error = Some(message.clone());
                return Err(EngineError { message });
            }
            let bus = inner.buses.get_mut(&bus_id).expect("bus exists");
            bus.engine = Some(engine);
            // Seed the fresh engine with the automix groups resolved against its
            // input slots (live sound gate, Feature B). Uses the pre-snapshotted
            // groups so we don't re-borrow `inner` while `bus` is held.
            if let Some(engine) = bus.engine.as_ref() {
                let updates = automix_updates_for_engine(&automix_groups, engine);
                engine.update_automix(&updates);
            }
            // Partial failure: the bus runs its live inputs. Don't set last_error
            // — the frontend maps any last_error to a full "error" status, which
            // would falsely flag a working bus. Log the silent inputs instead.
            if !input_errors.is_empty() {
                eprintln!(
                    "[audio] bus {bus_id:?} started with silent inputs: {}",
                    input_errors.join("; ")
                );
            }
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
                Err(EngineError {
                    message: format!("Input device not found: {name}"),
                })
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

fn apply_preset_state(inner: &mut AppInner, preset: &PresetFileV2) -> Result<(), EngineError> {
    tear_down_all_engines(inner);
    for bus in inner.buses.values_mut() {
        bus.last_error = None;
    }
    inner.graph.clear();

    for bus_preset in &preset.buses {
        let bus = inner
            .buses
            .get_mut(&bus_preset.id)
            .ok_or_else(|| EngineError {
                message: format!("Unknown bus: {:?}", bus_preset.id),
            })?;
        bus.config.name = bus_preset.name.clone();
        bus.config.output_device_id = bus_preset.output.as_ref().map(|output| output.id.clone());
        bus.config.volume = BusConfig::clamp_volume(bus_preset.volume);
        bus.config.muted = bus_preset.muted;
        bus.config.enabled = bus_preset.enabled;
        let mut bus_dsp = bus_preset.dsp.clone();
        bus_dsp.clamp();
        bus.config.dsp = bus_dsp;
        // Clamp the persisted buffer size to the same [32, 8192] range the live
        // command enforces; an out-of-range value falls back to driver default.
        bus.config.buffer_size_frames = bus_preset
            .buffer_size_frames
            .filter(|f| (32..=8192).contains(f));
        bus.last_error = None;
    }

    for input_preset in &preset.inputs {
        if !inner.graph.has_input(&input_preset.device.id) {
            inner.graph.add_input(&input_preset.device.id);
        }

        if !inner.graph.set_input_gain(
            &input_preset.device.id,
            input_preset.gain,
            input_preset.muted,
        ) {
            return Err(EngineError {
                message: format!("Failed to apply preset input '{}'", input_preset.device.id),
            });
        }

        inner
            .graph
            .set_input_dsp(&input_preset.device.id, input_preset.dsp.clone());

        for send in &input_preset.sends {
            if !inner
                .graph
                .set_send(&input_preset.device.id, send.bus_id, send.enabled)
            {
                return Err(EngineError {
                    message: format!(
                        "Failed to apply preset send '{}:{:?}'",
                        input_preset.device.id, send.bus_id
                    ),
                });
            }
            if !inner.graph.set_send_gain(
                &input_preset.device.id,
                send.bus_id,
                send.volume,
                send.muted,
            ) {
                return Err(EngineError {
                    message: format!(
                        "Failed to apply preset send gain '{}:{:?}'",
                        input_preset.device.id, send.bus_id
                    ),
                });
            }
        }
    }

    // Restore automix groups (live sound gate, Feature B). Engines aren't
    // started here (preset load leaves audio stopped), so resolution/publish
    // happens later when each bus is enabled and rebuilt.
    inner.automix_groups = preset.automix_groups.clone();

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
    /// Raw pre-DSP capture peak (mono). Kept for back-compat / aria labels.
    peak: f32,
    /// Post-stereo per-channel peaks (#feature10) — track pan / mono / width.
    peak_l: f32,
    peak_r: f32,
    /// Source channel count (1 = mono → UI renders a single meter bar).
    channels: u16,
}

/// Configuration and lifecycle state that can be polled without consuming
/// interval telemetry. Meter and xrun values belong to [`MeterSnapshot`].
#[derive(serde::Serialize)]
struct SystemSnapshot {
    buses: Vec<BusStatus>,
    inputs: Vec<InputChannel>,
    last_error: Option<String>,
}

/// Interval telemetry. Reading this payload intentionally resets peak and xrun
/// accumulators, so the frontend must have exactly one polling owner.
#[derive(serde::Serialize)]
struct MeterSnapshot {
    buses: Vec<BusMeterSnapshot>,
    input_peaks: Vec<InputPeakStatus>,
}

#[derive(serde::Serialize)]
struct BusMeterSnapshot {
    id: BusId,
    output_peak: f32,
    clipped_recently: bool,
    underruns: u64,
    overruns: u64,
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
        None => PassthroughStatus {
            running: false,
            input_device: None,
            output_device: None,
        },
    }
}

/// Legacy alias: returns bus A1's status in the old `EngineStatus` shape.
#[tauri::command]
fn get_engine_status(state: tauri::State<AppState>) -> EngineStatus {
    let inner = state.inner.lock().unwrap();
    let a1 = inner.buses.get(&BusId::A1);
    match a1.and_then(|b| b.engine.as_ref()) {
        Some(engine) => {
            let (input_meters, output_peak, clipped_recently) = engine.read_and_reset_meters();
            EngineStatus {
                status: "running",
                output_device: Some(engine.output_device_name.clone()),
                active_inputs: engine
                    .inputs
                    .iter()
                    .map(|input| input.device_name.clone())
                    .collect(),
                // Legacy shape exposes only the capture peak.
                input_peaks: input_meters.iter().map(|m| m.capture).collect(),
                output_peak,
                clipped_recently,
                last_error: a1
                    .and_then(|b| b.last_error.clone())
                    .or(inner.last_error.clone()),
            }
        }
        None => {
            let a1_err = a1.and_then(|b| b.last_error.clone());
            let any_err = a1_err.clone().or(inner.last_error.clone());
            EngineStatus {
                status: if any_err.is_some() {
                    "error"
                } else {
                    "stopped"
                },
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
    let preset =
        presets::build_preset_v2(&name, &inner.buses, &inner.graph, &inner.automix_groups)?;
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

    sync_metering_taps(&mut inner);
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

    if !inner
        .graph
        .set_send_gain(&input_id, BusId::A1, volume, muted)
    {
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

/// Reconcile per-device metering taps to the current input set
/// (#feature-idle-meter). Every real cpal-`Device` input gets a lightweight
/// capture so its level meter moves while unrouted; taps for removed inputs are
/// dropped (which stops their capture thread). Loopback / process / phone
/// sources use other backends and are skipped. A tap that fails to open (device
/// absent or non-f32) is logged and left absent — the input just shows no idle
/// level until it is routed or the device returns. Cheap when unchanged: only a
/// genuine add/remove starts or stops a stream.
fn sync_metering_taps(inner: &mut AppInner) {
    let all_inputs: Vec<String> = inner
        .graph
        .list_inputs()
        .into_iter()
        .map(|ch| ch.device_id)
        .collect();
    let desired: BTreeSet<String> = all_inputs
        .iter()
        .filter(|id| matches!(InputSourceSpec::parse(id), InputSourceSpec::Device { .. }))
        .cloned()
        .collect();
    inner.metering_taps.retain(|id, _| desired.contains(id));

    for id in desired {
        if inner.metering_taps.contains_key(&id) {
            continue;
        }
        if let Ok(tap) = crate::audio::metering_tap::start(&id) {
            inner.metering_taps.insert(id, tap);
        }
    }
}

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
    sync_metering_taps(&mut inner);
    inner.last_error = None;
    Ok(inner.graph.list_inputs())
}

#[tauri::command]
fn remove_input(
    state: tauri::State<AppState>,
    device_id: String,
) -> Result<Vec<InputChannel>, EngineError> {
    let mut inner = state.inner.lock().unwrap();
    let mut affected: Vec<BusId> = BusId::ALL
        .into_iter()
        .filter(|bus_id| {
            inner
                .graph
                .get_send(&device_id, *bus_id)
                .map(|send| send.enabled)
                .unwrap_or(false)
        })
        .collect();
    // Monitor preview routes to A1 without an enabled send (#feature1), so A1
    // also needs a rebuild to drop the source from the running monitor engine.
    let monitored = inner
        .graph
        .get_input(&device_id)
        .map(|i| i.monitor)
        .unwrap_or(false);
    if monitored && !affected.contains(&BusId::A1) {
        affected.push(BusId::A1);
    }

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

    sync_metering_taps(&mut inner);
    inner.last_error = None;
    Ok(inner.graph.list_inputs())
}

/// Swap an input's underlying device, preserving gain / mute / sends / DSP /
/// monitor / label (#feature7). The new source is validated before any graph
/// mutation, and an engine-rebuild failure rolls the device id back, so a
/// failed replacement leaves the original input exactly as it was.
#[tauri::command]
fn replace_input(
    state: tauri::State<AppState>,
    old_device_id: String,
    new_device_id: String,
) -> Result<Vec<InputChannel>, EngineError> {
    if old_device_id == new_device_id {
        let inner = state.inner.lock().unwrap();
        return Ok(inner.graph.list_inputs());
    }
    // Validate the replacement source BEFORE mutating the graph.
    ensure_input_source(&new_device_id)?;

    let mut inner = state.inner.lock().unwrap();
    // Buses to rebuild: the input's enabled sends, plus A1 if it is monitored
    // (monitor routes to A1 without an enabled send — see #feature1).
    let mut affected: Vec<BusId> = BusId::ALL
        .into_iter()
        .filter(|bus_id| {
            inner
                .graph
                .get_send(&old_device_id, *bus_id)
                .map(|send| send.enabled)
                .unwrap_or(false)
        })
        .collect();
    let monitored = inner
        .graph
        .get_input(&old_device_id)
        .map(|i| i.monitor)
        .unwrap_or(false);
    if monitored && !affected.contains(&BusId::A1) {
        affected.push(BusId::A1);
    }

    if !inner
        .graph
        .replace_input_device(&old_device_id, &new_device_id)
    {
        return Err(new_last_error(
            &mut inner,
            format!("Cannot replace input '{old_device_id}' with '{new_device_id}'"),
        ));
    }

    for bus_id in &affected {
        if let Err(err) = rebuild_bus(&mut inner, *bus_id) {
            // Roll the device id back and restore the original engines so the
            // failed replacement leaves the input untouched.
            inner
                .graph
                .replace_input_device(&new_device_id, &old_device_id);
            for b in &affected {
                let _ = rebuild_bus(&mut inner, *b);
            }
            return Err(store_last_error(&mut inner, err));
        }
    }

    // If the replaced source was a connected phone, end its session too (mirror
    // remove_input) so the handset stops streaming rather than lingering as an
    // orphaned, still-"connected" background source.
    if let InputSourceSpec::RemotePhone { session_id } = InputSourceSpec::parse(&old_device_id) {
        net::session::remove(&session_id, "disconnected");
    }

    sync_metering_taps(&mut inner);
    inner.last_error = None;
    Ok(inner.graph.list_inputs())
}

/// Set or clear an input's display label (#feature8). Metadata only — no engine
/// rebuild. Pass `None`/blank to revert to the device-derived name.
#[tauri::command]
fn rename_input(
    state: tauri::State<AppState>,
    device_id: String,
    label: Option<String>,
) -> Result<Vec<InputChannel>, EngineError> {
    let mut inner = state.inner.lock().unwrap();
    if !inner.graph.set_label(&device_id, label) {
        return Err(new_last_error(
            &mut inner,
            format!("Input not found: {device_id}"),
        ));
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

/// Set an input's boost/trim multiplier (#feature-boost), clamped to
/// [1.0, 5.0] (100%..500%). Applied on top of the fader as a clean-gain stage
/// for quiet sources. Live: re-pushes the effective gain to every running bus
/// engine via the same lock-free atomic as the fader — no engine restart.
#[tauri::command]
fn set_input_boost(
    state: tauri::State<AppState>,
    device_id: String,
    boost: f32,
) -> Result<Vec<InputChannel>, EngineError> {
    let mut inner = state.inner.lock().unwrap();
    if !inner.graph.set_boost(&device_id, boost) {
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

/// Toggle monitor preview for an input (#feature1): force-route it to the
/// monitor bus (A1) for headphone listening without touching its persisted
/// sends. Idempotent and never duplicates an already-enabled A1 send.
#[tauri::command]
fn set_input_monitor(
    state: tauri::State<AppState>,
    device_id: String,
    enabled: bool,
) -> Result<Vec<InputChannel>, EngineError> {
    let mut inner = state.inner.lock().unwrap();
    let Some(prev) = inner.graph.get_input(&device_id).map(|i| i.monitor) else {
        return Err(new_last_error(
            &mut inner,
            format!("Input not found: {device_id}"),
        ));
    };
    inner.graph.set_monitor(&device_id, enabled);
    // Monitor changes which inputs the A1 engine carries, so rebuild A1 to add
    // or drop the preview tap. Persisted routing for every bus is left as-is.
    if let Err(err) = rebuild_bus(&mut inner, BusId::A1) {
        // Roll the flag back so the graph matches the frontend's optimistic
        // revert — otherwise a later hydrate would re-show the input monitored
        // and re-route it to A1 even though the rebuild failed.
        inner.graph.set_monitor(&device_id, prev);
        return Err(store_last_error(&mut inner, err));
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
    let previous = inner
        .graph
        .get_send(&device_id, bus_id)
        .map(|send| send.enabled)
        .ok_or_else(|| new_last_error(&mut inner, format!("Input not found: {device_id}")))?;
    if !inner.graph.set_send(&device_id, bus_id, enabled) {
        return Err(new_last_error(
            &mut inner,
            format!("Input not found: {device_id}"),
        ));
    }
    if let Err(err) = rebuild_bus(&mut inner, bus_id) {
        // A rebuild tears down the old engine before it attempts the new one.
        // Restore both the graph setting and the prior live engine so a failed
        // optimistic UI update cannot reappear during the next snapshot poll.
        inner.graph.set_send(&device_id, bus_id, previous);
        let _ = rebuild_bus(&mut inner, bus_id);
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
    inner
        .buses
        .values()
        .map(structural_bus_status)
        .collect()
}

#[tauri::command]
fn get_system_snapshot(state: tauri::State<AppState>) -> SystemSnapshot {
    let inner = state.inner.lock().unwrap();

    SystemSnapshot {
        buses: inner
            .buses
            .values()
            .map(structural_bus_status)
            .collect(),
        inputs: inner.graph.list_inputs(),
        last_error: inner.last_error.clone(),
    }
}

#[tauri::command]
fn drain_meter_snapshot(state: tauri::State<AppState>) -> MeterSnapshot {
    let inner = state.inner.lock().unwrap();

    // Per-device meter aggregate (a device may feed more than one bus engine;
    // take the max across them). `channels` comes from the engine's input info.
    #[derive(Default, Clone, Copy)]
    struct DeviceMeterAgg {
        capture: f32,
        peak_l: f32,
        peak_r: f32,
        channels: u16,
    }
    let mut input_peaks_by_device: BTreeMap<String, DeviceMeterAgg> = BTreeMap::new();
    let mut buses = Vec::with_capacity(inner.buses.len());

    for bus in inner.buses.values() {
        let (output_peak, clipped_recently, underruns, overruns) = match bus.engine.as_ref() {
            Some(engine) => {
                let (input_meters, output_peak, clipped_recently) = engine.read_and_reset_meters();
                for (idx, info) in engine.inputs.iter().enumerate() {
                    let m = input_meters.get(idx).copied().unwrap_or_default();
                    let agg = input_peaks_by_device
                        .entry(info.device_name.clone())
                        .or_default();
                    agg.capture = agg.capture.max(m.capture);
                    agg.peak_l = agg.peak_l.max(m.peak_l);
                    agg.peak_r = agg.peak_r.max(m.peak_r);
                    agg.channels = agg.channels.max(info.channels);
                }
                let (un, ov) = engine.read_and_reset_xruns();
                (output_peak, clipped_recently, un, ov)
            }
            None => (0.0, false, 0, 0),
        };
        buses.push(BusMeterSnapshot {
            id: bus.config.id,
            output_peak,
            clipped_recently,
            underruns,
            overruns,
        });
    }

    // Idle-input metering taps (#feature-idle-meter): give an unrouted input a
    // real level. A device already live in an engine keeps that engine's
    // post-DSP meters (authoritative), so the tap only fills in for inputs no
    // running engine is capturing. The tap is drained either way so it never
    // surfaces a stale peak the moment the input goes idle.
    for (device_id, tap) in inner.metering_taps.iter() {
        let m = tap.read_and_reset();
        if input_peaks_by_device.contains_key(device_id) {
            continue;
        }
        let agg = input_peaks_by_device.entry(device_id.clone()).or_default();
        agg.capture = m.capture;
        agg.peak_l = m.peak_l;
        agg.peak_r = m.peak_r;
        agg.channels = m.channels;
    }

    let input_peaks = input_peaks_by_device
        .into_iter()
        .map(|(device_id, a)| InputPeakStatus {
            device_id,
            peak: a.capture,
            peak_l: a.peak_l,
            peak_r: a.peak_r,
            channels: a.channels,
        })
        .collect();

    MeterSnapshot { buses, input_peaks }
}

/// Compatibility alias for integrations that used the original combined
/// command. It is deliberately non-destructive; new callers should use the
/// explicit snapshot commands above.
#[tauri::command]
fn get_system_status(state: tauri::State<AppState>) -> SystemSnapshot {
    get_system_snapshot(state)
}

/// Return the current spectrum magnitude bins (dBFS) for a bus.
/// Returns N_BINS = 1024 values, dc..nyquist. Empty vec when bus not running.
#[tauri::command]
fn get_spectrum_data(state: tauri::State<AppState>, bus_id: BusId) -> Vec<f32> {
    let inner = state.inner.lock().unwrap();
    inner
        .buses
        .get(&bus_id)
        .and_then(|b| b.engine.as_ref())
        .map(|e| e.read_spectrum())
        .unwrap_or_default()
}

#[tauri::command]
fn set_bus_device(
    state: tauri::State<AppState>,
    bus_id: BusId,
    output_device_id: Option<String>,
) -> Result<BusStatus, EngineError> {
    let mut inner = state.inner.lock().unwrap();
    rebuild_bus_with_config_change(&mut inner, bus_id, |config| {
        config.output_device_id = output_device_id;
    })?;
    let bus = inner.buses.get(&bus_id).expect("bus exists");
    Ok(structural_bus_status(bus))
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
    Ok(structural_bus_status(bus))
}

#[tauri::command]
fn set_bus_enabled(
    state: tauri::State<AppState>,
    bus_id: BusId,
    enabled: bool,
) -> Result<BusStatus, EngineError> {
    let mut inner = state.inner.lock().unwrap();
    rebuild_bus_with_config_change(&mut inner, bus_id, |config| {
        config.enabled = enabled;
    })?;
    let bus = inner.buses.get(&bus_id).expect("bus exists");
    Ok(structural_bus_status(bus))
}

#[tauri::command]
fn rename_bus(
    state: tauri::State<AppState>,
    bus_id: BusId,
    name: String,
) -> Result<BusStatus, EngineError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(EngineError {
            message: "Bus name cannot be empty".to_string(),
        });
    }
    let mut inner = state.inner.lock().unwrap();
    let bus = inner.buses.get_mut(&bus_id).ok_or_else(|| EngineError {
        message: format!("Unknown bus: {bus_id:?}"),
    })?;
    bus.config.name = trimmed.to_string();
    Ok(structural_bus_status(bus))
}

/// Set the output callback buffer size in frames. `None` reverts to the driver
/// default. Changes take effect on the next engine start (i.e. this triggers a
/// rebuild when the bus is running). Accepted range: 32–8192 frames (#35).
#[tauri::command]
fn set_bus_buffer_size(
    state: tauri::State<AppState>,
    bus_id: BusId,
    frames: Option<u32>,
) -> Result<BusStatus, EngineError> {
    if let Some(f) = frames {
        if !(32..=8192).contains(&f) {
            return Err(EngineError {
                message: format!("buffer_size_frames must be in [32, 8192], got {f}"),
            });
        }
    }
    let mut inner = state.inner.lock().unwrap();
    rebuild_bus_with_config_change(&mut inner, bus_id, |config| {
        config.buffer_size_frames = frames;
    })?;
    let bus = inner.buses.get(&bus_id).expect("bus exists");
    Ok(structural_bus_status(bus))
}

/// Set a bus's output latency mode (#35) — a named preset over the raw buffer
/// size: Stable = driver default, Low = 256 frames, UltraLow = 128 frames. Sets
/// `buffer_size_frames` accordingly and rebuilds the bus if running.
#[tauri::command]
fn set_bus_latency_mode(
    state: tauri::State<AppState>,
    bus_id: BusId,
    mode: String,
) -> Result<BusStatus, EngineError> {
    let parsed = audio::bus::LatencyMode::parse(&mode).ok_or_else(|| EngineError {
        message: format!("unknown latency mode: {mode}"),
    })?;
    let mut inner = state.inner.lock().unwrap();
    rebuild_bus_with_config_change(&mut inner, bus_id, |config| {
        config.buffer_size_frames = parsed.frames();
    })?;
    let bus = inner.buses.get(&bus_id).expect("bus exists");
    Ok(structural_bus_status(bus))
}

/// Update a running engine's DSP parameters for one input, live. Stores the
/// clamped config in the graph (so rebuild picks it up later) and publishes to
/// the engine's seqlock if the engine is running — the audio callback reloads
/// on the next block without a restart.
///
/// `device_id` is the canonical input id (device name, "sys:default", etc.).
/// Returns an error if `bus_id` or `device_id` is not found.
#[tauri::command]
fn update_input_dsp(
    state: tauri::State<AppState>,
    bus_id: BusId,
    device_id: String,
    config: DspConfig,
) -> Result<(), EngineError> {
    // Clamp once up front so the LIVE seqlock publish gets the same normalized
    // config the graph stores. Critical for `order`: the realtime packer assumes
    // a full 6-stage permutation, so a partial/duplicate order from a caller
    // would otherwise double-run or skip stages. (set_input_dsp re-clamps the
    // stored copy; harmless.)
    let mut config = config;
    config.clamp();
    let mut inner = state.inner.lock().unwrap();
    if !inner.graph.set_input_dsp(&device_id, config.clone()) {
        return Err(EngineError {
            message: format!("Unknown input: {device_id}"),
        });
    }
    // Live-publish if the engine is running. The engine's input order matches
    // effective_inputs_for_bus, so find the slot index by device_id.
    if let Some(engine) = inner.buses.get(&bus_id).and_then(|b| b.engine.as_ref()) {
        if let Some(idx) = engine
            .inputs
            .iter()
            .position(|info| info.device_name == device_id)
        {
            engine.update_input_dsp(idx, &config);
        }
    }
    Ok(())
}

/// Update a running bus's DSP (final limiter), live. Stores the clamped config
/// in `BusConfig` (survives rebuild) and publishes to the engine's seqlock if
/// running — the audio callback reloads on the next block without a restart.
#[tauri::command]
fn update_bus_dsp(
    state: tauri::State<AppState>,
    bus_id: BusId,
    config: BusDspConfig,
) -> Result<BusStatus, EngineError> {
    let mut config = config;
    config.clamp();
    let mut inner = state.inner.lock().unwrap();
    let bus = inner.buses.get_mut(&bus_id).ok_or_else(|| EngineError {
        message: format!("Unknown bus: {bus_id:?}"),
    })?;
    bus.config.dsp = config.clone();
    if let Some(engine) = bus.engine.as_ref() {
        engine.update_bus_dsp(&config);
    }
    Ok(structural_bus_status(bus))
}

// ── Automix groups (live sound gate, Feature B) ───────────────────────────────

/// List all automix (live-sound-gate) groups.
#[tauri::command]
fn automix_list_groups(state: tauri::State<AppState>) -> Vec<AutomixGroupDef> {
    state.inner.lock().unwrap().automix_groups.clone()
}

/// Create an empty automix group (no members, default params). Returns the new
/// group so the UI gets its generated id.
#[tauri::command]
fn automix_create_group(
    state: tauri::State<AppState>,
    name: String,
) -> Result<AutomixGroupDef, EngineError> {
    let mut inner = state.inner.lock().unwrap();
    if inner.automix_groups.len() >= MAX_AUTOMIX_GROUPS {
        return Err(new_last_error(
            &mut inner,
            format!("Automix group limit reached ({MAX_AUTOMIX_GROUPS})"),
        ));
    }
    let group = AutomixGroupDef {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        members: Vec::new(),
        config: AutomixConfig::default(),
    };
    inner.automix_groups.push(group.clone());
    inner.last_error = None;
    Ok(group)
}

/// Replace a group's member set (input device ids). Re-resolves and publishes to
/// every running engine. Duplicates are dropped, original order preserved.
#[tauri::command]
fn automix_set_members(
    state: tauri::State<AppState>,
    group_id: String,
    members: Vec<String>,
) -> Result<Vec<AutomixGroupDef>, EngineError> {
    let mut seen = BTreeSet::new();
    let members: Vec<String> = members
        .into_iter()
        .filter(|m| seen.insert(m.clone()))
        .collect();
    let mut inner = state.inner.lock().unwrap();
    {
        let group = inner
            .automix_groups
            .iter_mut()
            .find(|g| g.id == group_id)
            .ok_or_else(|| EngineError {
                message: format!("Unknown automix group: {group_id}"),
            })?;
        group.members = members;
    }
    republish_automix_all(&inner);
    inner.last_error = None;
    Ok(inner.automix_groups.clone())
}

/// Update a group's automix params (enabled / attack / release / floor /
/// noise floor). Clamped, then republished to every running engine.
#[tauri::command]
fn automix_set_config(
    state: tauri::State<AppState>,
    group_id: String,
    config: AutomixConfig,
) -> Result<Vec<AutomixGroupDef>, EngineError> {
    let mut config = config;
    config.clamp();
    let mut inner = state.inner.lock().unwrap();
    {
        let group = inner
            .automix_groups
            .iter_mut()
            .find(|g| g.id == group_id)
            .ok_or_else(|| EngineError {
                message: format!("Unknown automix group: {group_id}"),
            })?;
        group.config = config;
    }
    republish_automix_all(&inner);
    inner.last_error = None;
    Ok(inner.automix_groups.clone())
}

/// Delete an automix group and republish (the engine sees one fewer group).
#[tauri::command]
fn automix_delete_group(
    state: tauri::State<AppState>,
    group_id: String,
) -> Result<Vec<AutomixGroupDef>, EngineError> {
    let mut inner = state.inner.lock().unwrap();
    let before = inner.automix_groups.len();
    inner.automix_groups.retain(|g| g.id != group_id);
    if inner.automix_groups.len() == before {
        return Err(new_last_error(
            &mut inner,
            format!("Unknown automix group: {group_id}"),
        ));
    }
    republish_automix_all(&inner);
    inner.last_error = None;
    Ok(inner.automix_groups.clone())
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
                message: format!("Bus {bus_id:?} is not running. Enable a routed input first."),
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
                message: format!("Input '{device_id}' is not active on bus {bus_id:?}"),
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
                message: format!("Input '{device_id}' is not active on any running bus"),
            })
        }
    }
}

fn start_recording_inner(
    inner: &mut AppInner,
    recordings_dir: &std::path::Path,
    session_subdir: Option<&str>,
    format: RecordFormat,
    spec: TapSpec,
) -> Result<RecordingInfo, EngineError> {
    let (engine_bus, kind, channels, sample_rate, tap_tx) = resolve_tap(inner, &spec)?;
    let handle = recorder::start_recorder(StartRecorderRequest {
        spec: spec.clone(),
        kind,
        channels,
        sample_rate,
        format,
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
    let base = app_local_dir(&app)?;
    let format = RecorderSettings::load_or_default(&base).format;
    let mut inner = state.inner.lock().unwrap();
    let result = start_recording_inner(&mut inner, &recordings_dir, None, format, spec);
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
    let base = app_local_dir(&app)?;
    let format = RecorderSettings::load_or_default(&base).format;
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
    let session = format!("master_{}", chrono::Local::now().format("%Y-%m-%d_%H%M%S"));
    let mut out = Vec::with_capacity(running_buses.len());
    for bus_id in running_buses {
        match start_recording_inner(
            &mut inner,
            &recordings_dir,
            Some(&session),
            format,
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
fn stop_recording(state: tauri::State<AppState>, id: String) -> Result<RecordingInfo, EngineError> {
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
fn list_recording_files(app: tauri::AppHandle) -> Result<Vec<RecordingFile>, EngineError> {
    let dir = resolve_recordings_dir(&app)?;
    recorder::list_recording_files(&dir)
}

#[tauri::command]
fn get_recordings_dir(app: tauri::AppHandle) -> Result<String, EngineError> {
    let dir = resolve_recordings_dir(&app)?;
    Ok(dir.display().to_string())
}

#[tauri::command]
fn set_recordings_dir(app: tauri::AppHandle, path: String) -> Result<String, EngineError> {
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
fn get_recorder_settings(app: tauri::AppHandle) -> Result<RecorderSettings, EngineError> {
    let base = app_local_dir(&app)?;
    Ok(RecorderSettings::load_or_default(&base))
}

#[tauri::command]
fn set_recorder_format(app: tauri::AppHandle, format: RecordFormat) -> Result<(), EngineError> {
    let base = app_local_dir(&app)?;
    let mut settings = RecorderSettings::load_or_default(&base);
    settings.format = format;
    settings.save(&base)
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
            dsp: Default::default(),
            buffer_size_frames: None,
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
                dsp: Default::default(),
            }],
            automix_groups: vec![],
        };

        let mut inner = AppInner {
            buses: BusRuntime::default_set(),
            graph: AudioGraph::new(),
            recorders: BTreeMap::new(),
            automix_groups: Vec::new(),
            metering_taps: BTreeMap::new(),
            last_error: Some("stale".to_string()),
        };

        apply_preset_state(&mut inner, &preset).unwrap();
        assert!(inner.buses.values().all(|bus| bus.engine.is_none()));
        assert!(legacy_routes(&inner).iter().all(|route| !route.active));
        assert!(inner.last_error.is_none());
    }

    // ── Phase 11: hotplug diff handling ──────────────────────────────────────
    //
    // Engines can't be constructed in tests (they need live WASAPI devices),
    // so these cover the no-engine and early-return paths: the predicates
    // that decide WHICH buses react, and the filtered rebuild's skip logic.

    fn empty_inner() -> AppInner {
        AppInner {
            buses: BusRuntime::default_set(),
            graph: AudioGraph::new(),
            recorders: BTreeMap::new(),
            automix_groups: Vec::new(),
            metering_taps: BTreeMap::new(),
            last_error: None,
        }
    }

    fn diff_with(
        added_inputs: &[&str],
        removed_inputs: &[&str],
        added_outputs: &[&str],
        removed_outputs: &[&str],
    ) -> DeviceDiff {
        let v = |items: &[&str]| items.iter().map(|s| s.to_string()).collect();
        DeviceDiff {
            added_inputs: v(added_inputs),
            removed_inputs: v(removed_inputs),
            added_outputs: v(added_outputs),
            removed_outputs: v(removed_outputs),
        }
    }

    #[test]
    fn removed_output_on_stopped_bus_is_noop() {
        let mut inner = empty_inner();
        {
            let bus = inner.buses.get_mut(&BusId::B1).unwrap();
            bus.config.output_device_id = Some("cable".to_string());
            bus.config.enabled = true;
        }
        handle_device_diff(
            &mut inner,
            &diff_with(&[], &[], &[], &["cable"]),
            &BTreeSet::new(),
        );
        // No engine was running — removal must not invent an error.
        assert!(inner.buses[&BusId::B1].last_error.is_none());
        assert!(inner.buses[&BusId::B1].engine.is_none());
    }

    #[test]
    fn removed_input_with_no_running_engines_is_noop() {
        let mut inner = empty_inner();
        inner.graph.add_input("mic");
        inner.graph.set_send("mic", BusId::A1, true);
        handle_device_diff(
            &mut inner,
            &diff_with(&[], &["mic"], &[], &[]),
            &BTreeSet::new(),
        );
        assert!(inner.buses.values().all(|b| b.last_error.is_none()));
    }

    #[test]
    fn added_output_for_disabled_bus_does_not_start_it() {
        let mut inner = empty_inner();
        {
            let bus = inner.buses.get_mut(&BusId::B1).unwrap();
            bus.config.output_device_id = Some("cable".to_string());
            bus.config.enabled = false;
        }
        handle_device_diff(
            &mut inner,
            &diff_with(&[], &[], &["cable"], &[]),
            &BTreeSet::new(),
        );
        assert!(inner.buses[&BusId::B1].engine.is_none());
        assert!(inner.buses[&BusId::B1].last_error.is_none());
    }

    #[test]
    fn added_output_clears_stale_error_when_rebuild_has_no_inputs() {
        // Enabled bus bound to the returning device, but no routed inputs:
        // the rebuild is a clean no-op (engine stays off) and the stale
        // disconnect error must be cleared.
        let mut inner = empty_inner();
        {
            let bus = inner.buses.get_mut(&BusId::B1).unwrap();
            bus.config.output_device_id = Some("cable".to_string());
            bus.config.enabled = true;
            bus.last_error = Some("Output device disconnected: cable.".to_string());
        }
        handle_device_diff(
            &mut inner,
            &diff_with(&[], &[], &["cable"], &[]),
            &BTreeSet::new(),
        );
        assert!(inner.buses[&BusId::B1].engine.is_none());
        assert!(inner.buses[&BusId::B1].last_error.is_none());
    }

    #[test]
    fn added_input_without_enabled_send_is_noop() {
        let mut inner = empty_inner();
        inner.graph.add_input("mic");
        // Send exists but disabled.
        inner.graph.set_send("mic", BusId::A1, false);
        {
            let bus = inner.buses.get_mut(&BusId::A1).unwrap();
            bus.config.output_device_id = Some("speakers".to_string());
            bus.config.enabled = true;
        }
        let available: BTreeSet<String> = ["mic".to_string()].into_iter().collect();
        handle_device_diff(&mut inner, &diff_with(&["mic"], &[], &[], &[]), &available);
        assert!(inner.buses[&BusId::A1].engine.is_none());
        assert!(inner.buses[&BusId::A1].last_error.is_none());
    }

    #[test]
    fn filtered_rebuild_skips_unavailable_inputs_without_error() {
        // Send enabled from an input that is NOT in the available set: the
        // filtered rebuild must succeed as a no-op instead of failing the
        // engine start with "Input device not found".
        let mut inner = empty_inner();
        inner.graph.add_input("usb-mic");
        inner.graph.set_send("usb-mic", BusId::B1, true);
        {
            let bus = inner.buses.get_mut(&BusId::B1).unwrap();
            bus.config.output_device_id = Some("cable".to_string());
            bus.config.enabled = true;
        }
        let result = rebuild_bus_filtered(&mut inner, BusId::B1, Some(&BTreeSet::new()));
        assert!(result.is_ok());
        assert!(inner.buses[&BusId::B1].engine.is_none());
        assert!(inner.buses[&BusId::B1].last_error.is_none());
    }
}

// ── Phase 11: hotplug watcher ─────────────────────────────────────────────────

/// React to a device hotplug diff. Engine repair only — the
/// `devices-changed` event emit happens in the watcher loop.
///
/// * Output removed → tear down any bus engine bound to it and record a
///   reconnect-pending error. Bus config is untouched so the bus resumes
///   automatically when the device returns.
/// * Output added → restart any enabled, currently-stopped bus bound to it.
/// * Input removed → rebuild affected running buses without the lost input
///   (filtered rebuild keeps the rest of the mix alive).
/// * Input added → rebuild enabled buses that have an enabled send from it
///   but whose engine is not currently carrying it.
fn handle_device_diff(
    inner: &mut AppInner,
    diff: &DeviceDiff,
    available_inputs: &BTreeSet<String>,
) {
    for removed in &diff.removed_outputs {
        let affected: Vec<BusId> = inner
            .buses
            .iter()
            .filter(|(_, b)| {
                b.engine.is_some() && b.config.output_device_id.as_deref() == Some(removed.as_str())
            })
            .map(|(id, _)| *id)
            .collect();
        for bus_id in affected {
            tear_down_engine(inner, bus_id);
            if let Some(bus) = inner.buses.get_mut(&bus_id) {
                bus.last_error = Some(format!(
                    "Output device disconnected: {removed}. Reconnects automatically when it returns."
                ));
            }
        }
    }

    for removed in &diff.removed_inputs {
        // Drop the device's metering tap so a later reconnect restarts it fresh
        // (#feature-idle-meter); the dead stream would otherwise never recover.
        inner.metering_taps.remove(removed);
        let affected: Vec<BusId> = inner
            .buses
            .iter()
            .filter(|(_, b)| {
                b.engine
                    .as_ref()
                    .map(|e| e.input_index(removed).is_some())
                    .unwrap_or(false)
            })
            .map(|(id, _)| *id)
            .collect();
        for bus_id in affected {
            if rebuild_bus_filtered(inner, bus_id, Some(available_inputs)).is_err() {
                if let Some(bus) = inner.buses.get_mut(&bus_id) {
                    bus.last_error = Some(format!(
                        "Input device disconnected: {removed}. Rejoins the mix automatically when it returns."
                    ));
                }
            }
        }
    }

    for added in &diff.added_outputs {
        let affected: Vec<BusId> = inner
            .buses
            .iter()
            .filter(|(_, b)| {
                b.engine.is_none()
                    && b.config.enabled
                    && b.config.output_device_id.as_deref() == Some(added.as_str())
            })
            .map(|(id, _)| *id)
            .collect();
        for bus_id in affected {
            if rebuild_bus_filtered(inner, bus_id, Some(available_inputs)).is_ok() {
                if let Some(bus) = inner.buses.get_mut(&bus_id) {
                    bus.last_error = None;
                }
            }
        }
    }

    for added in &diff.added_inputs {
        let affected: Vec<BusId> = BusId::ALL
            .into_iter()
            .filter(|bus_id| {
                inner
                    .graph
                    .get_send(added, *bus_id)
                    .map(|send| send.enabled)
                    .unwrap_or(false)
            })
            .filter(|bus_id| {
                inner
                    .buses
                    .get(bus_id)
                    .map(|b| {
                        b.config.enabled
                            && b.config.output_device_id.is_some()
                            && b.engine
                                .as_ref()
                                .map(|e| e.input_index(added).is_none())
                                .unwrap_or(true)
                    })
                    .unwrap_or(false)
            })
            .collect();
        for bus_id in affected {
            if rebuild_bus_filtered(inner, bus_id, Some(available_inputs)).is_ok() {
                if let Some(bus) = inner.buses.get_mut(&bus_id) {
                    bus.last_error = None;
                }
            }
        }
    }

    // Reconcile idle-input metering taps to the post-hotplug device set: start
    // taps for inputs whose device just (re)appeared (#feature-idle-meter).
    sync_metering_taps(inner);
}

/// Background polling loop. Diffs device snapshots every
/// `device_watch::POLL_INTERVAL`; on change, repairs affected buses and
/// emits `devices-changed` to the frontend. A failed enumeration skips the
/// cycle so a transient WASAPI error never reads as mass device removal.
fn device_watch_loop(app: tauri::AppHandle) {
    let mut prev: Option<DeviceSnapshot> = None;
    loop {
        std::thread::sleep(device_watch::POLL_INTERVAL);
        let Ok(next) = device_watch::take_snapshot() else {
            continue;
        };
        let Some(prev_snap) = prev.as_ref() else {
            prev = Some(next);
            continue;
        };
        let diff = device_watch::diff_snapshots(prev_snap, &next);
        if !diff.is_empty() {
            {
                let state = app.state::<AppState>();
                let mut inner = state.inner.lock().unwrap();
                handle_device_diff(&mut inner, &diff, &next.inputs);
            }
            let _ = app.emit("devices-changed", &diff);
        } else {
            // Even with no device change, reconcile metering taps so an input
            // added through any path (boot restore, legacy A1 monitor commands)
            // gets its idle-level tap within one poll (#feature-idle-meter).
            let state = app.state::<AppState>();
            let mut inner = state.inner.lock().unwrap();
            sync_metering_taps(&mut inner);
        }
        prev = Some(next);
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
    let persisted = net::session::accept(&session_id).map_err(|message| EngineError { message })?;
    // Surface the phone as a normal mixer input. Adding it to the graph does not
    // route it anywhere (no sends yet), so no bus rebuild is needed — the user
    // wires it to buses like any other input. Done even when persistence failed,
    // so the phone is usable this session.
    let device_id = format!("{}{session_id}", audio::source::PHONE_PREFIX);
    {
        let mut inner = state.inner.lock().unwrap();
        if !inner
            .graph
            .list_inputs()
            .iter()
            .any(|c| c.device_id == device_id)
        {
            inner.graph.add_input(&device_id);
            // Auto-name the phone input with its hostname (#feature8). Only on
            // first add, so a user rename survives a later reconnect.
            if let Some(status) = net::session::status(&session_id) {
                if !status.label.trim().is_empty() {
                    inner.graph.set_label(&device_id, Some(status.label));
                }
            }
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
    let mut affected: Vec<BusId> = BusId::ALL
        .into_iter()
        .filter(|bus_id| {
            inner
                .graph
                .get_send(&device_id, *bus_id)
                .map(|send| send.enabled)
                .unwrap_or(false)
        })
        .collect();
    // Monitor preview routes to A1 with no enabled send (#feature1); rebuild A1
    // too so a disconnected phone drops out of the running monitor engine.
    let monitored = inner
        .graph
        .get_input(&device_id)
        .map(|i| i.monitor)
        .unwrap_or(false);
    if monitored && !affected.contains(&BusId::A1) {
        affected.push(BusId::A1);
    }
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
fn revoke_phone(state: &tauri::State<AppState>, session_id: &str) -> Result<(), EngineError> {
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
fn phone_forget(state: tauri::State<AppState>, session_id: String) -> Result<(), EngineError> {
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
    settings
        .save(&dir)
        .map_err(|message| EngineError { message })
}

/// Whether AudioManager should launch automatically when the current Windows
/// user signs in. Defaults to enabled for new installs.
#[tauri::command]
fn app_get_launch_at_login(app: tauri::AppHandle) -> Result<bool, EngineError> {
    let dir = app_local_dir(&app)?;
    Ok(app_settings::AppSettings::load_or_default(&dir).launch_at_login)
}

/// Persist the desktop launch preference and apply it to the current user's
/// Windows startup registry entry immediately.
#[tauri::command]
fn app_set_launch_at_login(app: tauri::AppHandle, enabled: bool) -> Result<(), EngineError> {
    let dir = app_local_dir(&app)?;
    app_settings::sync_windows_autostart(enabled).map_err(|message| EngineError { message })?;
    let mut settings = app_settings::AppSettings::load_or_default(&dir);
    settings.launch_at_login = enabled;
    settings
        .save(&dir)
        .map_err(|message| EngineError { message })
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
                    // Auto-name the resumed phone with its stored hostname so the
                    // label is consistent with the live-accept path (#feature8).
                    if let Some(label) = net::paired::label_of(session_id) {
                        if !label.trim().is_empty() {
                            inner.graph.set_label(&device_id, Some(label));
                        }
                    }
                }
            }));

            // pairing-v2 #1: load the persisted trusted-device store so a
            // returning phone can auto-reconnect (Phase 2 consumes it).
            // Panic-free by contract — any failure leaves an empty store and the
            // app still launches with default QR pairing intact.
            if let Ok(dir) = app.path().app_local_data_dir() {
                let desktop_settings = app_settings::AppSettings::load_or_default(&dir);
                if let Err(e) =
                    app_settings::sync_windows_autostart(desktop_settings.launch_at_login)
                {
                    eprintln!("[startup] could not update Windows startup registration: {e}");
                }
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

            // Global shortcut (MC-4): Ctrl+Alt+M toggles the always-on-top mini
            // controller window even when the app is unfocused. The handler only
            // emits an event; the frontend owns the window create/show/hide logic
            // (miniWindowApi.ts), keeping one source of truth.
            #[cfg(desktop)]
            {
                use tauri::Emitter;
                use tauri_plugin_global_shortcut::{
                    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
                };
                // Only ever one shortcut is registered (the first free candidate),
                // so the handler emits on any Pressed event — no need to match.
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app, _sc, event| {
                            if event.state() == ShortcutState::Pressed {
                                let _ = app.emit("mini:toggle", ());
                            }
                        })
                        .build(),
                )?;
                // Ctrl+Alt+M is the documented default but is commonly taken by
                // other apps, so fall back to the first candidate that registers.
                let candidates: [(Shortcut, &str); 5] = [
                    (
                        Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyP),
                        "Ctrl+Shift+P",
                    ),
                    (
                        Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyM),
                        "Ctrl+Alt+M",
                    ),
                    (
                        Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::F10),
                        "Ctrl+Shift+F10",
                    ),
                    (
                        Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::F9),
                        "Ctrl+Alt+F9",
                    ),
                    (
                        Shortcut::new(
                            Some(Modifiers::CONTROL | Modifiers::SHIFT | Modifiers::ALT),
                            Code::KeyM,
                        ),
                        "Ctrl+Shift+Alt+M",
                    ),
                ];
                let gs = app.global_shortcut();
                let mut chosen: Option<&str> = None;
                for (sc, label) in candidates {
                    if gs.register(sc).is_ok() {
                        chosen = Some(label);
                        break;
                    }
                }
                match chosen {
                    Some(label) => {
                        println!("[mini] global shortcut registered: {label}");
                        *MINI_HOTKEY.lock().unwrap() = Some(label.to_string());
                    }
                    None => eprintln!("[mini] no global shortcut available (all candidates taken)"),
                }
            }

            let handle = app.handle().clone();
            std::thread::spawn(move || device_watch_loop(handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_input_devices,
            list_output_devices,
            audio_list_endpoints,
            audio_default_endpoint,
            audio_set_default_endpoint,
            audio_get_endpoint_volume,
            audio_set_endpoint_volume,
            audio_set_endpoint_mute,
            get_mini_hotkey,
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
            replace_input,
            rename_input,
            set_input_gain,
            set_input_boost,
            set_input_monitor,
            set_send,
            set_send_gain,
            list_buses,
            get_system_snapshot,
            drain_meter_snapshot,
            get_system_status,
            get_spectrum_data,
            set_bus_device,
            set_bus_volume,
            set_bus_enabled,
            rename_bus,
            set_bus_buffer_size,
            set_bus_latency_mode,
            update_input_dsp,
            update_bus_dsp,
            automix_list_groups,
            automix_create_group,
            automix_set_members,
            automix_set_config,
            automix_delete_group,
            start_recording,
            start_master_recording,
            stop_recording,
            stop_all_recordings,
            list_active_recordings,
            list_recording_files,
            get_recordings_dir,
            set_recordings_dir,
            get_recorder_settings,
            set_recorder_format,
            delete_recording_file,
            open_recordings_folder,
            amvc::query_amvc_helper,
            amvc::launch_amvc_installer,
            amvc::amvc_set_device_enabled,
            amvc_sync::amvc_plan_endpoint_sync,
            amvc_sync::amvc_apply_endpoint_sync,
            amvc_sync::amvc_restore_endpoint_names,
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
            app_get_launch_at_login,
            app_set_launch_at_login,
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
