//! Remote (phone) audio feed — bridges decoded WebRTC audio into the mixer's
//! input rings. Counterpart of `loopback`, with one structural difference: the
//! producer side is **pushed** by the network task (`net::webrtc_peer`) rather
//! than pulled by a capture thread this module owns. There is therefore nothing
//! to "start" at subscribe time — a session that has not connected (or has
//! dropped) simply yields silence until audio arrives, which the mixer already
//! treats as silence (`pop().unwrap_or(0.0)`).
//!
//! Shared per (session, rate): two buses at the same rate share one feed and one
//! resampler. Lock order is one-way (manager map only); the realtime audio
//! thread never touches this module — it only drains the rings it was handed.
//!
//! Platform-agnostic (no `cfg(windows)`): WebRTC + Opus are cross-platform, so
//! this compiles everywhere even though the rest of the capture stack is
//! Windows-only.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use ringbuf::{Consumer, Producer, RingBuffer};

use crate::audio::mixer::{store_max, EngineError, InputSlotShared};
use crate::audio::resampler::{LinearResampler, MAX_TRIM_PPM};

/// The phone is decoded to interleaved stereo (net::webrtc_peer): a stereo mic
/// gives real L/R, a mono mic up-mixes to L=R. The mixer's stereo arms handle
/// both and downmix to mono buses when needed.
pub const PHONE_CHANNELS: u16 = 2;

/// ~80 ms at 48 kHz stereo (4 Opus frames, interleaved). The jitter buffer
/// (net::jitter) holds the mode's reorder window and releases one frame per
/// arrival, so this ring only bridges task/callback scheduling — keeping it
/// small bounds the latency that clock drift or arrival bursts can otherwise
/// accumulate (a 341 ms ring would hide a third of a second of delay). On
/// overflow `push` drops the newest sample, capping delay at the cost of a rare
/// glitch under sustained drift.
const REMOTE_RING_SIZE: usize = 3840 * PHONE_CHANNELS as usize;

/// WebRTC Opus is always decoded at 48 kHz; feeds resample from this to the bus rate.
const DECODE_RATE: u32 = 48_000;

// ── Drift compensator (Podcast/Adaptive mode only) ──
/// Run the integrator once per this many pushes (~1 s at 50 fps).
const DRIFT_CADENCE: u32 = 50;
/// Ppm step per integrator tick (slow, inaudible correction).
const DRIFT_STEP_PPM: i32 = 10;
/// Fill error (fraction of ring) ignored to avoid hunting around the target.
const DRIFT_DEADBAND: f32 = 0.08;
/// Target ring fill the integrator holds: half full = max slack both ways.
const DRIFT_TARGET_FILL: f32 = 0.5;

struct Subscriber {
    id: u64,
    producer: Producer<f32>,
    peak: Arc<Vec<InputSlotShared>>,
    index: usize,
}

/// One shared feed for a (session, rate) pair: a resampler from 48 kHz to the
/// bus rate and the set of bus subscribers fanned out to.
struct Feed {
    rate: u32,
    resampler: LinearResampler,
    subs: Vec<Subscriber>,
    /// Reused per-push output buffer; the push path is a tokio task, not realtime.
    scratch: Vec<f32>,
    // ── Drift compensator state (only moved in Adaptive mode) ──
    /// EMA of ring fill fraction (0..1), seeded half-full.
    fill_ema: f32,
    /// Pushes since the last integrator tick.
    push_count: u32,
    /// Current applied resampler trim in ppm.
    trim_ppm: i32,
    /// Ring-overflow drops (newest-dropped) for observability.
    ring_glitches: u64,
}

fn manager() -> &'static Mutex<HashMap<String, Feed>> {
    static M: OnceLock<Mutex<HashMap<String, Feed>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_id() -> u64 {
    static N: AtomicU64 = AtomicU64::new(1);
    N.fetch_add(1, Ordering::Relaxed)
}

fn key_for(session_id: &str, rate: u32) -> String {
    format!("phone:{session_id}@{rate}")
}

/// RAII handle: dropping it removes this bus's subscription; the feed is freed
/// when its last subscriber drops.
pub struct RemoteSubscription {
    key: String,
    id: u64,
}

impl Drop for RemoteSubscription {
    fn drop(&mut self) {
        let mut map = manager().lock().unwrap();
        if let Some(feed) = map.get_mut(&self.key) {
            feed.subs.retain(|s| s.id != self.id);
            if feed.subs.is_empty() {
                map.remove(&self.key);
            }
        }
    }
}

