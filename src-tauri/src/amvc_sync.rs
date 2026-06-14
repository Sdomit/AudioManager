//! AMVC endpoint name auto-sync.
//!
//! Renames the four AudioManager Virtual Cable *render* endpoints so their
//! Windows name token reflects the bus they back (A1/A2/B1/B2), while keeping
//! the "AudioManager" brand prefix so the app's own device detection (which
//! matches the substring "audiomanager ") keeps recognizing them.
//!
//! The write goes through the MMDevice property store: `SetValue` on
//! PKEY_Device_DeviceDesc (`{a45c254e-...},2`) + `Commit`. DeviceDesc is the
//! field Windows composes the visible name from — "<DeviceDesc> (<interface
//! name>)" — and the same one mmsys.cpl's rename dialog writes. The endpoint
//! Properties ACL grants BUILTIN\Users SetValue, so no elevation is needed,
//! and the property-change notification makes the new name visible to the
//! audio service and pickers immediately. (PKEY_Device_FriendlyName, pid=14,
//! is policy-blocked — E_ACCESSDENIED at any privilege; do not target it.)
//!
//! The `,14` registry value (the token `amvc-helper detect` reports) is
//! display-dead — Windows never composes from it — but it is factory-distinct
//! per endpoint and our renames never touch it, so it serves as the stable
//! identity key mapping endpoints to bus slots. [`restore_endpoints`]
//! deliberately stamps the distinct factory labels rather than the literal
//! factory DeviceDesc ("Speakers" on all four — the indistinct state this
//! module exists to fix).

use serde::Serialize;

#[cfg(windows)]
use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_SET_VALUE};
#[cfg(windows)]
use winreg::RegKey;

#[cfg(windows)]
use std::mem::ManuallyDrop;
#[cfg(windows)]
use windows::core::{GUID, PCWSTR, PWSTR};
#[cfg(windows)]
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
#[cfg(windows)]
use windows::Win32::Foundation::PROPERTYKEY;
#[cfg(windows)]
use windows::Win32::Media::Audio::{
    eRender, IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE,
};
#[cfg(windows)]
use windows::Win32::System::Com::StructuredStorage::{
    PropVariantClear, PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
};
#[cfg(windows)]
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemAlloc, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
    STGM_READWRITE,
};
#[cfg(windows)]
use windows::Win32::System::Variant::VT_LPWSTR;
#[cfg(windows)]
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;

/// MMDevices render-endpoint root.
#[cfg(windows)]
const RENDER_PATH: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render";
/// Per-endpoint identity token (REG_SZ). Display-dead — Windows composes the
/// visible name from `,2` (DeviceDesc), not from this — but factory-distinct
/// per endpoint and untouched by our renames, so it's the stable bus-slot key.
#[cfg(windows)]
const NAME_VALUE: &str = "{a45c254e-df1c-4efd-8020-67d146a850e0},14";
/// PKEY_Device_DeviceDesc as a registry value (REG_SZ; "Speakers" from the
/// factory on all four render endpoints). The distinct half of the composed
/// display name — the value the rename rewrites.
#[cfg(windows)]
const DESC_VALUE: &str = "{a45c254e-df1c-4efd-8020-67d146a850e0},2";
/// PKEY_Device_DeviceDesc for the COM property store — the writable display
/// token. The named PKEY_Device_FriendlyName constant (pid=14) is read-only
/// by audio-service policy; this (pid=2) is what mmsys.cpl renames write.
#[cfg(windows)]
const PKEY_DEVICE_DEVICEDESC: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0),
    pid: 2,
};
/// Factory name for each slot — used to restore defaults. `target_name` re-adds
/// the "AudioManager" prefix, yielding the original endpoint names.
#[cfg(windows)]
const FACTORY_LABELS: [&str; 4] =
    ["Cable 1 Playback", "Cable 2 Playback", "Stream Output", "Voice Output"];

/// One of the four routable AMVC render endpoints, in bus order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BusSlot {
    A1,
    A2,
    B1,
    B2,
}

