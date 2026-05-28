/**
 * Tauri command bindings for the AudioManager UI.
 *
 * Phase C wires reads: listBuses / listInputs / listSends / listPresets
 * now delegate to the existing `src/ipc/commands.ts` wrappers and adapt
 * the engine shapes to the UI types via `./adapters.ts`.
 *
 * Writes are still stubs — Phase D replaces them.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

import * as ipc from "../../ipc/commands";
import {
  adaptBus,
  adaptInput,
  adaptPreset,
  adaptSendsFromInputs,
  busHasAnySend,
} from "./adapters";
import type {
  Bus,
  BusId,
  AudioInput,
  Send,
  Preset,
} from "./types";

/* ── Reads ──────────────────────────────────────────────────────────────── */

/**
 * Single round-trip hydrate. Calls get_system_status + list_presets in
 * parallel and adapts all four UI collections in one shot. Cheaper than
 * four separate invokes (which would all touch the same AppState lock).
 */
export async function hydrate(): Promise<{
  buses: Bus[];
  inputs: AudioInput[];
  sends: Send[];
  presets: Preset[];
}> {
  const [status, presets] = await Promise.all([
    ipc.getSystemStatus(),
    ipc.listPresets(),
  ]);

  const peakByDevice = new Map<string, number>();
  for (const p of status.input_peaks) {
    peakByDevice.set(p.device_id, p.peak);
  }

  const sends = adaptSendsFromInputs(status.inputs);
  const buses = status.buses.map((b) => adaptBus(b, busHasAnySend(sends, b.id)));
  const inputs = status.inputs.map((ch) =>
    adaptInput(ch, peakByDevice.get(ch.device_id) ?? 0),
  );
  const adaptedPresets = presets.map(adaptPreset);

  return { buses, inputs, sends, presets: adaptedPresets };
}

export async function listBuses(): Promise<Bus[]> {
  const result = await hydrate();
  return result.buses;
}

export async function listInputs(): Promise<AudioInput[]> {
  const result = await hydrate();
  return result.inputs;
}

export async function listSends(): Promise<Send[]> {
  const result = await hydrate();
  return result.sends;
}

export async function listPresets(): Promise<Preset[]> {
  const presets = await ipc.listPresets();
  return presets.map(adaptPreset);
}

/* ── Bus writes (Phase D wiring TODO) ───────────────────────────────────── */

export async function setBusEnabled(_id: BusId, _enabled: boolean): Promise<void> {
  // Phase D: ipc.setBusEnabled(_id, _enabled);
}

export async function setBusMuted(_id: BusId, _muted: boolean): Promise<void> {
  // Phase D: ipc.setBusVolume(_id, currentVolume, _muted);
}

export async function setBusVolume(_id: BusId, _volume: number): Promise<void> {
  // Phase D: ipc.setBusVolume(_id, uiVolumeToBackend(_volume), currentMuted);
}

export async function setBusDevice(_id: BusId, _device: string | null): Promise<void> {
  // Phase D: ipc.setBusDevice(_id, _device);
}

/* ── Input writes (Phase D) ─────────────────────────────────────────────── */

export async function setInputGain(_id: string, _gain: number): Promise<void> {
  // Phase D
}

export async function setInputMuted(_id: string, _muted: boolean): Promise<void> {
  // Phase D
}

/* ── Routing writes (Phase D) ───────────────────────────────────────────── */

export async function toggleSend(_inputId: string, _busId: BusId): Promise<void> {
  // Phase D
}

export async function setSendGain(_inputId: string, _busId: BusId, _gain: number): Promise<void> {
  // Phase D
}

export async function setSendMuted(_inputId: string, _busId: BusId, _muted: boolean): Promise<void> {
  // Phase D
}

/* ── Presets (Phase D) ──────────────────────────────────────────────────── */

export async function loadPreset(_id: string): Promise<void> {
  // Phase D: ipc.loadPreset(_id) — and dispatch hydrate again on success.
}

export async function savePreset(_name: string): Promise<Preset> {
  // Phase D
  throw new Error("savePreset not wired yet");
}

export async function deletePreset(_id: string): Promise<void> {
  // Phase D: ipc.deletePreset(_id);
}

/* ── Metering ───────────────────────────────────────────────────────────── */
/**
 * Phase E will subscribe to a Tauri event. Until then, polling
 * `hydrate()` on a timer is a fine fallback (matches the legacy
 * App.tsx 200 ms polling behavior).
 */
export interface MeterPayload {
  buses: Record<BusId, number>;
  inputs: Record<string, number>;
  clips: BusId[];
}
