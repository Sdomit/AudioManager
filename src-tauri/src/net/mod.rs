//! Phone Wireless Audio network layer (#39-#45).
//!
//! Owns a dedicated tokio runtime (decision D4) so nothing here depends on
//! Tauri's runtime — the whole module is testable headless. The IPC layer in
//! `lib.rs` calls the sync functions below; async work lives on `runtime()`.

pub mod server;
pub mod session;
pub mod signaling;
pub mod tls;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;

/// Ports tried in order; first free one wins.
pub const PORT_RANGE: std::ops::Range<u16> = 47800..47810;

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
}

pub fn server_status() -> PhoneServerStatus {
    let slot = server_slot().lock().unwrap();
    PhoneServerStatus {
        running: slot.is_some(),
        port: slot.as_ref().map(|s| s.port),
        lan_ips: lan_ips().iter().map(|ip| ip.to_string()).collect(),
    }
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

    let rustls_config = runtime()
        .block_on(axum_server::tls_rustls::RustlsConfig::from_pem(
            material.cert_pem.into_bytes(),
            material.key_pem.into_bytes(),
        ))
        .map_err(|e| format!("TLS config: {e}"))?;

    let app = server::router();
    let mut last_err = String::from("no port available");
    for port in PORT_RANGE {
        let addr = SocketAddr::from((Ipv4Addr::UNSPECIFIED, port));
        let handle = axum_server::Handle::new();
        let server_handle = handle.clone();
        let config = rustls_config.clone();
        let make_service = app.clone().into_make_service();

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
            Ok(Some(_bound)) => {
                let mut slot = server_slot().lock().unwrap();
                *slot = Some(RunningServer { port, handle });
                return Ok(port);
            }
            Ok(None) => {
                // The serve task already returned (that is why listening()
                // resolved None); shutdown() is belt-and-suspenders so no bound
                // task can survive to the next iteration.
                handle.shutdown();
                last_err = format!("port {port} unavailable");
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