impl BusSlot {
    fn idx(self) -> usize {
        match self {
            BusSlot::A1 => 0,
            BusSlot::A2 => 1,
            BusSlot::B1 => 2,
            BusSlot::B2 => 3,
        }
    }
}

/// One endpoint's current vs. desired name.
#[derive(Debug, Clone, Serialize)]
pub struct EndpointPlan {
    pub guid: String,
    pub slot: BusSlot,
    pub current: String,
    pub target: String,
    pub needs_change: bool,
}

/// Full sync plan: per-endpoint diffs plus whether everything is already
/// aligned and whether this process can open an endpoint Properties key for
/// write. True for normal users on AMVC endpoints (the ACL grants Users
/// SetValue); kept as a guard for locked-down machines.
#[derive(Debug, Clone, Serialize)]
pub struct SyncPlan {
    pub endpoints: Vec<EndpointPlan>,
    pub aligned: bool,
    pub can_write: bool,
}

/// Classify a current endpoint name to its bus slot. Recognizes both the
/// factory names ("AudioManager Cable 1 Playback", "Stream Output", "Voice
/// Output") and our brand-preserving renamed form ("AudioManager A1 ...") so a
/// re-sync after a rename still maps each endpoint to the same bus.
pub fn classify(name: &str) -> Option<BusSlot> {
    let n = name.to_ascii_lowercase();
    if !n.contains("audiomanager") {
        return None;
    }
    // Factory tokens.
    if n.contains("cable 1 playback") {
        return Some(BusSlot::A1);
    }
    if n.contains("cable 2 playback") {
        return Some(BusSlot::A2);
    }
    if n.contains("stream output") {
        return Some(BusSlot::B1);
    }
    if n.contains("voice output") {
        return Some(BusSlot::B2);
    }
    // Already-renamed tokens ("audiomanager a1 monitor", etc.).
    if n.contains("audiomanager a1") {
        return Some(BusSlot::A1);
    }
    if n.contains("audiomanager a2") {
        return Some(BusSlot::A2);
    }
    if n.contains("audiomanager b1") {
        return Some(BusSlot::B1);
    }
    if n.contains("audiomanager b2") {
        return Some(BusSlot::B2);
    }
    None
}

/// Brand-preserving target name for a bus label. Keeps the "AudioManager"
/// prefix (so detection keeps matching) unless the label already carries it.
pub fn target_name(bus_label: &str) -> String {
    let label = bus_label.trim();
    if label.to_ascii_lowercase().contains("audiomanager") {
        label.to_string()
    } else {
        format!("AudioManager {label}")
    }
}

#[cfg(windows)]
fn validate_labels(bus_names: &[String]) -> Result<[String; 4], String> {
    if bus_names.len() != 4 {
        return Err(format!("expected 4 bus names (A1,A2,B1,B2), got {}", bus_names.len()));
    }
    Ok([
        bus_names[0].clone(),
        bus_names[1].clone(),
        bus_names[2].clone(),
        bus_names[3].clone(),
    ])
}

#[cfg(windows)]
fn probe_write(render: &RegKey) -> bool {
    for guid in render.enum_keys().flatten() {
        if render
            .open_subkey_with_flags(format!(r"{guid}\Properties"), KEY_READ | KEY_SET_VALUE)
            .is_ok()
        {
            return true;
        }
    }
    false
}

/// Read-only: enumerate AMVC render endpoints and diff their names against the
/// brand-preserving targets derived from the supplied bus labels.
#[cfg(windows)]
pub fn build_plan(bus_names: &[String]) -> Result<SyncPlan, String> {
    let labels = validate_labels(bus_names)?;
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let render = hklm
        .open_subkey(RENDER_PATH)
        .map_err(|e| format!("open MMDevices render key: {e}"))?;

    let mut endpoints = Vec::new();
    for guid in render.enum_keys().flatten() {
        let props = match render.open_subkey(format!(r"{guid}\Properties")) {
            Ok(k) => k,
            Err(_) => continue,
        };
        // `,14` identifies the endpoint (stable across renames); `,2` is the
        // displayed token we diff and rewrite.
        let token: String = match props.get_value(NAME_VALUE) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some(slot) = classify(&token) {
            let current: String = props.get_value(DESC_VALUE).unwrap_or_default();
            let target = target_name(&labels[slot.idx()]);
            let needs_change = current != target;
            endpoints.push(EndpointPlan { guid, slot, current, target, needs_change });
        }
    }
    endpoints.sort_by_key(|e| e.slot.idx());
    let aligned = endpoints.iter().all(|e| !e.needs_change);
    let can_write = probe_write(&render);
    Ok(SyncPlan { endpoints, aligned, can_write })
}

