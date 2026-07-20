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
import type { PresetLoadWarning } from "../../types/engine";
import type {
  Bus,
  BusId,
  AudioInput,
  InputMeterLevel,
  Send,
  Preset,
} from "./types";

/* ── Reads ──────────────────────────────────────────────────────────────── */

/**
 * Single round-trip hydrate. Calls get_system_snapshot + list_presets in
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
    ipc.getSystemSnapshot(),
    ipc.listPresets(),
  ]);

  const sends = adaptSendsFromInputs(status.inputs);
  const buses = status.buses.map((b) => adaptBus(b, busHasAnySend(sends, b.id)));
  const inputs = status.inputs.map((ch) => adaptInput(ch));
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

/**
 * Lightweight meter poll. Calls `drain_meter_snapshot` only (no presets,
 * no device enumeration) and returns just what the meter loop needs:
 *
 *   - busLevels:  per-bus output peak in [0..1]
 *   - inputLevels: per-input peak in [0..1]
 *
 * This is intentionally the UI's sole destructive telemetry read. The
 * structural hydrate path uses a non-destructive snapshot instead.
 *
 * Bus state (enabled, error, output_device) transitions are NOT
 * surfaced here — Phase E uses a slower full-refresh interval for
 * those, so the fast path stays pure-meter and doesn't churn the
 * reducer when nothing structural has changed.
 */
export async function pollMeters(): Promise<{
  busLevels: Record<BusId, number>;
  inputLevels: Record<string, InputMeterLevel>;
}> {
  const status = await ipc.drainMeterSnapshot();
  const busLevels: Record<BusId, number> = {} as Record<BusId, number>;
  for (const b of status.buses) {
    busLevels[b.id] = Math.max(0, b.output_peak);
  }
  const inputLevels: Record<string, InputMeterLevel> = {};
  for (const p of status.input_peaks) {
    const levelL = Math.max(0, p.peak_l);
    const levelR = Math.max(0, p.peak_r);
    inputLevels[p.device_id] = {
      level: Math.max(0, p.peak, levelL, levelR),
      levelL,
      levelR,
      channels: p.channels,
    };
  }
  return { busLevels, inputLevels };
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

export async function renameBus(id: BusId, name: string): Promise<void> {
  await ipc.renameBus(id, name);
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

/* ── Presets ────────────────────────────────────────────────────────────── */

export async function loadPreset(id: string): Promise<PresetLoadWarning[]> {
  const result = await ipc.loadPreset(id);
  return result.warnings;
}

export async function savePreset(name: string): Promise<Preset> {
  const saved = await ipc.savePreset(name);
  return adaptPreset(saved);
}

export async function deletePreset(id: string): Promise<void> {
  await ipc.deletePreset(id);
}

export type { PresetLoadWarning };

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
