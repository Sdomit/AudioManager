//! Phone pairing session registry.
//!
//! Lifecycle (docs/phone/architecture.md "Source lifecycle"):
//!
//! ```text
//! Created ──hello ok──▶ PendingAccept ──accept──▶ Accepted
//!    │                      │ reject / ws drop        │ ws drop
//!    │ 10 min unused        ▼                         ▼
//!    ▼                  (Created again on drop)   Reconnecting ──2 min──▶ Disconnected
//! Expired
//! ```
//!
//! The registry is a process-global `Mutex<HashMap>` (same pattern as
//! `audio::loopback`'s capture manager) so the net layer stays independent of
//! Tauri state. Tokens are uuid-v4 (122 bits); they are never logged.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::mpsc::UnboundedSender;

use super::signaling::ServerMessage;

/// Pairing window for a session nobody has connected to yet.
pub const UNPAIRED_TTL: Duration = Duration::from_secs(10 * 60);
/// Grace period a previously-accepted session survives a connection drop.
pub const RECONNECT_GRACE: Duration = Duration::from_secs(2 * 60);
/// Token attempts before the session is invalidated.
pub const MAX_TOKEN_ATTEMPTS: u32 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionState {
    Created,
    PendingAccept,
    Accepted,
    Reconnecting,
    Disconnected,
    Expired,
}

pub struct PhoneSession {
    pub id: String,
    token: String,
    pub label: String,
    pub state: SessionState,
    pub client_kind: Option<String>,
    pub client_os: Option<String>,
    created_at: Instant,
    /// Set when the state last left `Accepted` (drives the reconnect grace).
    dropped_at: Option<Instant>,
    token_failures: u32,
    /// Outbound channel of the currently attached WebSocket, if any.
    /// Lets IPC commands (accept/reject/remove) push messages to the phone.
    pub tx: Option<UnboundedSender<ServerMessage>>,
    /// Monotonic id of the attached connection; a stale ws task must not
    /// clear state written by its replacement.
    pub conn_epoch: u64,
}

/// Snapshot for IPC / the pairing sheet. Token intentionally absent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneSessionStatus {
    pub id: String,
    pub label: String,
    pub state: SessionState,
    pub client_kind: Option<String>,
    pub client_os: Option<String>,
    pub expires_in_secs: Option<u64>,
}

fn registry() -> &'static Mutex<HashMap<String, PhoneSession>> {
    static REG: OnceLock<Mutex<HashMap<String, PhoneSession>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn simple_uuid() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Create a session; returns (session_id, token). The token leaves the
/// process only inside the QR URL fragment.
pub fn create_session(label: Option<String>) -> (String, String) {
    sweep();
    let id = simple_uuid();
    let token = simple_uuid();
    let session = PhoneSession {
        id: id.clone(),
        token: token.clone(),
        label: label.unwrap_or_else(|| "Phone".to_string()),
        state: SessionState::Created,
        client_kind: None,
        client_os: None,
        created_at: Instant::now(),
        dropped_at: None,
        token_failures: 0,
        tx: None,
        conn_epoch: 0,
    };
    registry().lock().unwrap().insert(id.clone(), session);
    (id, token)
}

pub enum HelloOutcome {
    /// First connection (or pre-accept reconnect): user confirmation needed.
    PendingAccept,
    /// Re-hello of an accepted session: resume without re-confirmation.
    ResumeAccepted,
    UnknownSession,
    BadToken { session_invalidated: bool },
    /// A live connection already owns this session (single-peer rule).
    Busy,
}

