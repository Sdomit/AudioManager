//! The phone-facing HTTPS server: static client files + `/ws` signaling.
//!
//! One axum listener serves both. TLS comes from `net::tls`; the client
//! bundle is embedded from `../dist-phone` (rust-embed reads the folder live
//! from disk in debug builds, which is the phone-client dev loop).

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::ConnectInfo;
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use rust_embed::RustEmbed;
use tokio::sync::mpsc;

use super::session::{self, HelloOutcome};
use super::signaling::{
    encode_server_message, parse_client_message, ClientMessage, EndpointStateView, ProtocolError,
    ServerInfo, ServerMessage,
};
use super::webrtc_peer;
use crate::audio::endpoint_ctl;

#[derive(RustEmbed)]
#[folder = "../dist-phone/"]
struct PhoneAssets;

/// Largest frame we accept before (and including) `hello`.
const PRE_HELLO_MAX_BYTES: usize = 2048;
/// How long a fresh socket may sit silent before we drop it.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// Keepalive ping cadence. If no inbound frame (a pong, or any message) arrived
/// since the previous ping, the socket is dead/idle and is dropped — so a dead
/// or idle-forever peer cannot pin server resources. Detection latency is one to
/// two intervals depending on phase. A live stream stays up: browsers auto-pong
/// the ping and the phone also sends a stats frame ~1 Hz, both of which reset it.
const KEEPALIVE: Duration = Duration::from_secs(20);
/// Sliding window for the per-IP handshake rate limit.
const RATE_WINDOW: Duration = Duration::from_secs(10);
/// Max `/ws` handshakes per source IP per window — well above any honest
/// reconnect cadence, low enough to blunt a connection flood.
const RATE_MAX: usize = 12;

/// Per-IP handshake timestamps for the sliding-window rate limit.
fn rate_table() -> &'static Mutex<HashMap<IpAddr, Vec<Instant>>> {
    static T: OnceLock<Mutex<HashMap<IpAddr, Vec<Instant>>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Record a handshake from `ip`; false when it has exceeded `RATE_MAX` in the
/// last `RATE_WINDOW`.
fn allow_handshake(ip: IpAddr) -> bool {
    let now = Instant::now();
    let mut table = rate_table().lock().unwrap();
    // Opportunistic GC so the table can't grow without bound.
    table.retain(|_, hits| {
        hits.retain(|t| now.duration_since(*t) < RATE_WINDOW);
        !hits.is_empty()
    });
    let hits = table.entry(ip).or_default();
    if hits.len() >= RATE_MAX {
        return false;
    }
    hits.push(now);
    true
}

pub fn router() -> Router {
    Router::new()
        .route("/ws", get(ws_upgrade))
        .fallback(static_handler)
}

// ── Static phone client ───────────────────────────────────────────────────────

async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "phone.html" } else { path };
    match PhoneAssets::get(path) {
        Some(content) => (
            [(header::CONTENT_TYPE, mime_for(path))],
            content.data.into_owned(),
        )
            .into_response(),
        // SPA-style fallback: unknown non-asset paths serve the client shell
        // so the QR URL works regardless of routing inside the page.
        None if !path.contains('.') => match PhoneAssets::get("phone.html") {
            Some(content) => (
                [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                content.data.into_owned(),
            )
                .into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        },
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript",
        Some("css") => "text/css",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("wasm") => "application/wasm",
        Some("map") => "application/json",
        _ => "application/octet-stream",
    }
}

// ── Signaling socket ──────────────────────────────────────────────────────────

async fn ws_upgrade(ws: WebSocketUpgrade, ConnectInfo(peer): ConnectInfo<SocketAddr>) -> Response {
    if !allow_handshake(peer.ip()) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    ws.on_upgrade(handle_socket)
}

