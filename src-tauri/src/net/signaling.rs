//! Signaling protocol v1 message types and envelope handling.
//!
//! JSON over the `/ws` WebSocket. Wire contract lives in
//! `docs/phone/protocol-v1.md`; keep both in sync. Every message carries
//! `v: 1`; the envelope is validated before the payload is parsed so an
//! unknown major version is rejected uniformly regardless of message shape.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u64 = 1;

/// Phone -> desktop messages.
// Media/stat payloads are read starting Phase 2 (net::webrtc_peer); the wire
// contract ships complete from Phase 1 so clients can be built against it.
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ClientMessage {
    #[serde(rename_all = "camelCase")]
    Hello {
        session: String,
        token: String,
        client: ClientInfo,
        #[serde(default)]
        caps: Caps,
        #[serde(default)]
        name: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Offer { sdp: String },
    #[serde(rename_all = "camelCase")]
    Candidate {
        candidate: String,
        #[serde(default)]
        sdp_mid: Option<String>,
        #[serde(default)]
        sdp_m_line_index: Option<u32>,
    },
    #[serde(rename_all = "camelCase")]
    Stats {
        mic_level: f32,
        visible: bool,
        #[serde(default)]
        muted: Option<bool>,
        #[serde(default)]
        battery_saver: Option<bool>,
    },
    /// Mini-controller remote (MC-5): set the OS default speaker/mic volume.
    /// `target` is "speaker" | "mic"; `value` is 0.0..=1.0. Honored only for an
    /// accepted session.
    #[serde(rename_all = "camelCase")]
    SetEndpointVolume { target: String, value: f32 },
    /// Mini-controller remote: mute/unmute the OS default speaker/mic.
    #[serde(rename_all = "camelCase")]
    SetEndpointMute { target: String, muted: bool },
    /// Mini-controller remote: request a fresh `EndpointState` push.
    RequestEndpointState,
    #[serde(rename_all = "camelCase")]
    Bye { reason: String },
}

/// Desktop -> phone messages.
// Answer/Candidate/Latency are constructed starting Phase 2.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ServerMessage {
    #[serde(rename_all = "camelCase")]
    HelloAck {
        state: String,
        accept_required: bool,
        server: ServerInfo,
    },
    #[serde(rename_all = "camelCase")]
    Accepted {},
    #[serde(rename_all = "camelCase")]
    Rejected { reason: String },
    #[serde(rename_all = "camelCase")]
    Answer { sdp: String },
    #[serde(rename_all = "camelCase")]
    Candidate {
        candidate: String,
        sdp_mid: Option<String>,
        sdp_m_line_index: Option<u32>,
    },
    #[serde(rename_all = "camelCase")]
    Latency { mode: String },
    /// Mini-controller remote (MC-5): current OS default speaker + mic state.
    /// Pushed in reply to RequestEndpointState and after each remote change.
    #[serde(rename_all = "camelCase")]
    EndpointState { endpoints: Vec<EndpointStateView> },
    #[serde(rename_all = "camelCase")]
    Error {
        code: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        supported: Option<Vec<u64>>,
    },
    #[serde(rename_all = "camelCase")]
    Bye { reason: String },
}

/// One endpoint's state for the phone remote (MC-5). `target` is "speaker" |
/// "mic"; `available` is false when no default device exists (or off-Windows).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointStateView {
    pub target: String,
    pub name: String,
    pub volume: f32,
    pub muted: bool,
    pub available: bool,
}

#[allow(dead_code)] // ua/ver logged at debug from Phase 2
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    /// "browser" | "app" — informational only; the desktop never branches on it.
    pub kind: String,
    #[serde(default)]
    pub os: String,
    #[serde(default)]
    pub ua: String,
    #[serde(default)]
    pub ver: String,
}

#[allow(dead_code)] // codec negotiation consumes this in Phase 2
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Caps {
    #[serde(default)]
    pub codecs: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub name: String,
    pub app_ver: String,
}

/// Why an inbound frame was refused at the envelope layer.
#[derive(Debug, PartialEq)]
pub enum ProtocolError {
    /// Not JSON, not an object, or missing `v`/`type`. Fatal.
    Malformed,
    /// `v` is present but not a major we speak. Fatal.
    Version { got: u64 },
    /// Valid envelope, valid version, but a `type` we do not know. Non-fatal.
    Unsupported { kind: String },
}

