import { invoke } from "@tauri-apps/api/core";
import type { DeviceInfo } from "../types/engine";

export const listInputDevices = (): Promise<DeviceInfo[]> =>
  invoke<DeviceInfo[]>("list_input_devices");

export const listOutputDevices = (): Promise<DeviceInfo[]> =>
  invoke<DeviceInfo[]>("list_output_devices");
