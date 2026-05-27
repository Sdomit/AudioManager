export interface DeviceInfo {
  id: string;
  name: string;
  default_sample_rate: number;
  channels: number;
  is_default: boolean;
}

export interface DeviceListError {
  message: string;
}

export interface PassthroughStatus {
  running: boolean;
  input_device: string | null;
  output_device: string | null;
}

// Rust field names are snake_case; serde serializes them as-is.
export interface Route {
  input_id: string;
  output_id: string;
  enabled: boolean;
  active: boolean;
  /** Per-route gain in [0.0, 2.0]. Default 1.0 (= 100%). */
  volume: number;
  /** True when this input is muted (contributes silence). */
  muted: boolean;
}

export interface EngineStatus {
  status: "stopped" | "running" | "error";
  output_device: string | null;
  active_inputs: string[];
  input_peaks: number[];
  output_peak: number;
  clipped_recently: boolean;
  last_error: string | null;
}

export interface PresetSummary {
  name: string;
  saved_at_utc: string;
  route_count: number;
}

export interface PresetLoadWarning {
  code: string;
  message: string;
}

export interface PresetLoadResult {
  preset: PresetSummary;
  routes: Route[];
  warnings: PresetLoadWarning[];
}