async fn handle_socket(socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();

    // First frame must be a valid `hello` within the timeout.
    let first = match tokio::time::timeout(HELLO_TIMEOUT, stream.next()).await {
        Ok(Some(Ok(Message::Text(text)))) => text,
        _ => return, // timeout, close, or non-text garbage: drop silently
    };
    if first.len() > PRE_HELLO_MAX_BYTES {
        return;
    }

    let hello = match parse_client_message(&first) {
        Ok(msg @ ClientMessage::Hello { .. }) => msg,
        Ok(_) => {
            let _ = send(
                &mut sink,
                &ServerMessage::error("malformed", "expected hello"),
            )
            .await;
            return;
        }
        Err(ProtocolError::Version { got }) => {
            let _ = send(&mut sink, &ServerMessage::version_error(got)).await;
            return;
        }
        Err(_) => {
            let _ = send(&mut sink, &ServerMessage::error("malformed", "bad frame")).await;
            return;
        }
    };
    let ClientMessage::Hello {
        session: session_id,
        token,
        client,
        name,
        ..
    } = hello
    else {
        unreachable!("matched Hello above");
    };

    let (tx, mut out_rx) = mpsc::unbounded_channel::<ServerMessage>();
    let (outcome, epoch) = session::handle_hello(
        &session_id,
        &token,
        &client.kind,
        &client.os,
        name.as_deref(),
        tx.clone(),
    );
    // A trusted device whose in-memory session was lost (e.g. the desktop app
    // restarted) is unknown to the registry but known to the persisted store:
    // verify its token and auto-resume without a re-prompt. The socket-layer
    // gates (per-IP rate limit, pre-hello byte cap) already ran above, so this
    // adds no ingress that skips them.
    let (outcome, epoch) = match outcome {
        HelloOutcome::UnknownSession => session::try_resume_trusted(
            &session_id,
            &token,
            &client.kind,
            &client.os,
            name.as_deref(),
            tx,
        ),
        other => (other, epoch),
    };

    let resumed = match outcome {
        HelloOutcome::PendingAccept => false,
        HelloOutcome::ResumeAccepted => true,
        HelloOutcome::UnknownSession => {
            let _ = send(
                &mut sink,
                &ServerMessage::error("unknown-session", "session expired or removed"),
            )
            .await;
            return;
        }
        HelloOutcome::BadToken {
            session_invalidated,
        } => {
            let detail = if session_invalidated {
                "too many bad tokens — session invalidated, pair again"
            } else {
                "token mismatch"
            };
            let _ = send(&mut sink, &ServerMessage::error("bad-token", detail)).await;
            return;
        }
        HelloOutcome::Busy => {
            let _ = send(
                &mut sink,
                &ServerMessage::error("busy", "session already has a live peer"),
            )
            .await;
            return;
        }
    };

    let state = session::status(&session_id)
        .map(|s| format!("{:?}", s.state).to_lowercase())
        .unwrap_or_else(|| "unknown".to_string());
    let ack = ServerMessage::HelloAck {
        state,
        accept_required: !resumed,
        server: ServerInfo {
            name: "AudioManager".to_string(),
            app_ver: env!("CARGO_PKG_VERSION").to_string(),
        },
    };
    if send(&mut sink, &ack).await.is_err() {
        session::handle_disconnect(&session_id, epoch);
        return;
    }
    if resumed {
        let _ = send(&mut sink, &ServerMessage::Accepted {}).await;
    }

    // Steady state: relay queued outbound messages and dispatch inbound ones.
    // `peer` is the WebRTC receiver, created when the phone sends its offer.
    let mut peer: Option<webrtc_peer::Peer> = None;
    // Liveness: ping every KEEPALIVE; if the previous ping drew no inbound frame
    // (pong or anything else) by the next tick, the socket is dead/idle — drop it.
    let mut keepalive = tokio::time::interval(KEEPALIVE);
    let mut awaiting_pong = false;
    loop {
        tokio::select! {
            _ = keepalive.tick() => {
                if awaiting_pong {
                    break; // no reply since the last ping
                }
                if sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
                awaiting_pong = true;
            }
            outbound = out_rx.recv() => {
                match outbound {
                    Some(msg) => {
                        let ends = matches!(msg, ServerMessage::Rejected { .. } | ServerMessage::Bye { .. });
                        if send(&mut sink, &msg).await.is_err() || ends {
                            break;
                        }
                    }
                    None => break, // session dropped its sender (removed)
                }
            }
            inbound = stream.next() => {
                // Any inbound frame proves the peer is alive.
                awaiting_pong = false;
                match inbound {
                    Some(Ok(Message::Text(text))) => {
                        match parse_client_message(&text) {
                            Ok(ClientMessage::Hello { .. }) => {
                                // Duplicate hello on a live socket: ignore.
                            }
                            Ok(ClientMessage::Offer { sdp }) => {
                                // Build (or rebuild, on renegotiation) the receiver
                                // and answer. Stats flow into the session so the
                                // pairing sheet can show a live level meter.
                                match (
                                    session::stats_handle(&session_id),
                                    session::latency_handle(&session_id),
                                ) {
                                    (Some(stats), Some(latency)) => match webrtc_peer::answer_offer(
                                        session_id.clone(),
                                        sdp,
                                        stats,
                                        latency,
                                    )
                                    .await
                                    {
                                        Ok((pc, answer_sdp)) => {
                                            peer = Some(pc);
                                            if send(&mut sink, &ServerMessage::Answer { sdp: answer_sdp })
                                                .await
                                                .is_err()
                                            {
                                                break;
                                            }
                                        }
                                        Err(e) => {
                                            eprintln!("[phone] webrtc answer failed: {e}");
                                            let _ = send(
                                                &mut sink,
                                                &ServerMessage::error("webrtc", "could not start audio"),
                                            )
                                            .await;
                                        }
                                    },
                                    _ => break, // session vanished mid-handshake
                                }
                            }
                            Ok(ClientMessage::Candidate {
                                candidate,
                                sdp_mid,
                                sdp_m_line_index,
                            }) => {
                                if let Some(pc) = &peer {
                                    let _ = webrtc_peer::add_remote_candidate(
                                        pc,
                                        candidate,
                                        sdp_mid,
                                        sdp_m_line_index.map(|i| i as u16),
                                    )
                                    .await;
                                }
                            }
                            Ok(ClientMessage::Stats { muted, battery_saver, .. }) => {
                                // Desktop derives its own meter from decoded audio;
                                // the stats we surface are the phone's mute and
                                // data-saver state, for badges in the pairing sheet.
                                if let Some(stats) = session::stats_handle(&session_id) {
                                    if let Some(m) = muted {
                                        stats.set_muted(m);
                                    }
                                    if let Some(b) = battery_saver {
                                        stats.set_battery_saver(b);
                                    }
                                }
                            }
                            // Mini-controller remote (MC-5). Gated on an accepted
                            // session so a still-pending phone can never drive the
                            // desktop's OS audio. Each change echoes a fresh state.
                            Ok(ClientMessage::SetEndpointVolume { target, value }) => {
                                if session::is_accepted(&session_id) {
                                    if let Some(dir) = endpoint_direction(&target) {
                                        if let Ok(Some(id)) = endpoint_ctl::default_endpoint_id(dir) {
                                            let _ = endpoint_ctl::set_endpoint_volume(&id, value);
                                        }
                                    }
                                    if send(&mut sink, &endpoint_state_message()).await.is_err() {
                                        break;
                                    }
                                }
                            }
                            Ok(ClientMessage::SetEndpointMute { target, muted }) => {
                                if session::is_accepted(&session_id) {
                                    if let Some(dir) = endpoint_direction(&target) {
                                        if let Ok(Some(id)) = endpoint_ctl::default_endpoint_id(dir) {
                                            let _ = endpoint_ctl::set_endpoint_mute(&id, muted);
                                        }
                                    }
                                    if send(&mut sink, &endpoint_state_message()).await.is_err() {
                                        break;
                                    }
                                }
                            }
                            Ok(ClientMessage::RequestEndpointState) => {
                                if session::is_accepted(&session_id)
                                    && send(&mut sink, &endpoint_state_message()).await.is_err()
                                {
                                    break;
                                }
                            }
                            Ok(ClientMessage::Bye { .. }) => break,
                            Err(ProtocolError::Version { got }) => {
                                let _ = send(&mut sink, &ServerMessage::version_error(got)).await;
                                break;
                            }
                            Err(ProtocolError::Unsupported { kind }) => {
                                let _ = send(
                                    &mut sink,
                                    &ServerMessage::error("unsupported", format!("unknown type {kind}")),
                                )
                                .await;
                            }
                            Err(ProtocolError::Malformed) => {
                                let _ = send(&mut sink, &ServerMessage::error("malformed", "bad frame")).await;
                                break;
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {} // ping/pong/binary: ignore
                    Some(Err(_)) => break,
                }
            }
        }
    }

    if let Some(pc) = peer {
        let _ = pc.close().await;
    }
    session::handle_disconnect(&session_id, epoch);
}

async fn send(sink: &mut (impl SinkExt<Message> + Unpin), msg: &ServerMessage) -> Result<(), ()> {
    sink.send(Message::Text(encode_server_message(msg).into()))
        .await
        .map_err(|_| ())
}

/// Map a remote "speaker"/"mic" target to an endpoint direction (MC-5).
fn endpoint_direction(target: &str) -> Option<endpoint_ctl::Direction> {
    match target {
        "speaker" => Some(endpoint_ctl::Direction::Render),
        "mic" => Some(endpoint_ctl::Direction::Capture),
        _ => None,
    }
}

/// Snapshot the current OS default speaker + mic for an `EndpointState` push
/// (MC-5). The COM calls are synchronous but user-driven and infrequent, so
/// they run inline. ponytail: if a control burst ever stutters the ws task,
/// wrap these in `tokio::task::spawn_blocking`.
fn endpoint_state_message() -> ServerMessage {
    let endpoints = [
        ("speaker", endpoint_ctl::Direction::Render),
        ("mic", endpoint_ctl::Direction::Capture),
    ]
    .into_iter()
    .map(
        |(target, dir)| match endpoint_ctl::default_endpoint_id(dir) {
            Ok(Some(id)) => {
                let vol = endpoint_ctl::get_endpoint_volume(&id).ok();
                let name = endpoint_ctl::list_endpoints(dir)
                    .ok()
                    .and_then(|l| l.into_iter().find(|e| e.id == id).map(|e| e.name))
                    .unwrap_or_default();
                EndpointStateView {
                    target: target.to_string(),
                    name,
                    volume: vol.as_ref().map(|v| v.volume).unwrap_or(0.0),
                    muted: vol.as_ref().map(|v| v.muted).unwrap_or(false),
                    available: vol.is_some(),
                }
            }
            _ => EndpointStateView {
                target: target.to_string(),
                name: String::new(),
                volume: 0.0,
                muted: false,
                available: false,
            },
        },
    )
    .collect();
    ServerMessage::EndpointState { endpoints }
}