/// Subscribe the mixer to a phone session's audio at the bus rate.
///
/// Passive and infallible: an unknown or not-yet-connected session registers a
/// feed slot that stays silent until `push_decoded_48k` delivers audio. Returns
/// the ring consumer, channel count (mono), and an RAII handle.
pub fn subscribe_phone(
    session_id: &str,
    expected_rate: u32,
    peak_slots: Arc<Vec<InputSlotShared>>,
    slot_index: usize,
) -> Result<(Consumer<f32>, u16, RemoteSubscription), EngineError> {
    let key = key_for(session_id, expected_rate);
    let ring = RingBuffer::<f32>::new(REMOTE_RING_SIZE);
    let (producer, consumer) = ring.split();
    let id = next_id();

    let mut map = manager().lock().unwrap();
    let feed = map.entry(key.clone()).or_insert_with(|| Feed {
        rate: expected_rate,
        resampler: LinearResampler::new(DECODE_RATE, expected_rate, PHONE_CHANNELS as usize),
        subs: Vec::new(),
        scratch: Vec::new(),
        fill_ema: DRIFT_TARGET_FILL,
        push_count: 0,
        trim_ppm: 0,
        ring_glitches: 0,
    });
    feed.subs.push(Subscriber {
        id,
        producer,
        peak: peak_slots,
        index: slot_index,
    });

    Ok((consumer, PHONE_CHANNELS, RemoteSubscription { key, id }))
}

/// Push one block of decoded 48 kHz interleaved-stereo audio for `session_id`.
/// Called from the WebRTC reader task. Fans out to every bus feed for the
/// session, resampling to each bus rate. A no-op when nothing is subscribed
/// (e.g. the phone input has not been routed to any running bus yet).
///
/// `adaptive` enables the per-feed clock-drift compensator (Podcast mode). When
/// false the function behaves exactly as before: the 48 kHz fast path copies
/// straight through and the resampler trim stays 0.
pub fn push_decoded_48k(session_id: &str, samples: &[f32], block_peak: f32, adaptive: bool) {
    let prefix = format!("phone:{session_id}@");
    let ch = PHONE_CHANNELS as usize;
    let mut map = manager().lock().unwrap();
    for (key, feed) in map.iter_mut() {
        if !key.starts_with(&prefix) {
            continue;
        }
        let Feed {
            rate,
            resampler,
            subs,
            scratch,
            fill_ema,
            push_count,
            trim_ppm,
            ring_glitches,
        } = feed;
        scratch.clear();
        // Fixed modes at the bus rate skip the resampler entirely (identical to
        // before). Adaptive always routes through it so the drift trim applies
        // even when the bus is already 48 kHz.
        if *rate == DECODE_RATE && !adaptive {
            scratch.extend_from_slice(samples);
        } else {
            // Resample per interleaved frame so L/R stay paired.
            for frame in samples.chunks_exact(ch) {
                resampler.process_frame(frame, |out| {
                    scratch.extend_from_slice(&out[..ch]);
                });
            }
        }
        let mut overflow = 0u64;
        for (si, sub) in subs.iter_mut().enumerate() {
            for &x in scratch.iter() {
                if sub.producer.push(x).is_err() && si == 0 {
                    overflow += 1;
                }
            }
            store_max(&sub.peak[sub.index].input_peak, block_peak);
        }
        *ring_glitches = ring_glitches.saturating_add(overflow);

        if adaptive {
            // Hold the ring near half-full by nudging the playout rate a few ppm,
            // so phone↔PC clock drift bleeds off smoothly instead of building up
            // to a hard drop. Reads fill from the first subscriber's ring.
            if let Some(first) = subs.first() {
                let frac = first.producer.len() as f32 / REMOTE_RING_SIZE as f32;
                *fill_ema = *fill_ema * 0.99 + frac * 0.01;
                *push_count += 1;
                if *push_count >= DRIFT_CADENCE {
                    *push_count = 0;
                    let error = *fill_ema - DRIFT_TARGET_FILL;
                    if error.abs() >= DRIFT_DEADBAND {
                        // Too full → larger step → fewer output samples → fill falls.
                        *trim_ppm = (*trim_ppm + error.signum() as i32 * DRIFT_STEP_PPM)
                            .clamp(-MAX_TRIM_PPM, MAX_TRIM_PPM);
                        resampler.set_trim_ppm(*trim_ppm);
                    }
                }
            }
        } else if *trim_ppm != 0 {
            // Leaving Adaptive: restore the exact base ratio for fixed modes.
            *trim_ppm = 0;
            *fill_ema = DRIFT_TARGET_FILL;
            resampler.set_trim_ppm(0);
        }
    }
}

