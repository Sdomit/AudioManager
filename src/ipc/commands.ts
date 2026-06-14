import { invoke } from "@tauri-apps/api/core";
import type {
  AmvcQueryResult,
  AmvcSyncPlan,
  AudioSessionInfo,
  BusDspConfig,
  BusId,
  BusStatus,
  DeviceInfo,
  DspConfig,
  EngineStatus,
  InputChannel,
  PhonePairedDevice,
  PhoneServerStatus,
  PhoneSessionCreated,
  PhoneSessionStatus,
  PresetLoadResult,
  PresetSummary,
  PassthroughStatus,
  RecordingFile,
  RecordingInfo,
  Route,
  SystemStatus,
  TapSpec,
} from "../types/engine";
// ── Device enumeration ────────────────────────────────────────────────────────

export const listInputDevices = (): Promise<DeviceInfo[]> =>
  invoke<DeviceInfo[]>("list_input_devices");

export const listOutputDevices = (): Promise<DeviceInfo[]> =>
  invoke<DeviceInfo[]>("list_output_devices");

/** Apps currently playing audio (default render endpoint), for the AppPicker. */
export const listAudioSessions = (): Promise<AudioSessionInfo[]> =>
  invoke<AudioSessionInfo[]>("list_audio_sessions");

// ── Phase 1 passthrough (kept for compatibility) ──────────────────────────────

export const startPassthrough = (inputId: string, outputId: string): Promise<void> =>
  invoke<void>("start_passthrough", { inputId, outputId });

export const stopPassthrough = (): Promise<void> =>
  invoke<void>("stop_passthrough");

export const getPassthroughStatus = (): Promise<PassthroughStatus> =>
  invoke<PassthroughStatus>("get_passthrough_status");

export const getEngineStatus = (): Promise<EngineStatus> =>
  invoke<EngineStatus>("get_engine_status");

// ── Presets ────────────────────────────────────────────────────────────────────

export const listPresets = (): Promise<PresetSummary[]> =>
  invoke<PresetSummary[]>("list_presets");

export const savePreset = (name: string): Promise<PresetSummary> =>
  invoke<PresetSummary>("save_preset", { name });

export const loadPreset = (name: string): Promise<PresetLoadResult> =>
  invoke<PresetLoadResult>("load_preset", { name });

export const deletePreset = (name: string): Promise<void> =>
  invoke<void>("delete_preset", { name });

// ── Routing ───────────────────────────────────────────────────────────────────

export const getRoutes = (): Promise<Route[]> =>
  invoke<Route[]>("get_routes");

/** Enable or disable a route. Returns the full updated routes list. */
export const setRoute = (
  inputId: string,
  outputId: string,
  enabled: boolean,
): Promise<Route[]> =>
  invoke<Route[]>("set_route", { inputId, outputId, enabled });

/** Stop all routes and clear the list. */
export const clearRoutes = (): Promise<void> =>
  invoke<void>("clear_routes");

/** Update per-route gain (0.0–2.0) and mute state. Atomic — no engine restart. */
export const setRouteGain = (
  inputId: string,
  outputId: string,
  volume: number,
  muted: boolean,
): Promise<Route[]> =>
  invoke<Route[]>("set_route_gain", { inputId, outputId, volume, muted });

// ── Phase 8B matrix commands ──────────────────────────────────────────────────

export const listInputs = (): Promise<InputChannel[]> =>
  invoke<InputChannel[]>("list_inputs");

export const addInput = (deviceId: string): Promise<InputChannel[]> =>
  invoke<InputChannel[]>("add_input", { deviceId });

export const removeInput = (deviceId: string): Promise<InputChannel[]> =>
  invoke<InputChannel[]>("remove_input", { deviceId });

export const setInputGain = (
  deviceId: string,
  gain: number,
  muted: boolean,
): Promise<InputChannel[]> =>
  invoke<InputChannel[]>("set_input_gain", { deviceId, gain, muted });

export const setSend = (
  deviceId: string,
  busId: BusId,
  enabled: boolean,
): Promise<InputChannel[]> =>
  invoke<InputChannel[]>("set_send", { deviceId, busId, enabled });

