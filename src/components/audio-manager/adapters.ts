/**
 * Shape adapters: Rust engine types ↔ AudioManager UI types.
 *
 * Phase C wiring lives here so the UI types (`./types`) stay stable and
 * the Rust contract (`src/types/engine.ts`) stays untouched.
 *
 * Volume convention:
 *   - Backend: linear gain in [0.0, 2.0]; 1.0 = unity, 2.0 = +6 dB headroom.
 *   - UI:      linear fader in [0.0, 1.0]; 0.5 = unity for now.
 *   The hook divides/multiplies by 2.0 at the boundary.
 */

import type {
  BusStatus,
  InputChannel,
  InputPeakStatus,
  InputSend,
  PresetSummary,
} from "../../types/engine";
import { isLikelyVirtualAudioDevice } from "../../utils/devices";
import { defaultDspConfig, defaultEq, defaultLimiter } from "./dspDefaults";
import type {
  AudioInput,
  Bus,
  BusId,
  BusRole,
  BusState,
  InputSourceKind,
  Preset,
  PresetVersion,
  Send,
} from "./types";

export const BACKEND_VOLUME_MAX = 2.0;

export function backendVolumeToUi(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v / BACKEND_VOLUME_MAX));
}

export function uiVolumeToBackend(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(BACKEND_VOLUME_MAX, v * BACKEND_VOLUME_MAX));
}

export function busRoleFor(id: BusId): BusRole {
  switch (id) {
    case "A1":
      return "monitor";
    case "A2":
      return "speakers";
    case "B1":
      return "stream";
    case "B2":
      return "record";
  }
}

function deriveBusState(b: BusStatus, hasSends: boolean): BusState {
  if (b.last_error) return "error";
  if (!b.output_device) return "unconfigured";
  if (!b.enabled) return "idle";
  if (b.clipped_recently) return "clipping";
  if (!hasSends) return "silent";
  return "running";
}

export function adaptBus(b: BusStatus, hasSends: boolean): Bus {
  return {
    id: b.id,
    role: busRoleFor(b.id),
    label: b.name,
    device: b.output_device,
    state: deriveBusState(b, hasSends),
    enabled: b.enabled,
    muted: b.muted,
    volume: backendVolumeToUi(b.volume),
    level: Math.max(0, b.output_peak),
    clipUntil: b.clipped_recently ? Date.now() + 2400 : null,
    error: b.last_error,
    bufferSizeFrames: b.buffer_size_frames ?? null,
    latencyMode: b.latency_mode ?? null,
    underruns: b.underruns ?? 0,
    overruns: b.overruns ?? 0,
    eq: b.dsp?.eq ?? defaultEq(),
    limiter: b.dsp?.limiter ?? defaultLimiter(),
    loudness: b.loudness ?? null,
  };
}

/** Synthetic id scheme shared with the Rust `audio::source` module. */
const SYS_LOOPBACK_ID = "sys:default";
const PROC_PREFIX = "proc:";
const APP_PREFIX = "app:";
const PHONE_PREFIX = "phone:";

function inputKindFor(deviceId: string): InputSourceKind {
  if (deviceId === SYS_LOOPBACK_ID) return "system";
  if (deviceId.startsWith(PHONE_PREFIX)) return "phone";
  if (deviceId.startsWith(PROC_PREFIX) || deviceId.startsWith(APP_PREFIX)) {
    return "app";
  }
  return isLikelyVirtualAudioDevice(deviceId) ? "virtual" : "microphone";
}

/**
 * Display name derived purely from the id — used everywhere an input is shown
 * (e.g. after a preset load, when only the id is known). `app:<image>` ids
 * already carry the human-readable name.
 */
function inputNameFor(deviceId: string): string {
  if (deviceId === SYS_LOOPBACK_ID) return "System sound";
  if (deviceId.startsWith(PHONE_PREFIX)) return "Phone microphone";
  if (deviceId.startsWith(APP_PREFIX)) return deviceId.slice(APP_PREFIX.length);
  if (deviceId.startsWith(PROC_PREFIX)) {
    return `App (PID ${deviceId.slice(PROC_PREFIX.length)})`;
  }
  return deviceId;
}

export function adaptInput(ch: InputChannel, meter?: InputPeakStatus): AudioInput {
  return {
    id: ch.device_id,
    name: inputNameFor(ch.device_id),
    kind: inputKindFor(ch.device_id),
    device: ch.device_id,
    gain: backendVolumeToUi(ch.gain),
    muted: ch.muted,
    level: Math.max(0, meter?.peak ?? 0),
    levelL: meter ? Math.max(0, meter.peak_l) : undefined,
    levelR: meter ? Math.max(0, meter.peak_r) : undefined,
    channels: meter?.channels,
    dsp: ch.dsp ?? defaultDspConfig(),
  };
}

export function adaptSendsFromInputs(inputs: InputChannel[]): Send[] {
  const out: Send[] = [];
  for (const ch of inputs) {
    for (const s of ch.sends) {
      if (!s.enabled) continue;
      out.push(adaptSend(ch.device_id, s));
    }
  }
  return out;
}

function adaptSend(inputDeviceId: string, s: InputSend): Send {
  return {
    inputId: inputDeviceId,
    busId: s.bus_id,
    enabled: s.enabled,
    gain: backendVolumeToUi(s.volume),
    muted: s.muted,
  };
}

export function adaptPreset(p: PresetSummary): Preset {
  const version: PresetVersion = p.schema_version === 1 ? 1 : 2;
  const ts = Date.parse(p.saved_at_utc);
  const epoch = Number.isFinite(ts) ? ts : Date.now();
  return {
    id: p.name,
    name: p.name,
    version,
    createdAt: epoch,
    updatedAt: epoch,
  };
}

export function busHasAnySend(sends: Send[], busId: BusId): boolean {
  return sends.some((s) => s.busId === busId && s.enabled);
}

/**
 * Type guard narrowing an arbitrary string to `BusId`. Used wherever a
 * graph-derived id (e.g. parsed from `localStorage` or a NodeId suffix)
 * must be passed to APIs that demand a `BusId` without an unchecked cast.
 */
export function isBusId(id: string): id is BusId {
  return id === "A1" || id === "A2" || id === "B1" || id === "B2";
}
