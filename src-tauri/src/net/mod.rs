//! Phone Wireless Audio network layer (#39-#45).
//!
//! Owns a dedicated tokio runtime (decision D4) so nothing here depends on
//! Tauri's runtime — the whole module is testable headless. The IPC layer in
//! `lib.rs` calls the sync functions below; async work lives on `runtime()`.

pub mod jitter;
pub mod paired;
pub mod server;
pub mod session;
pub mod signaling;
pub mod tls;
pub mod webrtc_peer;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Ports tried in order; first free one wins.
pub const PORT_RANGE: std::ops::Range<u16> = 47800..47810;

/// Hook fired when a trusted device auto-resumes (Phase 2). `lib.rs` installs it
/// in `.setup()` to re-add the phone's mixer-graph input, which the desktop lost
/// on restart — the net layer has no access to the audio graph itself. Receives
/// the session id (`<sid>`; the caller forms the `phone:<sid>` source id).
type ResumeHook = Box<dyn Fn(&str) + Send + Sync + 'static>;

fn resume_hook() -> &'static OnceLock<ResumeHook> {
    static H: OnceLock<ResumeHook> = OnceLock::new();
    &H
}

/// Install the auto-resume hook (idempotent; a second call is ignored).
pub fn set_resume_hook(f: ResumeHook) {
    let _ = resume_hook().set(f);
}

/// Fire the auto-resume hook if one is installed. Called off the registry/store
/// locks; the hook itself only touches the audio graph (no disk IO).
pub(crate) fn fire_resume_hook(session_id: &str) {
    if let Some(f) = resume_hook().get() {
        f(session_id);
    }
}

pub fn runtime() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("phone-net")
            .enable_all()
            .build()
            .expect("phone-net runtime builds")
    })
}

struct RunningServer {
    port: u16,
    handle: axum_server::Handle<SocketAddr>,
}

fn server_slot() -> &'static Mutex<Option<RunningServer>> {
    static SLOT: OnceLock<Mutex<Option<RunningServer>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneServerStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub lan_ips: Vec<String>,
    /// True if the server answers a TCP connect on a LAN IP. When the server is
    /// running but this is false, a firewall is almost certainly blocking the
    /// port and phones will see "site can't be reached" (#44).
    pub reachable: bool,
}

pub fn server_status() -> PhoneServerStatus {
    let (running, port) = {
        let slot = server_slot().lock().unwrap();
        (slot.is_some(), slot.as_ref().map(|s| s.port))
    };
    PhoneServerStatus {
        running,
        port,
        lan_ips: lan_ips().iter().map(|ip| ip.to_string()).collect(),
        reachable: port.map(self_reachable).unwrap_or(false),
    }
}

/// Per-IP connect timeout for the reachability probe.
const PROBE_TIMEOUT: Duration = Duration::from_millis(400);

/// Probe whether the server actually accepts a connection on a LAN IP — a
/// direct firewall check, since connecting to our own non-loopback address
/// traverses the inbound firewall just like a phone would.
///
/// The blocking connects run concurrently on the net runtime and the whole
/// thing is wall-clock-capped, so a host with several adapters (Hyper-V / WSL /
/// VPN virtual IPs, each of which a DROP firewall rule makes hang for the full
/// timeout) costs ~one timeout total, not N of them — the caller is a sync IPC
/// command and must not stall for seconds.
fn self_reachable(port: u16) -> bool {
    let ips = lan_ips();
    if ips.is_empty() {
        return false;
    }
    runtime().block_on(async move {
        let mut set = tokio::task::JoinSet::new();
        for ip in ips {
            set.spawn_blocking(move || {
                std::net::TcpStream::connect_timeout(&SocketAddr::new(ip, port), PROBE_TIMEOUT)
                    .is_ok()
            });
        }
        let any_ok = async {
            while let Some(res) = set.join_next().await {
                if matches!(res, Ok(true)) {
                    return true;
                }
            }
            false
        };
        tokio::time::timeout(PROBE_TIMEOUT + Duration::from_millis(150), any_ok)
            .await
            .unwrap_or(false)
    })
}

/// LAN IPv4 addresses, primary interface first. Loopback and link-local
/// excluded; these go into the QR URL and the cert SANs.
pub fn lan_ips() -> Vec<IpAddr> {
    let primary = local_ip_address::local_ip().ok();
    let mut ips: Vec<IpAddr> = local_ip_address::list_afinet_netifas()
        .map(|ifs| {
            ifs.into_iter()
                .map(|(_, ip)| ip)
                .filter(|ip| match ip {
                    IpAddr::V4(v4) => {
                        !v4.is_loopback() && !v4.is_link_local() && !v4.is_unspecified()
                    }
                    IpAddr::V6(_) => false,
                })
                .collect()
        })
        .unwrap_or_default();
    ips.sort();
    ips.dedup();
    if let Some(p) = primary {
        if let Some(pos) = ips.iter().position(|ip| *ip == p) {
            ips.remove(pos);
            ips.insert(0, p);
        }
    }
    ips
}

