//! Persisted trusted-device store for phone pairing (pairing-v2 #1).
//!
//! A device the desktop user has Accepted is recorded here so it can
//! auto-reconnect across app restarts without a re-prompt. Phase 1 builds the
//! store; Phase 2 (`session::accept` / `try_resume_trusted`) consumes it.
//!
//! ## Security model
//! * The pairing token is a 122-bit uuid v4 (`net::session::create_session`),
//!   i.e. a high-entropy uniformly-random secret. We store ONLY its SHA-256
//!   digest (lowercase hex) — never the token. A single unsalted SHA-256 is the
//!   correct choice here: salts and slow KDFs (argon2/bcrypt) defend LOW-entropy
//!   human passwords against offline brute force / precomputation; against a
//!   2^122 random secret a fast hash is already infeasible to invert, so a KDF
//!   would add cost and a dependency for zero security gain.
//! * `verify` compares in constant time (`session::constant_time_eq`). The value
//!   compared is itself a hash of an unknown preimage, so the compare carries no
//!   security-load-bearing timing.
//! * An attacker who can WRITE this file is already local-user-equivalent — the
//!   same trust that reads the co-located TLS private key and the in-memory
//!   plaintext tokens. Injection-via-file-write is therefore in-threat-model and
//!   accepted, not defended. The file lives under `app_local_data_dir`
//!   (per-user `%LOCALAPPDATA%` ACLs on Windows), never a shared/temp dir.
//!
//! ## Durability
//! Revocation must survive a crash, or a kicked device resurrects on next boot.
//! Writes serialize to a temp file, `File::sync_all()` it, then `fs::rename`
//! atomically over the destination (replace-on-rename holds on both Windows and
//! Unix). This is deliberately stricter than `presets.rs`, which skips the fsync
//! and uses a non-atomic remove-then-rename.
//!
//! ## Locking
//! The store mutex is NEVER held across filesystem IO: every write path locks,
//! mutates the map, clones a snapshot, RELEASES the lock, then writes. Disk
//! latency therefore cannot stall a `verify` running on the async WS task.

// Most of this surface (upsert/forget/verify/list and the Phase-2 stubs) is
// consumed in Phase 2; allow it to exist ahead of its first caller.
#![allow(dead_code)]

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use sha2::{Digest, Sha256};

/// Persisted store file name under `app_local_data_dir`.
pub const STORE_FILE_NAME: &str = "paired-devices.json";

/// On-disk schema version (bumped only on a breaking format change).
const SCHEMA_VERSION: u32 = 1;

/// A trusted device is forgotten if it has not been seen for this long.
pub const TRUSTED_TTL_DAYS: u64 = 30;
const TRUSTED_TTL_SECS: u64 = TRUSTED_TTL_DAYS * 24 * 60 * 60;

/// Cadence of the background maintenance thread: flush pending `last_seen` bumps
/// and prune expired devices. Disk writes happen here (off the async runtime),
/// not on the WS path.
const MAINTENANCE_INTERVAL: Duration = Duration::from_secs(300);

/// One persisted trusted device. `token_hash` is the lowercase-hex SHA-256 of
/// the pairing token; the token itself never touches disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairedDevice {
    pub id: String,
    pub token_hash: String,
    pub label: String,
    #[serde(default)]
    pub client_kind: Option<String>,
    #[serde(default)]
    pub client_os: Option<String>,
    pub created_utc: u64,
    pub last_seen_utc: u64,
}

/// On-disk wrapper carrying a schema version for forward migrations.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PairedStoreFile {
    schema_version: u32,
    devices: Vec<PairedDevice>,
}

/// IPC-facing view for the "Paired devices" UI. Intentionally omits the digest.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDeviceStatus {
    pub id: String,
    pub label: String,
    pub client_kind: Option<String>,
    pub client_os: Option<String>,
    pub created_utc: u64,
    pub last_seen_utc: u64,
}

#[derive(Default)]
struct StoreState {
    devices: HashMap<String, PairedDevice>,
    path: Option<PathBuf>,
    /// True when we have an AUTHORITATIVE view of trust: the file was absent
    /// (clean empty) or parsed cleanly. False when the file is present but
    /// unreadable/corrupt — in which case we must not act on (empty) trust at
    /// boot, and must not overwrite the file.
    loaded_ok: bool,
    /// Set when an in-memory `last_seen` was bumped but not yet flushed.
    dirty: bool,
}

