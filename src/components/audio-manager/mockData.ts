/**
 * Mock data for AudioManager UI development.
 *
 * This module supplies fake buses, inputs, sends, and presets so the UI
 * can render in isolation without a Rust backend. When you wire up Tauri,
 * replace useAudioManager()'s internal state with calls to tauriCommands.
 */

import { defaultDspConfig, defaultLimiter } from "./dspDefaults";
import type {
  AudioInput,
  Bus,
  BusId,
  Preset,
  Send,
  StreamSetupStep,
} from "./types";

const rawBuses: Omit<
  Bus,
  "bufferSizeFrames" | "underruns" | "overruns" | "limiter"
>[] = [
  {
    id: "A1",
    role: "monitor",
    label: "Monitor",
    device: "Headphones (Focusrite Solo)",
    state: "running",
    enabled: true,
    muted: false,
    volume: 0.72,
    level: 0.55,
    clipUntil: null,
    error: null,
  },
  {
    id: "A2",
    role: "speakers",
    label: "Speakers",
    device: "Speakers (Realtek Audio)",
    state: "idle",
    enabled: false,
    muted: false,
    volume: 0.48,
    level: 0,
    clipUntil: null,
    error: null,
  },
  {
    id: "B1",
    role: "stream",
    label: "Stream",
    device: "CABLE Input (VB-Audio Virtual Cable)",
    state: "clipping",
    enabled: true,
    muted: false,
    volume: 0.82,
    level: 0.92,
    clipUntil: Date.now() + 2400,
    error: null,
  },
  {
    id: "B2",
    role: "record",
    label: "Record",
    device: null,
    state: "unconfigured",
    enabled: false,
    muted: false,
    volume: 0.65,
    level: 0,
    clipUntil: null,
    error: null,
  },
];

export const mockBuses: Bus[] = rawBuses.map((b) => ({
  ...b,
  bufferSizeFrames: null,
  underruns: 0,
  overruns: 0,
  limiter: defaultLimiter(),
}));

const rawInputs: Omit<AudioInput, "dsp">[] = [
  { id: "in_mic",      name: "Microphone",      kind: "microphone", device: "Shure SM7B (Focusrite)", gain: 0.78, muted: false, level: 0.42 },
  { id: "in_sys",      name: "System Audio",    kind: "system",     device: "Stereo Mix (Realtek)",   gain: 0.60, muted: false, level: 0.20 },
  { id: "in_discord",  name: "Discord",         kind: "app",        device: "CABLE Output (VAC 1)",   gain: 0.72, muted: false, level: 0.35 },
  { id: "in_browser",  name: "Browser",         kind: "app",        device: "CABLE Output (VAC 2)",   gain: 0.55, muted: true,  level: 0.00 },
  { id: "in_game",     name: "Game Audio",      kind: "app",        device: "CABLE Output (VAC 3)",   gain: 0.68, muted: false, level: 0.62 },
  { id: "in_music",    name: "Music",           kind: "app",        device: "CABLE Output (VAC 4)",   gain: 0.45, muted: false, level: 0.18 },
  { id: "in_alerts",   name: "Stream Alerts",   kind: "virtual",    device: "Virtual Cable (Streamlabs)", gain: 0.80, muted: false, level: 0.05 },
  { id: "in_guest",    name: "Guest Mic",       kind: "microphone", device: "USB Microphone (Blue Yeti)", gain: 0.65, muted: false, level: 0.30 },
  { id: "in_loop",     name: "Loopback A1",     kind: "loopback",   device: "Headphones (loopback)",  gain: 0.50, muted: false, level: 0.00 },
  { id: "in_aux",      name: "Aux Input",       kind: "microphone", device: "Line In (Focusrite)",    gain: 0.40, muted: true,  level: 0.00 },
];

export const mockInputs: AudioInput[] = rawInputs.map((i) => ({
  ...i,
  dsp: defaultDspConfig(),
}));