/// Snapshot a session's drift health: (ring_glitches, current trim ppm) of the
/// first matching feed. None when the session has no feed. Observability.
pub fn drift_stats(session_id: &str) -> Option<(u64, i32)> {
    let prefix = format!("phone:{session_id}@");
    let map = manager().lock().unwrap();
    map.iter()
        .find(|(k, _)| k.starts_with(&prefix))
        .map(|(_, f)| (f.ring_glitches, f.trim_ppm))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU32};

    fn slots(n: usize) -> Arc<Vec<InputSlotShared>> {
        Arc::new(
            (0..n)
                .map(|_| InputSlotShared {
                    gain: AtomicU32::new(1.0f32.to_bits()),
                    muted: AtomicBool::new(false),
                    input_peak: AtomicU32::new(0),
                })
                .collect(),
        )
    }

    #[test]
    fn subscribe_then_push_delivers_samples_at_matched_rate() {
        let peak = slots(1);
        let (mut consumer, ch, _sub) = subscribe_phone("sess-a", 48_000, peak, 0).unwrap();
        assert_eq!(ch, PHONE_CHANNELS);
        push_decoded_48k("sess-a", &[0.25, -0.5, 0.75], 0.75, false);
        assert_eq!(consumer.pop(), Some(0.25));
        assert_eq!(consumer.pop(), Some(-0.5));
        assert_eq!(consumer.pop(), Some(0.75));
    }

    #[test]
    fn push_to_unknown_session_is_silent_noop() {
        // No subscriber for this session: must not panic, nothing to deliver.
        push_decoded_48k("ghost", &[1.0, 1.0], 1.0, false);
    }

    #[test]
    fn non_adaptive_push_leaves_trim_zero() {
        let (mut c, _, _sub) = subscribe_phone("sess-fix", 48_000, slots(1), 0).unwrap();
        for _ in 0..200 {
            push_decoded_48k("sess-fix", &[0.0; 2], 0.0, false);
            while c.pop().is_some() {} // drain so we don't overflow
        }
        let (_g, trim) = drift_stats("sess-fix").unwrap();
        assert_eq!(trim, 0, "fixed modes must never apply drift trim");
    }

    #[test]
    fn adaptive_drift_trims_toward_target_when_ring_overfills() {
        // Never drain the ring: push far more than it holds so it saturates; the
        // integrator should then trim playout faster (positive) to bleed it back.
        let (_c, _, _sub) = subscribe_phone("sess-drift", 48_000, slots(1), 0).unwrap();
        for _ in 0..6000 {
            push_decoded_48k("sess-drift", &[0.2; 2], 0.2, true);
        }
        let (glitches, trim) = drift_stats("sess-drift").unwrap();
        assert!(trim > 0, "over-full ring should trim playout faster (trim>0), got {trim}");
        assert!(trim <= MAX_TRIM_PPM, "trim must stay clamped");
        assert!(glitches > 0, "a never-drained ring should record overflow drops");
    }

    #[test]
    fn dropping_last_subscription_frees_the_feed() {
        let (_c, _ch, sub) = subscribe_phone("sess-b", 48_000, slots(1), 0).unwrap();
        assert!(manager().lock().unwrap().contains_key("phone:sess-b@48000"));
        drop(sub);
        assert!(!manager().lock().unwrap().contains_key("phone:sess-b@48000"));
    }

    #[test]
    fn two_subscribers_same_rate_share_one_feed_and_both_receive() {
        let (mut c1, _, _s1) = subscribe_phone("sess-c", 48_000, slots(1), 0).unwrap();
        let (mut c2, _, _s2) = subscribe_phone("sess-c", 48_000, slots(1), 0).unwrap();
        push_decoded_48k("sess-c", &[0.1], 0.1, false);
        assert_eq!(c1.pop(), Some(0.1));
        assert_eq!(c2.pop(), Some(0.1));
    }
}
