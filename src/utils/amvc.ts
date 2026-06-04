import { invoke } from "@tauri-apps/api/core";
import type { DeviceInfo } from "../types/engine";
import { listOutputDevices, setBusDevice } from "../ipc/commands";

// ── Types ─────────────────────────────────────────────────────────────────────

export type AmvcInstallStatus =
  | "not-installed"
  | "installed-healthy"
  | "installed-degraded"
  | "needs-repair"
  | "needs-reboot";

export interface AmvcStatus {
  status: AmvcInstallStatus;
  found: number;
  expected: number;
  driver_in_store: boolean;
  reboot_pending: boolean;
  names_aligned: boolean;
  detected: string[];
  missing: string[];
}

// ── Canonical endpoint names ──────────────────────────────────────────────────

export const AMVC_ENDPOINTS = {
  cable1Playback:  "AudioManager Cable 1 Playback",
  cable1Recording: "AudioManager Cable 1 Recording",
  cable2Playback:  "AudioManager Cable 2 Playback",
  cable2Recording: "AudioManager Cable 2 Recording",
  streamOutput:    "AudioManager Stream Output",
  voiceOutput:     "AudioManager Voice Output",
} as const;

export type AmvcEndpointName = (typeof AMVC_ENDPOINTS)[keyof typeof AMVC_ENDPOINTS];

const AMVC_PREFIX = "AudioManager ";

export function isAmvcEndpoint(deviceName: string): boolean {
  return deviceName.startsWith(AMVC_PREFIX);
}

export function amvcEndpointRole(deviceName: string): string | null {
  switch (deviceName as AmvcEndpointName) {
    case AMVC_ENDPOINTS.cable1Playback:  return "Cable 1 — app audio into mixer";
    case AMVC_ENDPOINTS.cable1Recording: return "Cable 1 — capture app audio";
    case AMVC_ENDPOINTS.cable2Playback:  return "Cable 2 — second app audio";
    case AMVC_ENDPOINTS.cable2Recording: return "Cable 2 — second capture";
    case AMVC_ENDPOINTS.streamOutput:    return "B1 stream bus → OBS/streaming";
    case AMVC_ENDPOINTS.voiceOutput:     return "B2 voice bus → Discord/Zoom";
    default:                             return null;
  }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

export const amvcStatus = (): Promise<AmvcStatus> =>
  invoke<AmvcStatus>("amvc_status");

export const amvcInstall = (infPath: string): Promise<string> =>
  invoke<string>("amvc_install", { infPath });

export const amvcRepair = (infPath: string): Promise<string> =>
  invoke<string>("amvc_repair", { infPath });

export const amvcUninstall = (): Promise<string> =>
  invoke<string>("amvc_uninstall");

export const amvcRenameEndpoints = (): Promise<string> =>
  invoke<string>("amvc_rename_endpoints");

// ── Routing preset ────────────────────────────────────────────────────────────

export interface PresetResult {
  b1Applied: boolean;
  b2Applied: boolean;
  b1DeviceId: string | null;
  b2DeviceId: string | null;
}

/**
 * Wire B1 → Stream Output and B2 → Voice Output using the existing
 * setBusDevice command. Precondition: status == "installed-healthy".
 */
export async function applyAmvcRoutingPreset(): Promise<PresetResult> {
  const outputs: DeviceInfo[] = await listOutputDevices();

  const streamOut = outputs.find(d => d.name === AMVC_ENDPOINTS.streamOutput) ?? null;
  const voiceOut  = outputs.find(d => d.name === AMVC_ENDPOINTS.voiceOutput)  ?? null;

  await Promise.all([
    streamOut ? setBusDevice("B1", streamOut.id) : Promise.resolve(null),
    voiceOut  ? setBusDevice("B2", voiceOut.id)  : Promise.resolve(null),
  ]);

  return {
    b1Applied:   !!streamOut,
    b2Applied:   !!voiceOut,
    b1DeviceId:  streamOut?.id ?? null,
    b2DeviceId:  voiceOut?.id  ?? null,
  };
}
