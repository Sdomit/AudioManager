//! WebRTC receiver for the phone's microphone track.
//!
//! The inbound Opus RTP track is read in one task (#43): each packet goes into a
//! [`JitterBuffer`] for reordering / loss detection, then we drain the surplus
//! beyond the mode's hold window — decoding (Opus PLC on a gap) and pushing PCM
//! into the mixer feed (`audio::remote`) plus the meter/stat counters.
//!
//! Output is paced by arrivals, not a separate clock: the mixer's ring (drained
//! at 48 kHz) is the playout buffer, so there is no wall-clock feeder to drift
//! against the audio clock. The held window is set by the session's
//! [`LatencyMode`] and can change live.
//!
//! ICE is non-trickle on our side: we gather fully, then return an answer with
//! candidates embedded (simplest correct flow on a LAN). The phone may still
//! trickle its candidates to us; `add_remote_candidate` feeds those in.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;

use audiopus::coder::Decoder;
use audiopus::packet::Packet;
use audiopus::{Channels, MutSignals, SampleRate};
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_OPUS};
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::{
    RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType,
};
use webrtc::track::track_remote::TrackRemote;

use super::jitter::{JitterBuffer, LatencyMode, Tick};
use super::session::PhoneStats;
use crate::audio::remote;

/// Shared handle to a live peer connection, owned by the ws task.
pub type Peer = Arc<RTCPeerConnection>;

/// We always decode to stereo (mono Opus up-mixes to L=R), so the phone input
/// carries two channels — real L/R from a stereo mic, duplicated for a mono one.
const DECODE_CHANNELS: usize = 2;

/// Largest decode: 120 ms at 48 kHz, interleaved stereo.
const DECODE_BUF_SAMPLES: usize = 48_000 / 1000 * 120 * DECODE_CHANNELS;

/// Build a peer, answer the phone's offer, and start decoding its track.
/// Returns the peer (keep it alive for the call's duration) and the answer SDP.
pub async fn answer_offer(
    session_id: String,
    offer_sdp: String,
    stats: Arc<PhoneStats>,
    latency: Arc<AtomicU8>,
) -> Result<(Peer, String), String> {
    let mut media = MediaEngine::default();
    media
        .register_codec(
            RTCRtpCodecParameters {
                capability: RTCRtpCodecCapability {
                    mime_type: MIME_TYPE_OPUS.to_owned(),
                    clock_rate: 48_000,
                    channels: 2,
                    sdp_fmtp_line: "minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1".to_owned(),
                    rtcp_feedback: vec![],
                },
                payload_type: 111,
                ..Default::default()
            },
            RTPCodecType::Audio,
        )
        .map_err(|e| format!("register opus: {e}"))?;

    let mut registry = Registry::new();
    registry = register_default_interceptors(registry, &mut media)
        .map_err(|e| format!("interceptors: {e}"))?;

    let api = APIBuilder::new()
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .build();

    // No ICE servers: LAN-only, host candidates (decision D6).
    let pc = Arc::new(
        api.new_peer_connection(RTCConfiguration::default())
            .await
            .map_err(|e| format!("peer connection: {e}"))?,
    );

    let stats_for_track = Arc::clone(&stats);
    pc.on_track(Box::new(move |track, _receiver, _transceiver| {
        let stats = Arc::clone(&stats_for_track);
        let latency = Arc::clone(&latency);
        let sid = session_id.clone();
        Box::pin(async move {
            tokio::spawn(read_track(sid, track, stats, latency));
        })
    }));

    let offer =
        RTCSessionDescription::offer(offer_sdp).map_err(|e| format!("parse offer: {e}"))?;
    pc.set_remote_description(offer)
        .await
        .map_err(|e| format!("set remote: {e}"))?;

    let answer = pc
        .create_answer(None)
        .await
        .map_err(|e| format!("create answer: {e}"))?;
    // Gather all candidates before returning the answer (non-trickle).
    let mut gather_done = pc.gathering_complete_promise().await;
    pc.set_local_description(answer)
        .await
        .map_err(|e| format!("set local: {e}"))?;
    let _ = gather_done.recv().await;

    let local = pc
        .local_description()
        .await
        .ok_or_else(|| "no local description after gather".to_string())?;
    Ok((pc, local.sdp))
}

/// Feed a candidate the phone trickled to us.
pub async fn add_remote_candidate(
    pc: &RTCPeerConnection,
    candidate: String,
    sdp_mid: Option<String>,
    sdp_mline_index: Option<u16>,
) -> Result<(), String> {
    pc.add_ice_candidate(RTCIceCandidateInit {
        candidate,
        sdp_mid,
        sdp_mline_index,
        username_fragment: None,
    })
    .await
    .map_err(|e| format!("add candidate: {e}"))
}

/// Read RTP, reorder/conceal via the jitter buffer, decode, and push PCM into the
/// mixer feed. One task; output is paced by arrivals. Returns when the track ends.
async fn read_track(
    session_id: String,
    track: Arc<TrackRemote>,
    stats: Arc<PhoneStats>,
    latency: Arc<AtomicU8>,
) {
    let mut decoder = match Decoder::new(SampleRate::Hz48000, Channels::Stereo) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[phone] opus decoder init failed: {e}");
            return;
        }
    };
    let mut pcm = vec![0.0f32; DECODE_BUF_SAMPLES];
    let mut jb = JitterBuffer::new();
    let mut last_seq: Option<u16> = None;

    loop {
        let (packet, _attrs) = match track.read_rtp().await {
            Ok(v) => v,
            Err(_) => break, // track ended / peer closed
        };
        let payload = packet.payload;
        if payload.is_empty() {
            continue;
        }
        let seq = packet.header.sequence_number;
        let lost = match last_seq {
            Some(prev) => {
                let gap = seq.wrapping_sub(prev);
                if gap == 0 || gap > 0x8000 {
                    0
                } else {
                    u64::from(gap - 1)
                }
            }
            None => 0,
        };
        last_seq = Some(seq);
        stats.record_packet(payload.len(), lost);

        jb.insert(seq, payload.to_vec());
        let target = LatencyMode::from_u8(latency.load(Ordering::Relaxed)).target_frames();
        while let Some(action) = jb.drain_one(target) {
            let decoded = match action {
                Tick::Decode(p) => match Packet::try_from(&p[..]) {
                    Ok(pkt) => decode_into(&mut decoder, Some(pkt), &mut pcm),
                    Err(_) => None,
                },
                Tick::Conceal => decode_into(&mut decoder, None, &mut pcm),
            };
            if let Some(n) = decoded {
                // decode_float returns samples per channel; the buffer holds
                // `n * DECODE_CHANNELS` interleaved samples.
                let filled = n * DECODE_CHANNELS;
                let mut peak = 0.0f32;
                for &s in &pcm[..filled] {
                    let a = s.abs();
                    if a > peak {
                        peak = a;
                    }
                }
                stats.record_peak(peak);
                remote::push_decoded_48k(&session_id, &pcm[..filled], peak);
            }
        }
        stats.set_jitter(jb.depth() as u32, jb.plc);
    }
}

/// Decode one frame (or conceal when `input` is None) into `pcm`; returns the
/// per-channel sample count on success.
fn decode_into(decoder: &mut Decoder, input: Option<Packet<'_>>, pcm: &mut [f32]) -> Option<usize> {
    let out = MutSignals::try_from(&mut pcm[..]).ok()?;
    decoder.decode_float(input, out, false).ok()
}
