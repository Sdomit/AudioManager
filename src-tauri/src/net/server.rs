//! The phone-facing HTTPS server: static client files + `/ws` signaling.
//!
//! One axum listener serves both. TLS comes from `net::tls`; the client
//! bundle is embedded from `../dist-phone` (rust-embed reads the folder live
//! from disk in debug builds, which is the phone-client dev loop).

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use rust_embed::RustEmbed;
use tokio::sync::mpsc;

use super::session::{self, HelloOutcome};
use super::signaling::{
    encode_server_message, parse_client_message, ClientMessage, ProtocolError, ServerMessage,
    ServerInfo,
};
use super::webrtc_peer;

#[derive(RustEmbed)]
#[folder = "../dist-phone/"]
struct PhoneAssets;

/// Largest frame we accept before (and including) `hello`.
const PRE_HELLO_MAX_BYTES: usize = 2048;
/// How long a fresh socket may sit silent before we drop it.
const HELLO_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

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

async fn ws_upgrade(ws: WebSocketUpgrade) -> Response {
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
            let _ = send(&mut sink, &ServerMessage::error("malformed", "expected hello")).await;
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
        tx,
    );

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
        HelloOutcome::BadToken { session_invalidated } => {
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
    loop {
        tokio::select! {
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
                                match session::stats_handle(&session_id) {
                                    Some(stats) => match webrtc_peer::answer_offer(sdp, stats).await {
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
                                    None => break, // session vanished mid-handshake
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
                            Ok(ClientMessage::Stats { .. }) => {
                                // Phone-reported mic level / visibility — desktop
                                // derives its own meter from decoded audio, so
                                // these are advisory only for now.
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

async fn send(
    sink: &mut (impl SinkExt<Message> + Unpin),
    msg: &ServerMessage,
) -> Result<(), ()> {
    sink.send(Message::Text(encode_server_message(msg).into()))
        .await
        .map_err(|_| ())
}