/// Build a VT_LPWSTR PROPVARIANT pointing at a fresh CoTaskMem copy of `s`.
/// Ownership of the allocation transfers into the PROPVARIANT; clear it with
/// `PropVariantClear` after `SetValue` (the property store makes its own copy).
#[cfg(windows)]
unsafe fn propvariant_string(s: &str) -> PROPVARIANT {
    let wide: Vec<u16> = s.encode_utf16().chain(std::iter::once(0)).collect();
    let bytes = wide.len() * std::mem::size_of::<u16>();
    let mem = CoTaskMemAlloc(bytes) as *mut u16;
    if !mem.is_null() {
        std::ptr::copy_nonoverlapping(wide.as_ptr(), mem, wide.len());
    }
    PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_LPWSTR,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: PROPVARIANT_0_0_0 { pwszVal: PWSTR(mem) },
            }),
        },
    }
}

/// Rewrite the DeviceDesc of every out-of-sync AMVC render endpoint via the
/// MMDevice property store. `SetValue` + `Commit` writes the backing registry
/// value AND fires the endpoint property-change notification, so the audio
/// service, Windows Sound, and the app's enumerator all see the new name
/// immediately — unlike a raw registry write. No elevation needed: the
/// endpoint Properties ACL grants Users SetValue, and pid=2 passes the audio
/// service's policy gate (pid=14 does not). Returns the number renamed.
#[cfg(windows)]
fn com_apply_targets(plan: &SyncPlan) -> Result<u32, String> {
    // Map registry GUID (lowercased) -> desired display name, classified from
    // the stable `,14` token. The COM device id embeds this GUID.
    let wanted: Vec<(String, String)> = plan
        .endpoints
        .iter()
        .filter(|e| e.needs_change)
        .map(|e| (e.guid.to_ascii_lowercase(), e.target.clone()))
        .collect();
    if wanted.is_empty() {
        return Ok(0);
    }

    unsafe {
        // Best effort: ignore "already initialized / changed mode" on this thread.
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| format!("create MMDeviceEnumerator: {e}"))?;
        // 0x0F = ACTIVE | DISABLED | NOTPRESENT | UNPLUGGED (all states).
        let collection = enumerator
            .EnumAudioEndpoints(eRender, DEVICE_STATE(0x0000_000F))
            .map_err(|e| format!("enumerate render endpoints: {e}"))?;
        let count = collection.GetCount().map_err(|e| format!("endpoint count: {e}"))?;

        let mut renamed = 0u32;
        for i in 0..count {
            let device = match collection.Item(i) {
                Ok(d) => d,
                Err(_) => continue,
            };
            // COM endpoint id embeds the registry GUID, e.g.
            // "{0.0.0.00000000}.{16a4b0f8-...}". Match it to the plan.
            let id = match device.GetId() {
                Ok(p) => p.to_string().unwrap_or_default().to_ascii_lowercase(),
                Err(_) => continue,
            };
            let target = match wanted.iter().find(|(guid, _)| id.contains(guid)) {
                Some((_, t)) => t,
                None => continue,
            };
            // Set the DeviceDesc (the distinct half of the composed name
            // Windows Sound shows) and commit — this fires the
            // property-change notification.
            let store_w = device
                .OpenPropertyStore(STGM_READWRITE)
                .map_err(|e| format!("open endpoint property store for write: {e}"))?;
            let mut pv = propvariant_string(target);
            let set = store_w.SetValue(&PKEY_DEVICE_DEVICEDESC, &pv);
            let _ = PropVariantClear(&mut pv);
            set.map_err(|e| format!("set DeviceDesc to '{target}': {e}"))?;
            store_w.Commit().map_err(|e| format!("commit rename '{target}': {e}"))?;
            renamed += 1;
        }
        Ok(renamed)
    }
}

