import type { DeviceInfo } from "../types/engine";
import type { BusId } from "../components/audio-manager/types";
import { isAudioManagerVirtualDevice } from "./devices";

export const AMVC_STREAM_OUTPUT = "AudioManager Stream Output";
export const AMVC_VOICE_OUTPUT = "AudioManager Voice Output";
export const AMVC_CABLE_1_PLAYBACK = "AudioManager Cable 1 Playback";
export const AMVC_CABLE_1_RECORDING = "AudioManager Cable 1 Recording";
export const AMVC_CABLE_2_PLAYBACK = "AudioManager Cable 2 Playback";
export const AMVC_CABLE_2_RECORDING = "AudioManager Cable 2 Recording";

/** All six canonical AudioManager virtual cable endpoints. */
export const AMVC_ALL_DEVICE_NAMES: readonly string[] = [
  AMVC_CABLE_1_PLAYBACK,
  AMVC_CABLE_1_RECORDING,
  AMVC_CABLE_2_PLAYBACK,
  AMVC_CABLE_2_RECORDING,
  AMVC_STREAM_OUTPUT,
  AMVC_VOICE_OUTPUT,
];

/** Default output-device target per bus when AudioManager cable is present. */
export const AMVC_BUS_OUTPUT_TARGETS: Partial<Record<BusId, string>> = {
  B1: AMVC_STREAM_OUTPUT,
  B2: AMVC_VOICE_OUTPUT,
};

/**
 * Find the AudioManager output device suggested for a given bus.
 * Returns the device id (same as name) when found, null otherwise.
 * Never auto-assigns — callers must act on the suggestion explicitly.
 */
export function suggestAmvcBusDevice(
  busId: BusId,
  outputDevices: DeviceInfo[],
): string | null {
  const target = AMVC_BUS_OUTPUT_TARGETS[busId];
  if (!target) return null;
  const found = outputDevices.find(
    (d) => d.name.toLowerCase() === target.toLowerCase(),
  );
  return found?.id ?? null;
}

/** All AudioManager capture (Recording) endpoints present in the given input list. */
export function findAmvcCaptureDevices(inputDevices: DeviceInfo[]): DeviceInfo[] {
  return inputDevices.filter(
    (d) =>
      isAudioManagerVirtualDevice(d.name) &&
      d.name.toLowerCase().includes("recording"),
  );
}

/** True if any AudioManager-branded endpoint appears in either device list. */
export function hasAnyAmvcDevice(
  outputDevices: DeviceInfo[],
  inputDevices: DeviceInfo[],
): boolean {
  return [...outputDevices, ...inputDevices].some((d) =>
    isAudioManagerVirtualDevice(d.name),
  );
}

/**
 * Ordering comparator for the DevicePicker list. AudioManager-branded
 * endpoints sort first; within each tier the system default sorts before
 * the rest, then alphabetical. Pure — extracted so it can be unit-tested
 * independently of the React component.
 */
export function compareDevicesForPicker(a: DeviceInfo, b: DeviceInfo): number {
  const aAm = isAudioManagerVirtualDevice(a.name);
  const bAm = isAudioManagerVirtualDevice(b.name);
  if (aAm !== bAm) return aAm ? -1 : 1;
  if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
  return a.name.localeCompare(b.name);
}