/**
 * Sends are stored sparsely — only enabled or trimmed sends are listed.
 * Missing (input, bus) pairs mean "no send".
 */
export const mockSends: Send[] = [
  // mic everywhere it makes sense
  { inputId: "in_mic",      busId: "A1", enabled: true,  gain: 0.75, muted: false },
  { inputId: "in_mic",      busId: "B1", enabled: true,  gain: 0.78, muted: false },
  { inputId: "in_mic",      busId: "B2", enabled: true,  gain: 0.75, muted: false },

  // system to monitor + stream
  { inputId: "in_sys",      busId: "A1", enabled: true,  gain: 0.60, muted: false },
  { inputId: "in_sys",      busId: "B1", enabled: true,  gain: 0.55, muted: false },

  // discord to monitor + stream
  { inputId: "in_discord",  busId: "A1", enabled: true,  gain: 0.70, muted: false },
  { inputId: "in_discord",  busId: "B1", enabled: true,  gain: 0.68, muted: false },

  // game to stream
  { inputId: "in_game",     busId: "B1", enabled: true,  gain: 0.72, muted: false },

  // music to monitor (private listening)
  { inputId: "in_music",    busId: "A1", enabled: true,  gain: 0.40, muted: false },

  // alerts to stream
  { inputId: "in_alerts",   busId: "B1", enabled: true,  gain: 0.85, muted: false },

  // guest mic to monitor + stream + record
  { inputId: "in_guest",    busId: "A1", enabled: true,  gain: 0.62, muted: false },
  { inputId: "in_guest",    busId: "B1", enabled: true,  gain: 0.64, muted: false },
  { inputId: "in_guest",    busId: "B2", enabled: true,  gain: 0.62, muted: false },
];

export const mockPresets: Preset[] = [
  { id: "preset_stream",  name: "Stream — Twitch",  version: 2, createdAt: Date.now() - 86400000 * 7,  updatedAt: Date.now() - 3600000 },
  { id: "preset_podcast", name: "Podcast",          version: 2, createdAt: Date.now() - 86400000 * 14, updatedAt: Date.now() - 86400000 * 2 },
  { id: "preset_solo",    name: "Solo Practice",    version: 2, createdAt: Date.now() - 86400000 * 21, updatedAt: Date.now() - 86400000 * 10 },
  { id: "preset_old",     name: "Old Setup (v1)",   version: 1, createdAt: Date.now() - 86400000 * 60, updatedAt: Date.now() - 86400000 * 45 },
];

export const mockStreamSetupSteps: StreamSetupStep[] = [
  {
    id: "vcable",
    title: "Virtual cable installed",
    status: "ok",
    detail: "VB-Cable detected and ready.",
  },
  {
    id: "samplerate",
    title: "Sample rates match (48 kHz)",
    status: "ok",
    detail: "All devices in the chain agree on 48 kHz.",
  },
  {
    id: "busdevice",
    title: "Stream bus configured",
    status: "ok",
    detail: "B1 → CABLE Input (VB-Audio Virtual Cable).",
    actionLabel: "Change device",
  },
  {
    id: "routing",
    title: "Inputs routed to Stream",
    status: "warning",
    detail: "Microphone, System, Game routed. Add Music? You'll need it for stream alerts.",
    actionLabel: "Open matrix",
  },
  {
    id: "captureapp",
    title: "Capture app configured",
    status: "pending",
    detail: "Open guides for OBS / Discord / Zoom and pick CABLE Output as input.",
    actionLabel: "Show guides",
  },
  {
    id: "enabled",
    title: "Stream bus enabled",
    status: "ok",
    detail: "B1 is live. Mute it if you need to step away.",
  },
];

/**
 * Convenience lookup: BusId → role color CSS variable.
 */
export function busAccentVar(id: BusId): string {
  return `var(--am-bus-${id.toLowerCase()})`;
}

export function busAccentMutedVar(id: BusId): string {
  return `var(--am-bus-${id.toLowerCase()}-muted)`;
}