/// Read every render endpoint's live composed friendly name (COM). Diagnostic.
#[cfg(windows)]
#[allow(dead_code)] // diagnostic; called only by ignored live-COM tests
pub fn com_read_friendly_names() -> Result<Vec<(String, String)>, String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| format!("create MMDeviceEnumerator: {e}"))?;
        let collection = enumerator
            .EnumAudioEndpoints(eRender, DEVICE_STATE(0x0000_000F))
            .map_err(|e| format!("enumerate: {e}"))?;
        let count = collection.GetCount().map_err(|e| format!("count: {e}"))?;
        let mut out = Vec::new();
        for i in 0..count {
            let device = match collection.Item(i) {
                Ok(d) => d,
                Err(_) => continue,
            };
            let id = device.GetId().ok().and_then(|p| p.to_string().ok()).unwrap_or_default();
            if let Ok(store) = device.OpenPropertyStore(windows::Win32::System::Com::STGM_READ) {
                if let Some(name) = read_friendly_name(&store) {
                    out.push((id, name));
                }
            }
        }
        Ok(out)
    }
}

#[cfg(windows)]
#[allow(dead_code)] // diagnostic helper for com_read_friendly_names (ignored tests)
fn read_friendly_name(store: &IPropertyStore) -> Option<String> {
    unsafe {
        let pv = store.GetValue(&PKEY_Device_FriendlyName).ok()?;
        let pwsz = pv.Anonymous.Anonymous.Anonymous.pwszVal;
        if pwsz.is_null() {
            return None;
        }
        PCWSTR(pwsz.0).to_string().ok()
    }
}

/// Apply the plan via MMDevice COM (writes + notifies; no elevation needed).
/// Returns a fresh plan reflecting the new names.
#[cfg(windows)]
pub fn apply_plan(bus_names: &[String]) -> Result<SyncPlan, String> {
    let plan = build_plan(bus_names)?;
    com_apply_targets(&plan)?;
    build_plan(bus_names)
}

/// Restore every AMVC render endpoint to its factory-label display name
/// ("AudioManager Cable 1 Playback", …). Deliberately NOT the literal factory
/// DeviceDesc — that is "Speakers" on all four, the indistinct state this
/// module exists to fix. Writes + notifies; no elevation needed. Returns the
/// number of endpoints restored.
#[cfg(windows)]
pub fn restore_endpoints() -> Result<u32, String> {
    let factory: Vec<String> = FACTORY_LABELS.iter().map(|s| s.to_string()).collect();
    let mut plan = build_plan(&factory)?;
    // Force a rewrite even where the diff reports a slot aligned — restore
    // must always stamp the factory labels.
    for e in &mut plan.endpoints {
        e.needs_change = true;
    }
    com_apply_targets(&plan)
}

// Non-Windows stubs keep the crate building on other hosts (the app ships
// Windows-only; these never run).
#[cfg(not(windows))]
pub fn build_plan(_bus_names: &[String]) -> Result<SyncPlan, String> {
    Err("AMVC endpoint sync is only available on Windows".into())
}
#[cfg(not(windows))]
pub fn apply_plan(_bus_names: &[String]) -> Result<SyncPlan, String> {
    Err("AMVC endpoint sync is only available on Windows".into())
}
#[cfg(not(windows))]
pub fn restore_endpoints() -> Result<u32, String> {
    Err("AMVC endpoint sync is only available on Windows".into())
}

/// Plan the rename without touching the registry (read-only; no elevation).
#[tauri::command]
pub async fn amvc_plan_endpoint_sync(bus_names: Vec<String>) -> Result<SyncPlan, String> {
    tauri::async_runtime::spawn_blocking(move || build_plan(&bus_names))
        .await
        .map_err(|e| format!("plan task failed: {e}"))?
}