/// Validate a `hello` and attach the connection's outbound channel.
/// Returns the epoch the ws task must present on detach.
pub fn handle_hello(
    session_id: &str,
    token: &str,
    client_kind: &str,
    client_os: &str,
    name: Option<&str>,
    tx: UnboundedSender<ServerMessage>,
) -> (HelloOutcome, u64) {
    sweep();
    let mut reg = registry().lock().unwrap();
    let Some(s) = reg.get_mut(session_id) else {
        return (HelloOutcome::UnknownSession, 0);
    };
    if matches!(s.state, SessionState::Expired) {
        return (HelloOutcome::UnknownSession, 0);
    }
    if s.token != token {
        s.token_failures += 1;
        let invalidated = s.token_failures >= MAX_TOKEN_ATTEMPTS;
        if invalidated {
            s.state = SessionState::Expired;
        }
        return (
            HelloOutcome::BadToken {
                session_invalidated: invalidated,
            },
            0,
        );
    }
    // Correct token from the QR holder clears the strike count: failures are
    // meant to count consecutive bad guesses against a still-unpaired session,
    // not to let a second device on the LAN grief a session by burning attempts
    // across reconnects.
    s.token_failures = 0;
    // Single-peer rule: a healthy attached connection blocks a second hello.
    if s.tx.as_ref().is_some_and(|t| !t.is_closed())
        && matches!(
            s.state,
            SessionState::PendingAccept | SessionState::Accepted
        )
    {
        return (HelloOutcome::Busy, 0);
    }
    s.conn_epoch += 1;
    s.tx = Some(tx);
    s.client_kind = Some(client_kind.to_string());
    s.client_os = Some(client_os.to_string());
    if let Some(n) = name {
        let n = n.trim();
        if !n.is_empty() {
            s.label = n.chars().take(64).collect();
        }
    }
    let outcome = match s.state {
        SessionState::Accepted | SessionState::Reconnecting | SessionState::Disconnected => {
            s.state = SessionState::Accepted;
            s.dropped_at = None;
            HelloOutcome::ResumeAccepted
        }
        _ => {
            s.state = SessionState::PendingAccept;
            HelloOutcome::PendingAccept
        }
    };
    (outcome, s.conn_epoch)
}

/// Detach a connection (socket closed). Only the epoch owner may transition.
pub fn handle_disconnect(session_id: &str, epoch: u64) {
    let mut reg = registry().lock().unwrap();
    let Some(s) = reg.get_mut(session_id) else {
        return;
    };
    if s.conn_epoch != epoch {
        return; // a newer connection replaced us
    }
    s.tx = None;
    match s.state {
        SessionState::Accepted => {
            s.state = SessionState::Reconnecting;
            s.dropped_at = Some(Instant::now());
        }
        SessionState::PendingAccept => {
            s.state = SessionState::Created;
            s.token_failures = 0;
        }
        _ => {}
    }
}

/// User clicked Accept in the pairing sheet. Pushes `accepted` to the phone.
pub fn accept(session_id: &str) -> Result<(), String> {
    let mut reg = registry().lock().unwrap();
    let s = reg
        .get_mut(session_id)
        .ok_or_else(|| "unknown session".to_string())?;
    match s.state {
        SessionState::PendingAccept | SessionState::Accepted => {
            s.state = SessionState::Accepted;
            s.dropped_at = None;
            if let Some(tx) = &s.tx {
                let _ = tx.send(ServerMessage::Accepted {});
            }
            Ok(())
        }
        other => Err(format!("session not awaiting acceptance (state {other:?})")),
    }
}

/// User clicked Reject. Pushes `rejected` and expires the session.
pub fn reject(session_id: &str, reason: &str) -> Result<(), String> {
    let mut reg = registry().lock().unwrap();
    let s = reg
        .get_mut(session_id)
        .ok_or_else(|| "unknown session".to_string())?;
    if let Some(tx) = &s.tx {
        let _ = tx.send(ServerMessage::Rejected {
            reason: reason.to_string(),
        });
    }
    s.state = SessionState::Expired;
    s.tx = None;
    Ok(())
}

/// Remove a session entirely (user deleted the input / closed pairing).
pub fn remove(session_id: &str) {
    let mut reg = registry().lock().unwrap();
    if let Some(s) = reg.remove(session_id) {
        if let Some(tx) = &s.tx {
            let _ = tx.send(ServerMessage::Bye {
                reason: "session-removed".to_string(),
            });
        }
    }
}

