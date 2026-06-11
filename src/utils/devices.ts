/**
 * Device + value helpers preserved from the legacy App shell.
 *
 * Phase C will reach for these when wiring the AudioManager UI to the
 * real Tauri command surface. They live here so the shell swap in
 * Phase B doesn't lose them.
 */

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export function shortName(deviceId: string): string {
  return deviceId.length > 42 ? `${deviceId.slice(0, 40)}…` : deviceId;
}

export function extractErrorMessage(e: unknown): string {
  if (typeof e === "object" && e !== null && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

const AUDIOMANAGER_PREFIX = "audiomanager ";

/** True when a device name belongs to AudioManager's own virtual cable. */
export function isAudioManagerVirtualDevice(deviceName: string): boolean {
  return deviceName.toLowerCase().startsWith(AUDIOMANAGER_PREFIX);
}

/**
 * Role hint for AudioManager-branded endpoints.
 * Returns null for devices that don't carry the "AudioManager " prefix.
 */
export function getAudioManagerDeviceHint(deviceName: string): string | null {
  const lower = deviceName.toLowerCase();
  if (!lower.startsWith(AUDIOMANAGER_PREFIX)) return null;
  if (lower.includes("stream output")) return "AudioManager: B1 stream bus → OBS";
  if (lower.includes("voice output")) return "AudioManager: B2 voice bus → Discord/Zoom/Teams";
  if (lower.includes("cable") && lower.includes("playback")) return "AudioManager: app → mixer input (render)";
  if (lower.includes("cable") && lower.includes("recording")) return "AudioManager: mixer captures app audio (capture)";
  return "AudioManager virtual device";
}

export function isLikelyVirtualAudioDevice(deviceName: string): boolean {
  if (isAudioManagerVirtualDevice(deviceName)) return true;
  const name = deviceName.toLowerCase();
  const patterns = [
    "vb-audio",
    "vb-cable",
    "cable input",
    "cable output",
    "virtual cable",
    "virtual audio cable",
    "vac",
    "voicemeeter",
    "obs",
    "loopback",
  ];
  return patterns.some((pattern) => name.includes(pattern));
}

export function getVirtualDeviceHint(deviceName: string): string | null {
  const amHint = getAudioManagerDeviceHint(deviceName);
  if (amHint) return amHint;
  const name = deviceName.toLowerCase();
  if (name.includes("cable input")) {
    return "Virtual (playback for OBS/Discord)";
  }
  if (name.includes("cable output")) {
    return "Virtual (capture side)";
  }
  if (name.includes("vb-cable") || name.includes("vb-audio")) {
    return "Virtual audio cable";
  }
  if (name.includes("voicemeeter")) {
    return "Virtual mixer";
  }
  if (name.includes("obs")) {
    return "OBS virtual output";
  }
  if (name.includes("loopback")) {
    return "Loopback device";
  }
  return null;
}