export const setSendGain = (
  deviceId: string,
  busId: BusId,
  volume: number,
  muted: boolean,
): Promise<InputChannel[]> =>
  invoke<InputChannel[]>("set_send_gain", { deviceId, busId, volume, muted });

// ── Phase 8A: output buses ────────────────────────────────────────────────────

/**
 * Read the current status of every bus (A1/A2/B1/B2). Resets per-bus output
 * peak/clip atomics — pick either this OR getEngineStatus per polling cycle,
 * not both.
 */
export const listBuses = (): Promise<BusStatus[]> =>
  invoke<BusStatus[]>("list_buses");

export const getSystemStatus = (): Promise<SystemStatus> =>
  invoke<SystemStatus>("get_system_status");

/** Assign or unassign the output device for a bus. Pass null to unassign. */
export const setBusDevice = (
  busId: BusId,
  outputDeviceId: string | null,
): Promise<BusStatus> =>
  invoke<BusStatus>("set_bus_device", { busId, outputDeviceId });

/** Atomically update a bus's volume and mute. No engine restart when running. */
export const setBusVolume = (
  busId: BusId,
  volume: number,
  muted: boolean,
): Promise<BusStatus> =>
  invoke<BusStatus>("set_bus_volume", { busId, volume, muted });

/** Enable or disable a bus. Disabling stops its engine immediately. */
export const setBusEnabled = (
  busId: BusId,
  enabled: boolean,
): Promise<BusStatus> =>
  invoke<BusStatus>("set_bus_enabled", { busId, enabled });

/** Rename a bus. Empty names are rejected. */
export const renameBus = (busId: BusId, name: string): Promise<BusStatus> =>
  invoke<BusStatus>("rename_bus", { busId, name });

// ── Recording ─────────────────────────────────────────────────────────────────

/** Start a single recording at the requested tap point. */
export const startRecording = (spec: TapSpec): Promise<RecordingInfo> =>
  invoke<RecordingInfo>("start_recording", { spec });

/**
 * Start one BusOut recording for every running bus. Files land in a
 * shared session sub-folder so they line up at sample 0.
 */
export const startMasterRecording = (): Promise<RecordingInfo[]> =>
  invoke<RecordingInfo[]>("start_master_recording");

/** Stop one recording by id; returns the final info with byte count. */
export const stopRecording = (id: string): Promise<RecordingInfo> =>
  invoke<RecordingInfo>("stop_recording", { id });

/** Stop every active recording. Returns final info for each. */
export const stopAllRecordings = (): Promise<RecordingInfo[]> =>
  invoke<RecordingInfo[]>("stop_all_recordings");

/** Snapshot of all active recordings (size, dropped frames, etc). */
export const listActiveRecordings = (): Promise<RecordingInfo[]> =>
  invoke<RecordingInfo[]>("list_active_recordings");

/** Files currently in the recordings dir (recursively). */
export const listRecordingFiles = (): Promise<RecordingFile[]> =>
  invoke<RecordingFile[]>("list_recording_files");

export const getRecordingsDir = (): Promise<string> =>
  invoke<string>("get_recordings_dir");

export const setRecordingsDir = (path: string): Promise<string> =>
  invoke<string>("set_recordings_dir", { path });

export const deleteRecordingFile = (path: string): Promise<void> =>
  invoke<void>("delete_recording_file", { path });

export const openRecordingsFolder = (): Promise<void> =>
  invoke<void>("open_recordings_folder");

// ── AudioManager Virtual Cable helper ────────────────────────────────────────

/** Query the amvc-helper binary for driver status. Never rejects. */
export const queryAmvcHelper = (): Promise<AmvcQueryResult> =>
  invoke<AmvcQueryResult>("query_amvc_helper");

/** Spawn the amvc-helper installer in the background. */
export const launchAmvcInstaller = (): Promise<void> =>
  invoke<void>("launch_amvc_installer");

/** Plan endpoint-name sync (read-only; no elevation). busNames in A1/A2/B1/B2 order. */
export const amvcPlanEndpointSync = (busNames: string[]): Promise<AmvcSyncPlan> =>
  invoke<AmvcSyncPlan>("amvc_plan_endpoint_sync", { busNames });

