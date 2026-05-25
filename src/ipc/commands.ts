import { invoke } from "@tauri-apps/api/core";
import type { DeviceInfo, PassthroughStatus } from "../types/engine";

export const listInputDevices = (): Promise<DeviceInfo[]> =>
  invoke<DeviceInfo[]>("list_input_devices");

export const listOutputDevices = (): Promise<DeviceInfo[]> =>
  invoke<DeviceInfo[]>("list_output_devices");

// Tauri 2 IPC converts camelCase keys to snake_case on the Rust side.
export const startPassthrough = (inputId: string, outputId: string): Promise<void> =>
  invoke<void>("start_passthrough", { inputId, outputId });

export const stopPassthrough = (): Promise<void> =>
  invoke<void>("stop_passthrough");

export const getPassthroughStatus = (): Promise<PassthroughStatus> =>
  invoke<PassthroughStatus>("get_passthrough_status");
