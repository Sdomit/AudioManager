import { invoke } from "@tauri-apps/api/core";
import type { AmvcHealthStatus, AmvcQueryResult } from "../types/engine";
import type { DeviceInfo } from "../types/engine";
import { listOutputDevices, setBusDevice } from "../ipc/commands";

export type { AmvcHealthStatus, AmvcQueryResult } from "../types/engine";

/**
 * Parse the raw stdout string from `amvc-helper status --json`.
 * Pure function — no Tauri dependency, safe to unit-test.
 */
export function parseAmvcHelperOutput(stdout: string): AmvcQueryResult {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(stdout) as Record<string, unknown>;
  } catch (e) {
    return { kind: "unavailable", reason: `json parse error: ${String(e)}` };
  }
  if (typeof data.status !== "string") {
    return { kind: "unavailable", reason: "missing or invalid 'status' field" };
  }
  return {
    kind: "ok",
    status: data.status as AmvcHealthStatus,
    found: typeof data.found === "number" ? data.found : 0,
    expected: typeof data.expected === "number" ? data.expected : 6,
    driver_in_store: data.driver_in_store === true,
    reboot_pending: data.reboot_pending === true,
    names_aligned: data.names_aligned === true,
    detected: Array.isArray(data.detected)
      ? (data.detected as string[]).filter((v) => typeof v === "string")
      : [],
    missing: Array.isArray(data.missing)
      ? (data.missing as string[]).filter((v) => typeof v === "string")
      : [],
  };
}

/**
 * Driver is installed AND every endpoint is present. Useful as a positive
 * gate for features that require a fully functional virtual cable.
 */
export function isAmvcHealthy(r: AmvcQueryResult): boolean {
  return r.kind === "ok" && r.status === "installed-healthy";
}

/** Query the helper binary via Tauri. Never throws — returns unavailable on any error. */
export function queryAmvcHelper(): Promise<AmvcQueryResult> {
  return invoke<AmvcQueryResult>("query_amvc_helper");
}

/** Spawn the helper installer. Resolves immediately; helper runs in background. */
export function launchAmvcInstaller(): Promise<void> {
  return invoke<void>("launch_amvc_installer");
}

// ── Routing preset ────────────────────────────────────────────────────────────

export interface AmvcPresetResult {
  b1Applied: boolean;
  b2Applied: boolean;
  b1DeviceId: string | null;
  b2DeviceId: string | null;
}

/**
 * Wire B1 → Stream Output and B2 → Voice Output using the existing
 * setBusDevice command. Precondition: status == "installed-healthy".
 */
export async function applyAmvcRoutingPreset(): Promise<AmvcPresetResult> {
  const outputs: DeviceInfo[] = await listOutputDevices();

  const streamOut = outputs.find(d => d.name === "AudioManager Stream Output") ?? null;
  const voiceOut  = outputs.find(d => d.name === "AudioManager Voice Output")  ?? null;

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