fn state() -> &'static Mutex<StoreState> {
    static S: OnceLock<Mutex<StoreState>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(StoreState::default()))
}

/// Lock-free revocation counter, bumped on every successful `forget`. Phase 2
/// captures it before a resume's `verify` and re-checks it under the registry
/// lock — reading an atomic, NOT the store mutex, so the registry and store
/// locks are never held simultaneously.
static REVOKE_EPOCH: AtomicU64 = AtomicU64::new(0);

// ── Hashing ─────────────────────────────────────────────────────────────────

/// Lowercase-hex SHA-256 of the pairing token. The `02x`-equivalent table emit
/// guarantees lowercase regardless of platform/formatter, so the byte-wise
/// `constant_time_eq` in `verify` can never trip on hex case.
fn sha256_hex(token: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(token.as_bytes());
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// Build a `PairedDevice` from a freshly-accepted session. Hashing lives here so
/// the plaintext token never travels outside this module.
pub fn device_from_pairing(
    id: &str,
    token: &str,
    label: &str,
    client_kind: Option<&str>,
    client_os: Option<&str>,
) -> PairedDevice {
    let now = now_utc();
    PairedDevice {
        id: id.to_string(),
        token_hash: sha256_hex(token),
        label: label.to_string(),
        client_kind: client_kind.map(str::to_string),
        client_os: client_os.map(str::to_string),
        created_utc: now,
        last_seen_utc: now,
    }
}

// ── Time / expiry ───────────────────────────────────────────────────────────

pub fn now_utc() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Age clamped at 0: if `last_seen` is in the future (clock rollback / RTC
/// glitch / attacker-set clock) the device is treated as just-seen, so a
/// backwards clock jump can never mass-prune live trust.
fn age_secs(now: u64, last_seen: u64) -> u64 {
    now.saturating_sub(last_seen)
}

fn is_expired(now: u64, last_seen: u64) -> bool {
    age_secs(now, last_seen) > TRUSTED_TTL_SECS
}

// ── On-disk IO ──────────────────────────────────────────────────────────────

/// Outcome of reading the store file. `Absent` (no file yet) is authoritative
/// empty; `Corrupt` (present but unreadable/garbage/unknown-schema) is NOT — we
/// neither trust it nor overwrite it.
enum Load {
    Absent,
    Parsed(Vec<PairedDevice>),
    Corrupt,
}

fn load_store_file(path: &Path) -> Load {
    match fs::read(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Load::Absent,
        Err(_) => Load::Corrupt,
        Ok(bytes) => match serde_json::from_slice::<PairedStoreFile>(&bytes) {
            Ok(store) if store.schema_version == SCHEMA_VERSION => Load::Parsed(store.devices),
            Ok(_) => Load::Corrupt,
            Err(_) => Load::Corrupt,
        },
    }
}

/// Durable atomic write: temp file -> fsync -> rename over destination.
fn write_store_file(path: &Path, store: &PairedStoreFile) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let bytes = serde_json::to_vec_pretty(store)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    let tmp = path.with_extension("json.tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
    }

    // `fs::rename` replaces an existing destination atomically on both Windows
    // (MoveFileEx REPLACE_EXISTING) and Unix — no remove-first, which would only
    // widen the crash window.
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }

    // Best-effort directory fsync so the rename itself is durable on Unix; a
    // no-op on Windows where directory handles cannot be fsync'd this way.
    #[cfg(unix)]
    if let Some(dir) = path.parent() {
        if let Ok(d) = fs::File::open(dir) {
            let _ = d.sync_all();
        }
    }

    Ok(())
}

fn snapshot_file(devices: &HashMap<String, PairedDevice>) -> PairedStoreFile {
    let mut list: Vec<PairedDevice> = devices.values().cloned().collect();
    list.sort_by(|a, b| a.id.cmp(&b.id));
    PairedStoreFile {
        schema_version: SCHEMA_VERSION,
        devices: list,
    }
}

fn status_of(d: &PairedDevice) -> PairedDeviceStatus {
    PairedDeviceStatus {
        id: d.id.clone(),
        label: d.label.clone(),
        client_kind: d.client_kind.clone(),
        client_os: d.client_os.clone(),
        created_utc: d.created_utc,
        last_seen_utc: d.last_seen_utc,
    }
}

