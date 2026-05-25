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
}
