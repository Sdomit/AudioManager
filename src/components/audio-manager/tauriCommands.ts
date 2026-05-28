/**
 * Tauri command bindings — placeholders.
 *
 * Your Rust backend exposes its own commands via #[tauri::command]. Rename
 * the strings below to match your real command names, uncomment the invoke
 * line, and remove the mock fallback in useAudioManager.
 *
 * The actual @tauri-apps/api import is commented out so this file compiles
 * in isolation (e.g. running tests, Storybook, the design preview). Replace
 * the dynamic stub with the real import in your app.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

import type { Bus, BusId, AudioInput, Send, Preset } from "./types";

// Replace with:
//   import { invoke } from "@tauri-apps/api/core";
const _invoke = async <T>(_cmd: string, _args?: Record<string, unknown>): Promise<T> => {
  throw new Error(
    "tauriCommands.invoke called in mock mode. Wire @tauri-apps/api before using.",
  );
};
void _invoke;

/* ── Reads ──────────────────────────────────────────────────────────────── */

export async function listBuses(): Promise<Bus[]> {
  // return invoke<Bus[]>("list_buses");
  throw new Error("Not wired");
}

export async function listInputs(): Promise<AudioInput[]> {
  // return invoke<AudioInput[]>("list_inputs");
  throw new Error("Not wired");
}

export async function listSends(): Promise<Send[]> {
  // return invoke<Send[]>("list_sends");
  throw new Error("Not wired");
}

export async function listPresets(): Promise<Preset[]> {
  // return invoke<Preset[]>("list_presets");
  throw new Error("Not wired");
}

/* ── Bus writes ─────────────────────────────────────────────────────────── */

export async function setBusEnabled(_id: BusId, _enabled: boolean): Promise<void> {
  // return invoke<void>("set_bus_enabled", { id, enabled });
}

export async function setBusMuted(_id: BusId, _muted: boolean): Promise<void> {
  // return invoke<void>("set_bus_muted", { id, muted });
}

export async function setBusVolume(_id: BusId, _volume: number): Promise<void> {
  // return invoke<void>("set_bus_volume", { id, volume });
}

export async function setBusDevice(_id: BusId, _device: string | null): Promise<void> {
  // return invoke<void>("set_bus_device", { id, device });
}

/* ── Input writes ───────────────────────────────────────────────────────── */

export async function setInputGain(_id: string, _gain: number): Promise<void> {
  // return invoke<void>("set_input_gain", { id, gain });
}

export async function setInputMuted(_id: string, _muted: boolean): Promise<void> {
  // return invoke<void>("set_input_muted", { id, muted });
}

/* ── Routing writes ─────────────────────────────────────────────────────── */

export async function toggleSend(_inputId: string, _busId: BusId): Promise<void> {
  // return invoke<void>("toggle_send", { inputId, busId });
}

export async function setSendGain(_inputId: string, _busId: BusId, _gain: number): Promise<void> {
  // return invoke<void>("set_send_gain", { inputId, busId, gain });
}

export async function setSendMuted(_inputId: string, _busId: BusId, _muted: boolean): Promise<void> {
  // return invoke<void>("set_send_muted", { inputId, busId, muted });
}

/* ── Presets ────────────────────────────────────────────────────────────── */

export async function loadPreset(_id: string): Promise<void> {
  // return invoke<void>("load_preset", { id });
}

export async function savePreset(_name: string): Promise<Preset> {
  // return invoke<Preset>("save_preset", { name });
  throw new Error("Not wired");
}

export async function deletePreset(_id: string): Promise<void> {
  // return invoke<void>("delete_preset", { id });
}

/* ── Metering ───────────────────────────────────────────────────────────── */
/**
 * Your Rust side likely emits meter events on a Tauri event channel rather
 * than via invoke. The hook will subscribe like:
 *
 *   import { listen } from "@tauri-apps/api/event";
 *   const unlisten = await listen<MeterPayload>("meters", (e) => { ... });
 *
 * Define your MeterPayload shape and wire it up in useAudioManager.
 */
export interface MeterPayload {
  buses: Record<BusId, number>;
  inputs: Record<string, number>;
  clips: BusId[];
}