pub fn list() -> Vec<PhoneSessionStatus> {
    sweep();
    let reg = registry().lock().unwrap();
    let mut out: Vec<PhoneSessionStatus> = reg.values().map(snapshot).collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

pub fn status(session_id: &str) -> Option<PhoneSessionStatus> {
    sweep();
    registry().lock().unwrap().get(session_id).map(snapshot)
}

fn snapshot(s: &PhoneSession) -> PhoneSessionStatus {
    let expires_in_secs = match s.state {
        SessionState::Created => Some(
            UNPAIRED_TTL
                .saturating_sub(s.created_at.elapsed())
                .as_secs(),
        ),
        SessionState::Reconnecting => s
            .dropped_at
            .map(|d| RECONNECT_GRACE.saturating_sub(d.elapsed()).as_secs()),
        _ => None,
    };
    PhoneSessionStatus {
        id: s.id.clone(),
        label: s.label.clone(),
        state: s.state,
        client_kind: s.client_kind.clone(),
        client_os: s.client_os.clone(),
        expires_in_secs,
    }
}

/// Advance time-driven transitions. Called opportunistically from every
/// entry point (no background timer needed at Phase 1 scale).
fn sweep() {
    let mut reg = registry().lock().unwrap();
    for s in reg.values_mut() {
        match s.state {
            SessionState::Created if s.created_at.elapsed() > UNPAIRED_TTL => {
                s.state = SessionState::Expired;
            }
            SessionState::Reconnecting
                if s.dropped_at.is_some_and(|d| d.elapsed() > RECONNECT_GRACE) =>
            {
                s.state = SessionState::Disconnected;
            }
            _ => {}
        }
    }
    reg.retain(|_, s| !(s.state == SessionState::Expired && s.tx.is_none()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc::unbounded_channel;

    /// The registry is process-global; cargo runs tests in parallel. Each
    /// test holds this lock and starts from a cleared registry.
    fn setup() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: Mutex<()> = Mutex::new(());
        let guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        registry().lock().unwrap().clear();
        guard
    }

    fn hello(
        sid: &str,
        token: &str,
    ) -> (
        HelloOutcome,
        u64,
        tokio::sync::mpsc::UnboundedReceiver<ServerMessage>,
    ) {
        let (tx, rx) = unbounded_channel();
        let (outcome, epoch) = handle_hello(sid, token, "browser", "test", Some("Test Phone"), tx);
        (outcome, epoch, rx)
    }

    #[test]
    fn happy_path_pending_then_accept() {
        let _g = setup();
        let (sid, token) = create_session(None);
        let (outcome, _epoch, mut rx) = hello(&sid, &token);
        assert!(matches!(outcome, HelloOutcome::PendingAccept));
        assert_eq!(status(&sid).unwrap().state, SessionState::PendingAccept);
        assert_eq!(status(&sid).unwrap().label, "Test Phone");

        accept(&sid).unwrap();
        assert_eq!(status(&sid).unwrap().state, SessionState::Accepted);
        assert!(matches!(rx.try_recv(), Ok(ServerMessage::Accepted {})));
    }

    #[test]
    fn bad_token_five_strikes_invalidates() {
        let _g = setup();
        let (sid, _token) = create_session(None);
        for i in 1..=MAX_TOKEN_ATTEMPTS {
            let (outcome, _, _rx) = hello(&sid, "wrong");
            match outcome {
                HelloOutcome::BadToken {
                    session_invalidated,
                } => {
                    assert_eq!(session_invalidated, i == MAX_TOKEN_ATTEMPTS);
                }
                _ => panic!("expected BadToken"),
            }
        }
        // Session expired and swept; correct token no longer works either.
        let (sid2, token2) = create_session(None);
        assert!(status(&sid).is_none());
        let (outcome, _, _rx) = hello(&sid, &token2);
        assert!(matches!(outcome, HelloOutcome::UnknownSession));
        // Unrelated session unaffected.
        let (outcome, _, _rx) = hello(&sid2, &token2);
        assert!(matches!(outcome, HelloOutcome::PendingAccept));
    }

    #[test]
    fn correct_token_clears_strikes_so_session_survives() {
        let _g = setup();
        let (sid, token) = create_session(None);
        // Four bad guesses (one short of invalidation), as a griefing peer might.
        for _ in 1..MAX_TOKEN_ATTEMPTS {
            let (outcome, _, _rx) = hello(&sid, "wrong");
            assert!(matches!(outcome, HelloOutcome::BadToken { .. }));
        }
        // The real QR holder connects with the correct token: strikes reset.
        let (outcome, epoch, _rx) = hello(&sid, &token);
        assert!(matches!(outcome, HelloOutcome::PendingAccept));
        // Pre-accept drop returns to Created and must NOT carry stale strikes.
        handle_disconnect(&sid, epoch);
        assert_eq!(status(&sid).unwrap().state, SessionState::Created);
        // A fresh round of four bad guesses again does not invalidate, proving
        // the counter was cleared rather than merely paused.
        for _ in 1..MAX_TOKEN_ATTEMPTS {
            let (outcome, _, _rx) = hello(&sid, "wrong");
            match outcome {
                HelloOutcome::BadToken { session_invalidated } => {
                    assert!(!session_invalidated)
                }
                _ => panic!("expected BadToken"),
            }
        }
        assert!(status(&sid).is_some());
    }

    #[test]
    fn second_live_connection_is_busy() {
        let _g = setup();
        let (sid, token) = create_session(None);
        let (_o1, _e1, _rx1) = hello(&sid, &token);
        let (o2, _, _rx2) = hello(&sid, &token);
        assert!(matches!(o2, HelloOutcome::Busy));
    }

    #[test]
    fn accepted_drop_reconnects_without_reconfirmation() {
        let _g = setup();
        let (sid, token) = create_session(None);
        let (_o, epoch, _rx) = hello(&sid, &token);
        accept(&sid).unwrap();

        handle_disconnect(&sid, epoch);
        assert_eq!(status(&sid).unwrap().state, SessionState::Reconnecting);

        let (outcome, _, _rx2) = hello(&sid, &token);
        assert!(matches!(outcome, HelloOutcome::ResumeAccepted));
        assert_eq!(status(&sid).unwrap().state, SessionState::Accepted);
    }

    #[test]
    fn stale_epoch_cannot_clobber_replacement() {
        let _g = setup();
        let (sid, token) = create_session(None);
        let (_o, old_epoch, _rx) = hello(&sid, &token);
        accept(&sid).unwrap();
        handle_disconnect(&sid, old_epoch);
        let (_o2, _new_epoch, _rx2) = hello(&sid, &token); // resume
        handle_disconnect(&sid, old_epoch); // stale close arrives late
        assert_eq!(status(&sid).unwrap().state, SessionState::Accepted);
    }

    #[test]
    fn pre_accept_drop_returns_to_created() {
        let _g = setup();
        let (sid, token) = create_session(None);
        let (_o, epoch, _rx) = hello(&sid, &token);
        handle_disconnect(&sid, epoch);
        assert_eq!(status(&sid).unwrap().state, SessionState::Created);
    }

    #[test]
    fn reject_expires_session() {
        let _g = setup();
        let (sid, token) = create_session(None);
        let (_o, _e, mut rx) = hello(&sid, &token);
        reject(&sid, "user-declined").unwrap();
        assert!(matches!(rx.try_recv(), Ok(ServerMessage::Rejected { .. })));
        assert!(status(&sid).is_none() || status(&sid).unwrap().state == SessionState::Expired);
    }

    #[test]
    fn snapshot_never_contains_token() {
        let _g = setup();
        let (sid, token) = create_session(None);
        let json = serde_json::to_string(&status(&sid).unwrap()).unwrap();
        assert!(!json.contains(&token));
    }
}
