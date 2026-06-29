//! Windows audio endpoint control for the Mini Controller.
//!
//! Enumerates render/capture endpoints with their real MMDevice IDs, reads and
//! sets per-endpoint master volume + mute (`IAudioEndpointVolume`), and switches
//! the OS default endpoint (`IPolicyConfig::SetDefaultEndpoint`, an undocumented
//! COM interface declared manually below — it is absent from the `windows`
//! crate). Distinct from [`super::devices`] (cpal), whose `id` is a device
//! *name* and cannot drive Core Audio. COM-init idiom matches [`crate::amvc_sync`]:
//! a best-effort apartment-threaded `CoInitializeEx` per call.

use serde::{Deserialize, Serialize};

/// One render or capture endpoint, keyed by its real MMDevice id (the string
/// `IPolicyConfig` / `IMMDeviceEnumerator::GetDevice` consume — NOT a cpal name).
#[derive(Debug, Clone, Serialize)]
pub struct EndpointInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

/// Live master volume (0.0..=1.0 scalar) + mute of one endpoint.
#[derive(Debug, Clone, Serialize)]
pub struct EndpointVolume {
    pub volume: f32,
    pub muted: bool,
}

/// Serializable error for the endpoint-control IPC commands. Mirrors
/// [`super::devices::DeviceListError`]; deliberately NOT `Display` so the
/// blanket `From` below does not overlap the reflexive `From<T> for T`.
#[derive(Debug, Serialize)]
pub struct EndpointError {
    pub message: String,
}

impl<E: std::fmt::Display> From<E> for EndpointError {
    fn from(e: E) -> Self {
        Self { message: e.to_string() }
    }
}

/// Audio data-flow direction picked by the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Render,
    Capture,
}

#[cfg(windows)]
mod imp {
    // COM vtable method names (GetMixFormat, SetDefaultEndpoint, …) must stay
    // PascalCase to match the interface; allow it for this whole module.
    #![allow(non_snake_case)]
    use super::*;
    use std::ffi::c_void;
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows_core::{interface, GUID, HRESULT, IUnknown, IUnknown_Vtbl, PCWSTR};
    use windows::Win32::Media::Audio::{
        eCapture, eCommunications, eConsole, eMultimedia, eRender, EDataFlow, ERole, IMMDevice,
        IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED, STGM_READ,
    };