// ── Public API ──────────────────────────────────────────────────────────────

/// Load the store from `path` at boot. Panic-free by contract: any IO/parse
/// failure leaves an empty in-memory store and returns normally, so the Tauri
/// `.setup()` hook can call it without risking app launch. A corrupt file is
/// left untouched on disk (a transient read glitch must not wipe trust).
pub fn init(path: PathBuf) {
    let now = now_utc();
    let load = load_store_file(&path);

    let mut state = state().lock().unwrap();
    state.path = Some(path.clone());
    state.dirty = false;

    match load {
        Load::Absent => {
            state.devices.clear();
            state.loaded_ok = true;
        }
        Load::Parsed(devices) => {
            let mut map: HashMap<String, PairedDevice> =
                devices.into_iter().map(|d| (d.id.clone(), d)).collect();
            let before = map.len();
            map.retain(|_, d| !is_expired(now, d.last_seen_utc));
            let pruned = before - map.len();
            state.devices = map;
            state.loaded_ok = true;

            // Persist the prune so the file does not keep expired trust. A
            // successful parse means the file is ours to rewrite. Best-effort:
            // never panic out of init(); a failed write just leaves stale
            // entries that re-prune on the next boot.
            if pruned > 0 {
                let snapshot = snapshot_file(&state.devices);
                drop(state);
                if let Err(e) = write_store_file(&path, &snapshot) {
                    eprintln!("[phone] paired-store prune write failed: {e}");
                }
            }
        }
        Load::Corrupt => {
            state.devices.clear();
            state.loaded_ok = false;
            eprintln!(
                "[phone] paired-store at '{}' is unreadable; ignoring it (trust not loaded, file left intact)",
                path.display()
            );
        }
    }
}

/// Insert or replace a trusted device, then persist. Call from a command thread
/// (e.g. `phone_accept_client`), never the async WS task.
pub fn upsert(device: PairedDevice) {
    let (snapshot, path, loaded_ok) = {
        let mut state = state().lock().unwrap();
        state.devices.insert(device.id.clone(), device);
        (snapshot_file(&state.devices), state.path.clone(), state.loaded_ok)
    };
    // Never overwrite a store we could not authoritatively load (corrupt on
    // boot): the in-memory map is empty + this one device, so writing it would
    // erase the original trusted devices. Keep the device in RAM for this
    // session and leave the file intact for recovery.
    if !loaded_ok {
        eprintln!("[phone] paired-store not authoritative; not persisting upsert (file left intact)");
        return;
    }
    if let Some(path) = path {
        if let Err(e) = write_store_file(&path, &snapshot) {
            eprintln!("[phone] paired-store upsert write failed: {e}");
        }
    }
}

/// Revoke a device's persisted trust. The in-memory removal + epoch bump take
/// effect immediately (so it cannot resume this session); the result reports
/// durability. `Ok(true)` = removed and persisted, `Ok(false)` = was not
/// present, `Err` = removed in RAM but the durable write FAILED — the caller
/// must surface this, since the device could resurrect from the stale file on
/// the next launch. Persists durably (fsync) — revocation must outlive a crash.
pub fn forget(id: &str) -> Result<bool, String> {
    let (removed, snapshot, path, loaded_ok) = {
        let mut state = state().lock().unwrap();
        let removed = state.devices.remove(id).is_some();
        if removed {
            // Bump AFTER the in-memory removal so a resume whose `verify` saw the
            // device observes the higher epoch and aborts.
            REVOKE_EPOCH.fetch_add(1, Ordering::Relaxed);
        }
        (removed, snapshot_file(&state.devices), state.path.clone(), state.loaded_ok)
    };
    if removed && loaded_ok {
        if let Some(path) = path {
            write_store_file(&path, &snapshot).map_err(|e| {
                format!("paired-store write failed — revocation is not durable: {e}")
            })?;
        }
    }
    Ok(removed)
}

/// Constant-time check that `token` matches the stored digest for `id`. Pure
/// in-memory; no disk IO, safe to call from the async WS task.
pub fn verify(id: &str, token: &str) -> bool {
    let hash = sha256_hex(token);
    let state = state().lock().unwrap();
    match state.devices.get(id) {
        Some(d) => super::session::constant_time_eq(hash.as_bytes(), d.token_hash.as_bytes()),
        None => false,
    }
}