/// Parse one inbound text frame: envelope (v + type) first, then payload.
pub fn parse_client_message(text: &str) -> Result<ClientMessage, ProtocolError> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|_| ProtocolError::Malformed)?;
    let obj = value.as_object().ok_or(ProtocolError::Malformed)?;
    let v = obj
        .get("v")
        .and_then(|v| v.as_u64())
        .ok_or(ProtocolError::Malformed)?;
    if v != PROTOCOL_VERSION {
        return Err(ProtocolError::Version { got: v });
    }
    let kind = obj
        .get("type")
        .and_then(|t| t.as_str())
        .ok_or(ProtocolError::Malformed)?
        .to_string();
    match serde_json::from_value::<ClientMessage>(value) {
        Ok(msg) => Ok(msg),
        // Tagged-enum failure on an unknown tag is "unsupported"; a known tag
        // with a bad payload is malformed. serde does not distinguish, so we
        // check the tag against the known set ourselves.
        Err(_) => {
            const KNOWN: [&str; 8] = [
                "hello",
                "offer",
                "candidate",
                "stats",
                "bye",
                "set-endpoint-volume",
                "set-endpoint-mute",
                "request-endpoint-state",
            ];
            if KNOWN.contains(&kind.as_str()) {
                Err(ProtocolError::Malformed)
            } else {
                Err(ProtocolError::Unsupported { kind })
            }
        }
    }
}

/// Serialize an outbound message with the `v` envelope field injected.
pub fn encode_server_message(msg: &ServerMessage) -> String {
    let mut value = serde_json::to_value(msg).expect("ServerMessage serializes");
    if let Some(obj) = value.as_object_mut() {
        obj.insert("v".into(), serde_json::json!(PROTOCOL_VERSION));
    }
    value.to_string()
}

impl ServerMessage {
    pub fn version_error(got: u64) -> Self {
        ServerMessage::Error {
            code: "version".into(),
            message: format!("unsupported protocol version {got}"),
            supported: Some(vec![PROTOCOL_VERSION]),
        }
    }

    pub fn error(code: &str, message: impl Into<String>) -> Self {
        ServerMessage::Error {
            code: code.into(),
            message: message.into(),
            supported: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_round_trip() {
        let text = r#"{"v":1,"type":"hello","session":"abc","token":"tok",
            "client":{"kind":"browser","os":"iOS","ua":"Safari","ver":"0.1.0"},
            "caps":{"codecs":["opus"]},"name":"My iPhone"}"#;
        match parse_client_message(text).unwrap() {
            ClientMessage::Hello {
                session,
                token,
                client,
                caps,
                name,
            } => {
                assert_eq!(session, "abc");
                assert_eq!(token, "tok");
                assert_eq!(client.kind, "browser");
                assert_eq!(caps.codecs, vec!["opus"]);
                assert_eq!(name.as_deref(), Some("My iPhone"));
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn stats_carries_muted_and_battery_saver() {
        let text = r#"{"v":1,"type":"stats","micLevel":0.4,"visible":true,"muted":true,"batterySaver":true}"#;
        match parse_client_message(text).unwrap() {
            ClientMessage::Stats {
                muted,
                battery_saver,
                ..
            } => {
                assert_eq!(muted, Some(true));
                assert_eq!(battery_saver, Some(true));
            }
            other => panic!("wrong variant: {other:?}"),
        }
        // Both optional: a minimal stats frame still parses.
        let bare = r#"{"v":1,"type":"stats","micLevel":0.0,"visible":false}"#;
        assert!(matches!(
            parse_client_message(bare),
            Ok(ClientMessage::Stats {
                muted: None,
                battery_saver: None,
                ..
            })
        ));
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let text = r#"{"v":1,"type":"bye","reason":"user-stop","extra":42}"#;
        assert!(matches!(
            parse_client_message(text),
            Ok(ClientMessage::Bye { .. })
        ));
    }

    #[test]
    fn wrong_version_rejected() {
        let text = r#"{"v":2,"type":"hello","session":"a","token":"b"}"#;
        assert_eq!(
            parse_client_message(text).unwrap_err(),
            ProtocolError::Version { got: 2 }
        );
    }

    #[test]
    fn missing_version_is_malformed() {
        assert_eq!(
            parse_client_message(r#"{"type":"bye","reason":"x"}"#).unwrap_err(),
            ProtocolError::Malformed
        );
        assert_eq!(
            parse_client_message("not json").unwrap_err(),
            ProtocolError::Malformed
        );
    }

    #[test]
    fn unknown_type_is_unsupported_not_fatal() {
        let err = parse_client_message(r#"{"v":1,"type":"warp-drive"}"#).unwrap_err();
        assert_eq!(
            err,
            ProtocolError::Unsupported {
                kind: "warp-drive".into()
            }
        );
    }

    #[test]
    fn known_type_with_bad_payload_is_malformed() {
        let err = parse_client_message(r#"{"v":1,"type":"offer"}"#).unwrap_err();
        assert_eq!(err, ProtocolError::Malformed);
    }

    #[test]
    fn outbound_carries_version() {
        let s = encode_server_message(&ServerMessage::Accepted {});
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["v"], 1);
        assert_eq!(v["type"], "accepted");
    }

    #[test]
    fn version_error_lists_supported() {
        let s = encode_server_message(&ServerMessage::version_error(3));
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["code"], "version");
        assert_eq!(v["supported"][0], 1);
    }
}