    /// CLSID_PolicyConfigClient — the COM object that exposes `IPolicyConfig`.
    const CLSID_POLICY_CONFIG_CLIENT: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);

    /// `IPolicyConfig` (Win7+ variant, IID f8679f50-…). Undocumented; not in the
    /// `windows` crate. Every method before `SetDefaultEndpoint` is declared
    /// only to fix the vtable layout — their arg types are ABI-shaped (pointer /
    /// i32 / i64), not semantically exact, since they are never called. This is
    /// the same interface EarTrumpet / AudioDeviceCmdlets use to set defaults.
    #[interface("f8679f50-850a-41cf-9c72-430f290290c8")]
    unsafe trait IPolicyConfig: IUnknown {
        unsafe fn GetMixFormat(&self, name: PCWSTR, fmt: *mut *mut c_void) -> HRESULT;
        unsafe fn GetDeviceFormat(&self, name: PCWSTR, def: i32, fmt: *mut *mut c_void) -> HRESULT;
        unsafe fn ResetDeviceFormat(&self, name: PCWSTR) -> HRESULT;
        unsafe fn SetDeviceFormat(
            &self,
            name: PCWSTR,
            endpoint_fmt: *mut c_void,
            mix_fmt: *mut c_void,
        ) -> HRESULT;
        unsafe fn GetProcessingPeriod(
            &self,
            name: PCWSTR,
            def: i32,
            default_period: *mut i64,
            min_period: *mut i64,
        ) -> HRESULT;
        unsafe fn SetProcessingPeriod(&self, name: PCWSTR, period: *mut i64) -> HRESULT;
        unsafe fn GetShareMode(&self, name: PCWSTR, mode: *mut c_void) -> HRESULT;
        unsafe fn SetShareMode(&self, name: PCWSTR, mode: *mut c_void) -> HRESULT;
        unsafe fn GetPropertyValue(
            &self,
            name: PCWSTR,
            key: *const c_void,
            value: *mut c_void,
        ) -> HRESULT;
        unsafe fn SetPropertyValue(
            &self,
            name: PCWSTR,
            key: *const c_void,
            value: *mut c_void,
        ) -> HRESULT;
        unsafe fn SetDefaultEndpoint(&self, device_id: PCWSTR, role: ERole) -> HRESULT;
        unsafe fn SetEndpointVisibility(&self, device_id: PCWSTR, visible: i32) -> HRESULT;
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn dataflow(dir: Direction) -> EDataFlow {
        match dir {
            Direction::Render => eRender,
            Direction::Capture => eCapture,
        }
    }

    unsafe fn enumerator() -> windows::core::Result<IMMDeviceEnumerator> {
        // Best effort: ignore "already initialized on this thread" results.
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
    }

    unsafe fn friendly_name(dev: &IMMDevice) -> String {
        if let Ok(store) = dev.OpenPropertyStore(STGM_READ) {
            if let Ok(pv) = store.GetValue(&PKEY_Device_FriendlyName) {
                let p = pv.Anonymous.Anonymous.Anonymous.pwszVal;
                if !p.is_null() {
                    if let Ok(s) = PCWSTR(p.0).to_string() {
                        return s;
                    }
                }
            }
        }
        String::new()
    }

    unsafe fn endpoint_volume(id: &str) -> Result<IAudioEndpointVolume, EndpointError> {
        let en = enumerator()?;
        let w = wide(id);
        let dev = en.GetDevice(PCWSTR(w.as_ptr()))?;
        let vol: IAudioEndpointVolume = dev.Activate(CLSCTX_ALL, None)?;
        Ok(vol)
    }

    pub fn list_endpoints(dir: Direction) -> Result<Vec<EndpointInfo>, EndpointError> {
        unsafe {
            let en = enumerator()?;
            let default_id = en
                .GetDefaultAudioEndpoint(dataflow(dir), eConsole)
                .ok()
                .and_then(|d| d.GetId().ok())
                .and_then(|p| p.to_string().ok());
            let coll = en.EnumAudioEndpoints(dataflow(dir), DEVICE_STATE_ACTIVE)?;
            let count = coll.GetCount()?;
            let mut out = Vec::with_capacity(count as usize);
            for i in 0..count {
                let dev = match coll.Item(i) {
                    Ok(d) => d,
                    Err(_) => continue,
                };
                let id = match dev.GetId() {
                    Ok(p) => p.to_string().unwrap_or_default(),
                    Err(_) => continue,
                };
                if id.is_empty() {
                    continue;
                }
                let is_default = default_id.as_deref() == Some(id.as_str());
                out.push(EndpointInfo { id, name: friendly_name(&dev), is_default });
            }
            Ok(out)
        }
    }

    pub fn default_endpoint_id(dir: Direction) -> Result<Option<String>, EndpointError> {
        unsafe {
            let en = enumerator()?;
            Ok(en
                .GetDefaultAudioEndpoint(dataflow(dir), eConsole)
                .ok()
                .and_then(|d| d.GetId().ok())
                .and_then(|p| p.to_string().ok()))
        }
    }

    pub fn set_default_endpoint(id: &str) -> Result<(), EndpointError> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let policy: IPolicyConfig =
                CoCreateInstance(&CLSID_POLICY_CONFIG_CLIENT, None, CLSCTX_ALL)?;
            let w = wide(id);
            // Set all three roles so the device is default for playback,
            // multimedia, and communications alike (what the Sound dialog does).
            for role in [eConsole, eMultimedia, eCommunications] {
                policy.SetDefaultEndpoint(PCWSTR(w.as_ptr()), role).ok()?;
            }
            Ok(())
        }
    }

    pub fn get_endpoint_volume(id: &str) -> Result<EndpointVolume, EndpointError> {
        unsafe {
            let vol = endpoint_volume(id)?;
            Ok(EndpointVolume {
                volume: vol.GetMasterVolumeLevelScalar()?,
                muted: vol.GetMute()?.as_bool(),
            })
        }
    }

    pub fn set_endpoint_volume(id: &str, level: f32) -> Result<(), EndpointError> {
        unsafe {
            endpoint_volume(id)?
                .SetMasterVolumeLevelScalar(level.clamp(0.0, 1.0), std::ptr::null())?;
            Ok(())
        }
    }

    pub fn set_endpoint_mute(id: &str, muted: bool) -> Result<(), EndpointError> {
        unsafe {
            endpoint_volume(id)?.SetMute(muted, std::ptr::null())?;
            Ok(())
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// Live COM smoke — needs a real audio device, so ignored by default.
        /// Run with `cargo test --manifest-path src-tauri/Cargo.toml -- --ignored
        /// endpoint_ctl_smoke --nocapture`.
        #[test]
        #[ignore]
        fn endpoint_ctl_smoke() {
            let outs = list_endpoints(Direction::Render).expect("list render");
            assert!(!outs.is_empty(), "expected at least one render endpoint");
            let def = outs.iter().find(|e| e.is_default).expect("a default render endpoint");
            let v = get_endpoint_volume(&def.id).expect("read volume");
            println!("default render: {} vol={:.2} muted={}", def.name, v.volume, v.muted);
            // Round-trip the volume (restore after).
            set_endpoint_volume(&def.id, v.volume).expect("set volume");
        }
    }
}

#[cfg(windows)]
pub use imp::*;

// Non-Windows stubs keep the crate building off-Windows (the app ships
// Windows-only; these never run). Mirrors the `amvc_sync` stub approach.
#[cfg(not(windows))]
mod stub {
    use super::*;

    fn unsupported<T>() -> Result<T, EndpointError> {
        Err(EndpointError { message: "endpoint control is Windows-only".into() })
    }

    pub fn list_endpoints(_dir: Direction) -> Result<Vec<EndpointInfo>, EndpointError> {
        unsupported()
    }
    pub fn default_endpoint_id(_dir: Direction) -> Result<Option<String>, EndpointError> {
        unsupported()
    }
    pub fn set_default_endpoint(_id: &str) -> Result<(), EndpointError> {
        unsupported()
    }
    pub fn get_endpoint_volume(_id: &str) -> Result<EndpointVolume, EndpointError> {
        unsupported()
    }
    pub fn set_endpoint_volume(_id: &str, _level: f32) -> Result<(), EndpointError> {
        unsupported()
    }
    pub fn set_endpoint_mute(_id: &str, _muted: bool) -> Result<(), EndpointError> {
        unsupported()
    }
}

#[cfg(not(windows))]
pub use stub::*;
