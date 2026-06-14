use cpal::traits::{DeviceTrait, HostTrait};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub default_sample_rate: u32,
    pub channels: u16,
    pub is_default: bool,
}

#[derive(Debug, Serialize)]
pub struct DeviceListError {
    pub message: String,
}

impl<E: std::fmt::Display> From<E> for DeviceListError {
    fn from(e: E) -> Self {
        Self {
            message: e.to_string(),
        }
    }
}

fn collect(
    devices: impl Iterator<Item = cpal::Device>,
    default_name: Option<String>,
    is_input: bool,
) -> Vec<DeviceInfo> {
    devices
        .filter_map(|d| {
            let name = d.name().ok()?;
            let config = if is_input {
                d.default_input_config().ok()?
            } else {
                d.default_output_config().ok()?
            };
            Some(DeviceInfo {
                id: name.clone(),
                is_default: default_name.as_deref() == Some(name.as_str()),
                name,
                default_sample_rate: config.sample_rate().0,
                channels: config.channels(),
            })
        })
        .collect()
}

pub fn list_input_devices() -> Result<Vec<DeviceInfo>, DeviceListError> {
    let host = cpal::default_host();
    let default_name = host.default_input_device().and_then(|d| d.name().ok());
    Ok(collect(host.input_devices()?, default_name, true))
}

pub fn list_output_devices() -> Result<Vec<DeviceInfo>, DeviceListError> {
    let host = cpal::default_host();
    let default_name = host.default_output_device().and_then(|d| d.name().ok());
    Ok(collect(host.output_devices()?, default_name, false))
}
