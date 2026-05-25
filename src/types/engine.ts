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
