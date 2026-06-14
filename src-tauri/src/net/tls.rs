//! Self-signed TLS material for the phone server (decision D1).
//!
//! `getUserMedia` requires a secure context, so the phone client must be
//! served over HTTPS. We generate a self-signed certificate once, persist the
//! PEM pair under `<app-data>/phone/`, and reuse it so each phone only sees
//! the browser interstitial once per cert. The cert is regenerated when the
//! machine's LAN IPs no longer match the SANs it was issued for (tracked in a
//! sidecar meta file — parsing X.509 back out of the PEM would need another
//! dependency for no gain).

use std::net::IpAddr;
use std::path::{Path, PathBuf};

use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair, SanType};

pub struct TlsMaterial {
    pub cert_pem: String,
    pub key_pem: String,
}

const CERT_FILE: &str = "cert.pem";
const KEY_FILE: &str = "key.pem";
const META_FILE: &str = "cert-sans.json";

/// Load the persisted cert if it covers `ips`, else generate and persist a
/// fresh one.
pub fn load_or_generate(dir: &Path, ips: &[IpAddr]) -> Result<TlsMaterial, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("create {dir:?}: {e}"))?;
    let cert_path = dir.join(CERT_FILE);
    let key_path = dir.join(KEY_FILE);
    let meta_path = dir.join(META_FILE);

    if let Some(material) = try_load(&cert_path, &key_path, &meta_path, ips) {
        return Ok(material);
    }
    generate(&cert_path, &key_path, &meta_path, ips)
}

fn try_load(
    cert_path: &Path,
    key_path: &Path,
    meta_path: &Path,
    ips: &[IpAddr],
) -> Option<TlsMaterial> {
    let cert_pem = std::fs::read_to_string(cert_path).ok()?;
    let key_pem = std::fs::read_to_string(key_path).ok()?;
    let sans: Vec<String> = serde_json::from_str(&std::fs::read_to_string(meta_path).ok()?).ok()?;
    let covered = ips.iter().all(|ip| sans.contains(&ip.to_string()));
    if !covered {
        return None;
    }
    Some(TlsMaterial { cert_pem, key_pem })
}

fn generate(
    cert_path: &Path,
    key_path: &Path,
    meta_path: &Path,
    ips: &[IpAddr],
) -> Result<TlsMaterial, String> {
    let mut params = CertificateParams::default();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, "AudioManager Phone Link");
    params.distinguished_name = dn;
    params.subject_alt_names = ips
        .iter()
        .map(|ip| SanType::IpAddress(*ip))
        .chain(std::iter::once(SanType::DnsName(
            "audiomanager.local"
                .try_into()
                .map_err(|e| format!("dns san: {e}"))?,
        )))
        .collect();

    let key_pair = KeyPair::generate().map_err(|e| format!("keygen: {e}"))?;
    let cert = params
        .self_signed(&key_pair)
        .map_err(|e| format!("self-sign: {e}"))?;

    let cert_pem = cert.pem();
    let key_pem = key_pair.serialize_pem();
    let sans: Vec<String> = ips.iter().map(|ip| ip.to_string()).collect();

    std::fs::write(cert_path, &cert_pem).map_err(|e| format!("write cert: {e}"))?;
    std::fs::write(key_path, &key_pem).map_err(|e| format!("write key: {e}"))?;
    std::fs::write(
        meta_path,
        serde_json::to_string(&sans).expect("string list serializes"),
    )
    .map_err(|e| format!("write meta: {e}"))?;

    Ok(TlsMaterial { cert_pem, key_pem })
}

/// Where TLS material lives under the app-local data dir.
pub fn tls_dir(app_local_data: &Path) -> PathBuf {
    app_local_data.join("phone")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_then_reuses_then_rotates() {
        let dir = std::env::temp_dir().join(format!("am-tls-test-{}", uuid::Uuid::new_v4()));
        let ip1: IpAddr = "192.168.1.10".parse().unwrap();
        let ip2: IpAddr = "10.0.0.7".parse().unwrap();

        let a = load_or_generate(&dir, &[ip1]).unwrap();
        assert!(a.cert_pem.contains("BEGIN CERTIFICATE"));
        assert!(a.key_pem.contains("PRIVATE KEY"));

        // Same IPs: reused byte-for-byte.
        let b = load_or_generate(&dir, &[ip1]).unwrap();
        assert_eq!(a.cert_pem, b.cert_pem);

        // New IP not in SANs: regenerated.
        let c = load_or_generate(&dir, &[ip1, ip2]).unwrap();
        assert_ne!(a.cert_pem, c.cert_pem);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
