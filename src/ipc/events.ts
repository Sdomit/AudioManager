import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DeviceDiff } from "../types/engine";

export const DEVICES_CHANGED_EVENT = "devices-changed";

/**
 * Subscribe to backend hotplug notifications (Phase 11). Resolves to an
 * unlisten function. Never rejects — outside a Tauri webview (unit tests,
 * plain browser) it resolves to a no-op so callers can subscribe
 * unconditionally without guarding the environment.
 */
export async function onDevicesChanged(
  handler: (diff: DeviceDiff) => void,
): Promise<UnlistenFn> {
  try {
    return await listen<DeviceDiff>(DEVICES_CHANGED_EVENT, (event) =>
      handler(event.payload),
    );
  } catch {
    return () => {};
  }
}