/// Install the `ring` rustls crypto provider as the process default, once.
/// Idempotent: a second call (or a provider already installed elsewhere) is a
/// no-op rather than an error.
fn ensure_crypto_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// Start the HTTPS server if it is not already running. Sync; safe to call
/// from the IPC thread. Returns the bound port.
pub fn ensure_server(app_local_data: &Path) -> Result<u16, String> {
    {
        let slot = server_slot().lock().unwrap();
        if let Some(s) = slot.as_ref() {
            return Ok(s.port);
        }
    }

    let ips = lan_ips();
    if ips.is_empty() {
        return Err("no LAN network interface found — connect to WiFi/Ethernet first".into());
    }
    let material = tls::load_or_generate(&tls::tls_dir(app_local_data), &ips)?;

    // The dependency graph now compiles in BOTH rustls crypto backends — `ring`
    // (via axum-server) and `aws-lc-rs` (via webrtc). With two providers present
    // rustls refuses to auto-select one and panics on first TLS use, so pin
    // `ring` as the process default exactly once before any TLS work starts.
    ensure_crypto_provider();

    let rustls_config = runtime()
        .block_on(axum_server::tls_rustls::RustlsConfig::from_pem(
            material.cert_pem.into_bytes(),
            material.key_pem.into_bytes(),
        ))
        .map_err(|e| format!("TLS config: {e}"))?;

    let app = server::router();
    let mut last_err = String::from("no port available");
    // Prefer the fixed range first (matches the QR/firewall expectation), then
    // fall back to an OS-assigned ephemeral port (0) so pairing still starts when
    // the whole range is occupied. The bound port rides in the QR either way; the
    // app's own inbound firewall rule covers any port it listens on.
    for port in PORT_RANGE.chain(std::iter::once(0u16)) {
        let addr = SocketAddr::from((Ipv4Addr::UNSPECIFIED, port));
        let handle = axum_server::Handle::new();
        let server_handle = handle.clone();
        let config = rustls_config.clone();
        // with_connect_info so the ws handler sees the peer IP (rate limiting).
        let make_service = app
            .clone()
            .into_make_service_with_connect_info::<SocketAddr>();

        runtime().spawn(async move {
            if let Err(e) = axum_server::bind_rustls(addr, config)
                .handle(server_handle)
                .serve(make_service)
                .await
            {
                eprintln!("[phone] server on {addr} exited: {e}");
            }
        });

        // listening() resolves Some(addr) once bound, None if the server task
        // failed (port taken). Bound here = ready for connections.
        match runtime().block_on(async {
            tokio::time::timeout(Duration::from_secs(3), handle.listening()).await
        }) {
            Ok(Some(bound)) => {
                // Use the actually-bound port, not the requested one — for the
                // ephemeral fallback (requested 0) the OS picks the real port.
                let actual = bound.port();
                let mut slot = server_slot().lock().unwrap();
                *slot = Some(RunningServer { port: actual, handle });
                return Ok(actual);
            }
            Ok(None) => {
                // The serve task already returned (that is why listening()
                // resolved None); shutdown() is belt-and-suspenders so no bound
                // task can survive to the next iteration.
                handle.shutdown();
                last_err = if port == 0 {
                    "no free port available".to_string()
                } else {
                    format!("port {port} unavailable")
                };
                continue;
            }
            Err(_) => {
                handle.shutdown();
                last_err = format!("bind timeout on port {port}");
                continue;
            }
        }
    }
    Err(last_err)
}

/// Stop the server (used on app teardown; sessions stay in the registry).
#[allow(dead_code)]
pub fn shutdown_server() {
    let mut slot = server_slot().lock().unwrap();
    if let Some(s) = slot.take() {
        s.handle.graceful_shutdown(Some(Duration::from_secs(1)));
    }
}

/// Build the pairing URL embedded in the QR code. Credentials ride in the
/// fragment so they never appear in HTTP request lines or server logs.
pub fn pairing_url(ip: &IpAddr, port: u16, session_id: &str, token: &str) -> String {
    format!("https://{ip}:{port}/#s={session_id}&t={token}")
}

/// User-facing phone-pairing settings, persisted next to presets/recorder
/// settings under `app_local_data_dir`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhoneSettings {
    /// Opt-in (default false): bring the LAN phone server up at app launch so a
    /// trusted phone can reconnect without the user opening the pairing sheet.
    /// Default-false keeps the current MVP boot behavior (the server starts only
    /// on demand from `phone_create_session`).
    #[serde(default)]
    pub autostart: bool,
}

impl Default for PhoneSettings {
    fn default() -> Self {
        Self { autostart: false }
    }
}

impl PhoneSettings {
    fn settings_file(app_local_data: &Path) -> PathBuf {
        app_local_data.join("phone_settings.json")
    }

    /// Load settings, falling back to defaults on a missing/corrupt file (never
    /// fails — the boot path must not be blocked by a bad settings file).
    pub fn load_or_default(app_local_data: &Path) -> Self {
        let path = Self::settings_file(app_local_data);
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<PhoneSettings>(&raw).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, app_local_data: &Path) -> Result<(), String> {
        let path = Self::settings_file(app_local_data);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("create settings dir '{}': {e}", dir.display()))?;
        }
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| format!("serialize phone settings: {e}"))?;
        std::fs::write(&path, json).map_err(|e| format!("write '{}': {e}", path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_url_puts_credentials_in_fragment() {
        let ip: IpAddr = "192.168.1.20".parse().unwrap();
        let url = pairing_url(&ip, 47800, "sid123", "tok456");
        assert_eq!(url, "https://192.168.1.20:47800/#s=sid123&t=tok456");
        let (base, fragment) = url.split_once('#').unwrap();
        assert!(!base.contains("tok456"));
        assert!(fragment.contains("tok456"));
    }
}
