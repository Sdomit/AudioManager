import { invoke } from "@tauri-apps/api/core";
import type {
  BusId,
  BusStatus,
  DeviceInfo,
  EngineStatus,
  InputChannel,
  PresetLoadResult,
  PresetSummary,
  PassthroughStatus,
  Route,
  SystemStatus,
} from "../types/engine";

// ── Device enumeration ────────────────────────────────────────────────────────

export const listInputDevices = (): Promise<DeviceInfo[]> =>
  invoke<DeviceInfo[]>("list_input_devices");

export const listOutputDevices = (): Promise<DeviceInfo[]> =>
  invoke<DeviceInfo[]>("list_output_devices");

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