/** Apply endpoint-name sync (requires the app to run elevated). */
export const amvcApplyEndpointSync = (busNames: string[]): Promise<AmvcSyncPlan> =>
  invoke<AmvcSyncPlan>("amvc_apply_endpoint_sync", { busNames });

/** Revert renamed endpoints to their backed-up originals. Returns count restored. */
export const amvcRestoreEndpointNames = (): Promise<number> =>
  invoke<number>("amvc_restore_endpoint_names");

/** Set the output callback buffer size in frames for a bus. null = driver
 *  default. Valid range: 32–8192. Triggers an engine rebuild if running. */
export const setBusBufferSize = (
  busId: BusId,
  frames: number | null,
): Promise<BusStatus> =>
  invoke<BusStatus>("set_bus_buffer_size", { busId, frames });

/** Set a bus's latency mode (#35) — a named preset over the raw buffer size.
 *  "stable" = driver default, "low" = 256, "ultra-low" = 128 frames. Rebuilds. */
export const setBusLatencyMode = (
  busId: BusId,
  mode: string,
): Promise<BusStatus> =>
  invoke<BusStatus>("set_bus_latency_mode", { busId, mode });

/** Update a running input's DSP chain live. Stores to graph (survives rebuild)
 *  and publishes to the engine seqlock — audio callback picks up next block. */
export const updateInputDsp = (
  busId: BusId,
  deviceId: string,
  config: DspConfig,
): Promise<void> =>
  invoke<void>("update_input_dsp", { busId, deviceId, config });

/** Update a running bus's DSP (final limiter) live. Stores to BusConfig and
 *  publishes to the engine seqlock — audio callback picks up next block. */
export const updateBusDsp = (
  busId: BusId,
  config: BusDspConfig,
): Promise<BusStatus> =>
  invoke<BusStatus>("update_bus_dsp", { busId, config });

// ── Phone Wireless Audio (#39-#45) ───────────────────────────────────────────

/** Server status (running/port/LAN IPs) without side effects. */
export const phoneServerStatus = (): Promise<PhoneServerStatus> =>
  invoke<PhoneServerStatus>("phone_server_status");

/**
 * Start the phone server if needed and create a pairing session.
 * The returned URLs embed the pairing token — render as QR, never log.
 */
export const phoneCreateSession = (
  label?: string,
): Promise<PhoneSessionCreated> =>
  invoke<PhoneSessionCreated>("phone_create_session", { label: label ?? null });

export const phoneListSessions = (): Promise<PhoneSessionStatus[]> =>
  invoke<PhoneSessionStatus[]>("phone_list_sessions");

export const phoneAcceptClient = (sessionId: string): Promise<void> =>
  invoke<void>("phone_accept_client", { sessionId });

export const phoneRejectClient = (sessionId: string): Promise<void> =>
  invoke<void>("phone_reject_client", { sessionId });

export const phoneRemoveSession = (sessionId: string): Promise<void> =>
  invoke<void>("phone_remove_session", { sessionId });

export type PhoneLatencyMode = "fastest" | "balanced" | "stable" | "adaptive";

export const phoneSetLatencyMode = (
  sessionId: string,
  mode: PhoneLatencyMode,
): Promise<void> =>
  invoke<void>("phone_set_latency_mode", { sessionId, mode });

/** Persisted trusted devices for the "Paired devices" management list. */
export const phoneListPaired = (): Promise<PhonePairedDevice[]> =>
  invoke<PhonePairedDevice[]>("phone_list_paired");

/** Revoke a paired device: deletes persisted trust so it cannot auto-reconnect. */
export const phoneForget = (sessionId: string): Promise<void> =>
  invoke<void>("phone_forget", { sessionId });

/** Whether the phone server auto-starts at app launch (opt-in, default false). */
export const phoneGetAutostart = (): Promise<boolean> =>
  invoke<boolean>("phone_get_autostart");

export const phoneSetAutostart = (enabled: boolean): Promise<void> =>
  invoke<void>("phone_set_autostart", { enabled });