/// The persisted friendly label for `id`, if trusted. Fallback for a resuming
/// hello that omits `name`. In-memory; no disk IO.
pub fn label_of(id: &str) -> Option<String> {
    state().lock().unwrap().devices.get(id).map(|d| d.label.clone())
}

/// Snapshot for the UI. No token/digest leaves this module.
pub fn list() -> Vec<PairedDeviceStatus> {
    let state = state().lock().unwrap();
    let mut out: Vec<PairedDeviceStatus> = state.devices.values().map(status_of).collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// Boot gate for opt-in autostart: true only when we authoritatively loaded a
/// non-empty store. A corrupt store (loaded_ok=false) or an empty/absent one
/// returns false, so a tampered/garbage file never triggers a boot-time server.
pub fn has_trusted_devices() -> bool {
    let state = state().lock().unwrap();
    state.loaded_ok && !state.devices.is_empty()
}

// ── Phase 2 stubs (consumed by session::try_resume_trusted) ──────────────────

/// Monotonic revocation counter. Phase 2 captures this before `verify` and
/// rechecks it under the registry lock to reject a resume that raced a `forget`.
pub fn revoke_epoch() -> u64 {
    REVOKE_EPOCH.load(Ordering::Relaxed)
}

/// Record a live resume's recency AND its (possibly renamed) friendly label, in
/// memory only — no disk IO on the async path; marks the store dirty for a later
/// flush (maintenance loop or exit). No-op for unknown ids. A non-empty `label`
/// that differs is written, so a rename after pairing reaches the paired-devices
/// list and offline resumes — not just the live session row. Pass "" to bump
/// recency without touching the label.
pub fn record_resume(id: &str, label: &str) {
    let now = now_utc();
    let label = label.trim();
    let mut state = state().lock().unwrap();
    let mut changed = false;
    if let Some(d) = state.devices.get_mut(id) {
        d.last_seen_utc = now;
        if !label.is_empty() && label != d.label {
            d.label = label.chars().take(64).collect();
        }
        changed = true;
    }
    if changed {
        state.dirty = true;
    }
}

/// Persist any in-memory `last_seen` bumps. Call from a command thread /
/// `spawn_blocking`, never the async WS task. Best-effort.
pub fn flush_if_dirty() {
    let (snapshot, path, loaded_ok) = {
        let mut state = state().lock().unwrap();
        if !state.dirty {
            return;
        }
        state.dirty = false;
        (snapshot_file(&state.devices), state.path.clone(), state.loaded_ok)
    };
    // Don't overwrite a store we couldn't authoritatively load (see upsert).
    if !loaded_ok {
        return;
    }
    if let Some(path) = path {
        if let Err(e) = write_store_file(&path, &snapshot) {
            eprintln!("[phone] paired-store flush write failed: {e}");
        }
    }
}

/// Start the once-only background maintenance thread. It periodically (a)
/// persists in-memory `last_seen` bumps the async resume path left unflushed
/// (so a daily-used phone is not pruned at 30d despite never triggering a
/// command-thread write), and (b) prunes devices past `TRUSTED_TTL` (so a
/// desktop that never restarts still bounds the store). Idempotent — a second
/// call is a no-op. Disk IO runs on this thread, never on the async WS path.
pub fn spawn_maintenance() {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = std::thread::Builder::new()
        .name("paired-maint".into())
        .spawn(|| loop {
            std::thread::sleep(MAINTENANCE_INTERVAL);
            maintain();
        });
}

/// Prune expired devices in memory and persist if anything changed (prune or a
/// pending `last_seen` bump). Pruning is expiry, not a user revoke, so it does
/// NOT bump the revoke epoch.
fn maintain() {
    let now = now_utc();
    {
        let mut state = state().lock().unwrap();
        let before = state.devices.len();
        state.devices.retain(|_, d| !is_expired(now, d.last_seen_utc));
        if state.devices.len() != before {
            state.dirty = true;
        }
    }
    flush_if_dirty();
}

/// Process-wide test lock shared with `session.rs` tests. `accept` now writes
/// into this store, so any test touching the registry AND this store must
/// serialize on a single lock to avoid cross-test interference. Both modules
/// acquire it in the same order (session lock first, then this), so there is no
/// deadlock.
#[cfg(test)]
pub(crate) fn global_test_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Reset the in-memory store to empty with no backing path (so `upsert`/`forget`
/// skip disk IO). Caller must already hold `global_test_lock`.
#[cfg(test)]
pub(crate) fn reset_for_test() {
    let mut s = state().lock().unwrap();
    s.devices.clear();
    s.path = None;
    s.loaded_ok = false;
    s.dirty = false;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// The store is process-global; cargo runs tests in parallel. Each global
    /// test holds the shared lock and resets the shared state first.
    fn setup() -> std::sync::MutexGuard<'static, ()> {
        let guard = global_test_lock();
        reset_for_test();
        guard
    }

    fn unique_path() -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let mut p = std::env::temp_dir();
        p.push(format!("am-paired-test-{}-{}", std::process::id(), n));
        fs::create_dir_all(&p).unwrap();
        p.join(STORE_FILE_NAME)
    }

    fn write_raw(path: &Path, bytes: &[u8]) {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).unwrap();
        }
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn sha256_hex_is_lowercase_hex_64() {
        let h = sha256_hex("00112233445566778899aabbccddeeff");
        assert_eq!(h.len(), 64);
        assert!(h.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
        // Deterministic + matches a known SHA-256 vector for the empty string.
        assert_eq!(
            sha256_hex(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn verify_round_trips_and_rejects_wrong_token_or_id() {
        let _g = setup();
        init(unique_path());
        let dev = device_from_pairing("sid1", "tok-secret", "My Phone", Some("browser"), Some("iOS"));
        upsert(dev);

        assert!(verify("sid1", "tok-secret"));
        assert!(!verify("sid1", "wrong"));
        assert!(!verify("unknown", "tok-secret"));
        // Status view never leaks the digest.
        let json = serde_json::to_string(&list()).unwrap();
        assert!(!json.contains(&sha256_hex("tok-secret")));
        assert!(json.contains("My Phone"));
    }

    #[test]
    fn corrupt_zero_byte_and_garbage_files_yield_empty_and_are_left_intact() {
        for raw in [b"".as_slice(), b"{ not json".as_slice(), b"\x00\x01\x02".as_slice()] {
            let _g = setup();
            let path = unique_path();
            write_raw(&path, raw);
            init(path.clone());

            assert!(list().is_empty(), "corrupt store must load empty");
            assert!(!has_trusted_devices(), "corrupt store is not authoritative");
            // File untouched: a transient glitch must not wipe trust.
            assert_eq!(fs::read(&path).unwrap(), raw, "corrupt file must be left intact");
        }
    }

    #[test]
    fn unknown_schema_is_treated_as_corrupt() {
        let _g = setup();
        let path = unique_path();
        write_raw(&path, br#"{"schema_version":999,"devices":[]}"#);
        init(path.clone());
        assert!(!has_trusted_devices());
        assert_eq!(fs::read(&path).unwrap(), br#"{"schema_version":999,"devices":[]}"#);
    }

    #[test]
    fn upsert_does_not_overwrite_unloaded_store() {
        let _g = setup();
        let path = unique_path();
        write_raw(&path, b"{ corrupt"); // present but unreadable
        init(path.clone());
        assert!(!has_trusted_devices(), "corrupt store is non-authoritative");
        // Accepting a phone this session must NOT rewrite the file from the empty
        // in-memory map — that would erase the original trusted devices.
        upsert(device_from_pairing("new", "tok", "New", None, None));
        assert_eq!(
            fs::read(&path).unwrap(),
            b"{ corrupt",
            "must not overwrite an unloaded (corrupt) store"
        );
        // The new device still works in RAM for this session.
        assert!(verify("new", "tok"));
    }

    #[test]
    fn absent_file_is_authoritative_empty() {
        let _g = setup();
        init(unique_path()); // file does not exist yet
        assert!(list().is_empty());
        assert!(!has_trusted_devices()); // empty -> no autostart, but authoritative
    }

    #[test]
    fn clock_rollback_does_not_mass_prune() {
        let now = 1_000_000_000u64;
        assert!(!is_expired(now, now)); // just seen
        assert!(!is_expired(now, now + 10_000)); // future last_seen -> clamped, kept
        assert!(!is_expired(now, now - (TRUSTED_TTL_SECS - 1)));
        assert!(is_expired(now, now - (TRUSTED_TTL_SECS + 1))); // genuinely old
    }

    #[test]
    fn init_prunes_expired_keeps_fresh() {
        let _g = setup();
        let path = unique_path();
        let now = now_utc();
        let fresh = PairedDevice {
            id: "fresh".into(),
            token_hash: sha256_hex("a"),
            label: "Fresh".into(),
            client_kind: None,
            client_os: None,
            created_utc: now,
            last_seen_utc: now,
        };
        let stale = PairedDevice {
            id: "stale".into(),
            token_hash: sha256_hex("b"),
            label: "Stale".into(),
            client_kind: None,
            client_os: None,
            created_utc: now - TRUSTED_TTL_SECS * 2,
            last_seen_utc: now - TRUSTED_TTL_SECS * 2,
        };
        let file = PairedStoreFile {
            schema_version: SCHEMA_VERSION,
            devices: vec![fresh, stale],
        };
        write_raw(&path, &serde_json::to_vec_pretty(&file).unwrap());

        init(path.clone());
        let ids: Vec<String> = list().into_iter().map(|s| s.id).collect();
        assert_eq!(ids, vec!["fresh".to_string()]);
        // The prune was persisted, so the stale entry is gone from disk too.
        let on_disk: PairedStoreFile =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(on_disk.devices.len(), 1);
        assert_eq!(on_disk.devices[0].id, "fresh");
    }

    #[test]
    fn forget_revokes_persists_and_bumps_epoch() {
        let _g = setup();
        let path = unique_path();
        init(path.clone());
        upsert(device_from_pairing("sid", "tok", "P", None, None));
        let epoch0 = revoke_epoch();

        assert!(forget("sid").unwrap());
        assert!(!verify("sid", "tok"));
        assert_eq!(revoke_epoch(), epoch0 + 1);
        assert!(!forget("sid").unwrap()); // already gone
        assert_eq!(revoke_epoch(), epoch0 + 1); // no bump when nothing removed

        // Revocation is durable on disk.
        let on_disk: PairedStoreFile =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(on_disk.devices.is_empty());
    }

    #[test]
    fn touch_then_flush_persists_last_seen() {
        let _g = setup();
        let path = unique_path();
        init(path.clone());
        // Persisted with a stale last_seen (0).
        upsert(PairedDevice {
            id: "t".into(),
            token_hash: sha256_hex("x"),
            label: "T".into(),
            client_kind: None,
            client_os: None,
            created_utc: 0,
            last_seen_utc: 0,
        });
        record_resume("t", ""); // bumps to now_utc(), marks dirty (no disk IO)
        flush_if_dirty(); // persists the bump

        // Reload from disk: the bumped last_seen survived (and isn't pruned).
        {
            let mut s = state().lock().unwrap();
            s.devices.clear();
            s.path = None;
            s.loaded_ok = false;
        }
        init(path.clone());
        let dev = list().into_iter().find(|d| d.id == "t").unwrap();
        assert!(dev.last_seen_utc > 0, "flushed last_seen should persist");
    }

    #[test]
    fn atomic_write_replaces_existing_and_round_trips() {
        let _g = setup();
        let path = unique_path();
        init(path.clone());

        upsert(device_from_pairing("sid", "tok1", "First", None, None));
        upsert(device_from_pairing("sid", "tok2", "Second", None, None)); // replace over existing

        // Drop the in-memory mirror and reload from disk: the second write won.
        // Reset state directly rather than calling setup() again — setup() locks
        // a non-reentrant mutex and would deadlock if called twice in one test.
        {
            let mut s = state().lock().unwrap();
            s.devices.clear();
            s.path = None;
            s.loaded_ok = false;
        }
        init(path.clone());
        assert!(verify("sid", "tok2"));
        assert!(!verify("sid", "tok1"));
        let devs = list();
        assert_eq!(devs.len(), 1);
        assert_eq!(devs[0].label, "Second");

        // No stray temp file left behind.
        let tmp = path.with_extension("json.tmp");
        assert!(!tmp.exists(), "temp file must not survive a successful write");
    }
}