/// Apply the rename via the MMDevice property store (no elevation needed).
#[tauri::command]
pub async fn amvc_apply_endpoint_sync(bus_names: Vec<String>) -> Result<SyncPlan, String> {
    tauri::async_runtime::spawn_blocking(move || apply_plan(&bus_names))
        .await
        .map_err(|e| format!("apply task failed: {e}"))?
}

/// Revert all renamed endpoints to the distinct factory labels.
#[tauri::command]
pub async fn amvc_restore_endpoint_names() -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(restore_endpoints)
        .await
        .map_err(|e| format!("restore task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_factory_names() {
        assert_eq!(classify("AudioManager Cable 1 Playback"), Some(BusSlot::A1));
        assert_eq!(classify("AudioManager Cable 2 Playback"), Some(BusSlot::A2));
        assert_eq!(classify("AudioManager Stream Output"), Some(BusSlot::B1));
        assert_eq!(classify("AudioManager Voice Output"), Some(BusSlot::B2));
    }

    #[test]
    fn classify_renamed_names_round_trip() {
        // After a brand-preserving rename, re-classification must land the
        // same slot so a re-sync is idempotent.
        assert_eq!(classify("AudioManager A1 Monitor"), Some(BusSlot::A1));
        assert_eq!(classify("AudioManager A2 Speakers"), Some(BusSlot::A2));
        assert_eq!(classify("AudioManager B1 Stream"), Some(BusSlot::B1));
        assert_eq!(classify("AudioManager B2 Record"), Some(BusSlot::B2));
    }

    #[test]
    fn classify_ignores_non_amvc() {
        assert_eq!(classify("Speakers (Realtek High Definition Audio)"), None);
        assert_eq!(classify("CABLE Input (VB-Audio Virtual Cable)"), None);
        // Recording (capture) endpoints live under Capture, not Render, and
        // also lack a render-bus token here.
        assert_eq!(classify("Some Random Device"), None);
    }

    #[test]
    fn target_name_adds_brand_once() {
        assert_eq!(target_name("B1 Stream"), "AudioManager B1 Stream");
        assert_eq!(target_name("  A1 Monitor "), "AudioManager A1 Monitor");
        // Already branded → unchanged (no double prefix).
        assert_eq!(target_name("AudioManager B1 Stream"), "AudioManager B1 Stream");
    }

    /// Manual probe against the live registry (read-only, no elevation).
    /// Run with: `cargo test amvc_sync -- --ignored --nocapture`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn print_live_plan() {
        let labels = [
            "A1 Monitor".to_string(),
            "A2 Speakers".to_string(),
            "B1 Stream".to_string(),
            "B2 Record".to_string(),
        ];
        match build_plan(&labels) {
            Ok(plan) => {
                eprintln!("aligned={} can_write={}", plan.aligned, plan.can_write);
                for e in &plan.endpoints {
                    eprintln!(
                        "  {:?}  {:?}  '{}' -> '{}'  change={}",
                        e.slot, e.guid, e.current, e.target, e.needs_change
                    );
                }
            }
            Err(e) => eprintln!("plan error: {e}"),
        }
    }

    /// Read-only COM dump: for every render AND capture endpoint (all states),
    /// print id + FriendlyName + DeviceDesc + DeviceInterface FriendlyName.
    /// No writes, no elevation needed.
    /// Run: `cargo test amvc_sync::tests::com_dump_names -- --ignored --nocapture`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn com_dump_names() {
        use windows::core::GUID;
        use windows::Win32::Media::Audio::eCapture;
        use windows::Win32::System::Com::STGM_READ;
        use windows::Win32::Foundation::PROPERTYKEY;

        const PKEY_DEVICE_DEVICEDESC: PROPERTYKEY = PROPERTYKEY {
            fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0),
            pid: 2,
        };
        const PKEY_DEVICEINTERFACE_FRIENDLYNAME: PROPERTYKEY = PROPERTYKEY {
            fmtid: GUID::from_u128(0x026e516e_b814_414b_83cd_856d6fef4822),
            pid: 2,
        };
        // The MMDevices slot that registry shows holding "AudioManager Virtual
        // Cable" — the parenthesized half of the composed name.
        const PKEY_MMDEV_INTERFACE_NAME: PROPERTYKEY = PROPERTYKEY {
            fmtid: GUID::from_u128(0xb3f8fa53_0004_438e_9003_51a46e139bfc),
            pid: 6,
        };

        unsafe fn read_str(store: &IPropertyStore, key: &PROPERTYKEY) -> String {
            let Ok(pv) = (unsafe { store.GetValue(key) }) else {
                return "<err>".into();
            };
            let pwsz = unsafe { pv.Anonymous.Anonymous.Anonymous.pwszVal };
            if pwsz.is_null() {
                return "<empty>".into();
            }
            unsafe { PCWSTR(pwsz.0).to_string().unwrap_or_else(|_| "<bad utf16>".into()) }
        }

        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                    .expect("create MMDeviceEnumerator");
            for (label, flow) in [("RENDER", eRender), ("CAPTURE", eCapture)] {
                eprintln!("=== {label} ===");
                let collection = enumerator
                    .EnumAudioEndpoints(flow, DEVICE_STATE(0x0000_000F))
                    .expect("enumerate");
                let count = collection.GetCount().expect("count");
                for i in 0..count {
                    let Ok(device) = collection.Item(i) else { continue };
                    let id = device
                        .GetId()
                        .ok()
                        .and_then(|p| p.to_string().ok())
                        .unwrap_or_default();
                    let Ok(store) = device.OpenPropertyStore(STGM_READ) else { continue };
                    let friendly = read_str(&store, &PKEY_Device_FriendlyName);
                    let desc = read_str(&store, &PKEY_DEVICE_DEVICEDESC);
                    let iface = read_str(&store, &PKEY_DEVICEINTERFACE_FRIENDLYNAME);
                    let mmdev_iface = read_str(&store, &PKEY_MMDEV_INTERFACE_NAME);
                    eprintln!("  id={id}");
                    eprintln!("    FriendlyName        = {friendly}");
                    eprintln!("    DeviceDesc          = {desc}");
                    eprintln!("    IfaceFriendly(026e) = {iface}");
                    eprintln!("    IfaceName(b3f8,6)   = {mmdev_iface}");
                }
            }
        }
    }

    /// Live COM apply (no elevation needed — DeviceDesc pid=2 is the writable
    /// display token). Note `amvc-helper detect` reads `,14`, which renames
    /// never touch, so it keeps reporting factory names; verify the visible
    /// result with `com_dump_names` instead.
    /// Run: `cargo test amvc_sync::tests::com_apply -- --ignored --nocapture`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn com_apply() {
        let labels = [
            "A1 Monitor".to_string(),
            "A2 Speakers".to_string(),
            "B1 Stream".to_string(),
            "B2 Record".to_string(),
        ];
        match apply_plan(&labels) {
            Ok(p) => eprintln!("apply ok, registry-aligned={}", p.aligned),
            Err(e) => eprintln!("apply error: {e}"),
        }
        eprintln!("--- live COM friendly names after apply ---");
        match com_read_friendly_names() {
            Ok(list) => {
                for (id, name) in list.iter().filter(|(_, n)| n.to_lowercase().contains("audiomanager") || n.to_lowercase().contains("a1 ") || n.to_lowercase().contains("b1 ")) {
                    eprintln!("  {name}  [{}]", id.split('.').last().unwrap_or(""));
                }
            }
            Err(e) => eprintln!("read error: {e}"),
        }
    }

    /// Live COM restore to the distinct factory labels (no elevation needed).
    /// Run: `cargo test amvc_sync::tests::com_restore -- --ignored --nocapture`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn com_restore() {
        match restore_endpoints() {
            Ok(n) => eprintln!("restored {n} endpoints"),
            Err(e) => eprintln!("restore error: {e}"),
        }
    }

    #[test]
    fn target_keeps_detection_substring() {
        // Detection matches lowercase "audiomanager " — every target must keep it.
        for label in ["A1 Monitor", "A2 Speakers", "B1 Stream", "B2 Record"] {
            assert!(target_name(label).to_ascii_lowercase().contains("audiomanager "));
        }
    }
}
