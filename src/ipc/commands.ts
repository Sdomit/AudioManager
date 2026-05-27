import { invoke } from "@tauri-apps/api/core";
import type { DeviceInfo, PassthroughStatus, Route } from "../types/engine";

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
