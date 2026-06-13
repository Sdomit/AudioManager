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
use crate::audio::resampler::LinearResampler;

/// The phone mic is mono; the mixer's `(1 -> 2)` arm duplicates it to stereo
/// buses, so we declare a single channel and never fake-stereo.
pub const PHONE_CHANNELS: u16 = 1;

/// ~85 ms at 48 kHz, matching the other input rings.
const REMOTE_RING_SIZE: usize = 16384;

/// WebRTC Opus is always decoded at 48 kHz; feeds resample from this to the bus rate.
const DECODE_RATE: u32 = 48_000;

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
        resampler: LinearResampler::new(DECODE_RATE, expected_rate, 1),
        subs: Vec::new(),
        scratch: Vec::new(),
    });
    feed.subs.push(Subscriber {
        id,
        producer,
        peak: peak_slots,
        index: slot_index,
    });

    Ok((consumer, PHONE_CHANNELS, RemoteSubscription { key, id }))
}

/// Push one block of decoded 48 kHz mono audio for `session_id`. Called from the
/// WebRTC reader task. Fans out to every bus feed for the session, resampling to
/// each bus rate. A no-op when nothing is subscribed (e.g. the phone input has
/// not been routed to any running bus yet).
pub fn push_decoded_48k(session_id: &str, samples: &[f32], block_peak: f32) {
    let prefix = format!("phone:{session_id}@");
    let mut map = manager().lock().unwrap();
    for (key, feed) in map.iter_mut() {
        if !key.starts_with(&prefix) {
            continue;
        }
        let Feed { rate, resampler, subs, scratch } = feed;
        scratch.clear();
        if *rate == DECODE_RATE {
            scratch.extend_from_slice(samples);
        } else {
            for &s in samples {
                resampler.process_frame(&[s], |out| scratch.push(out[0]));
            }
        }
        for sub in subs.iter_mut() {
            for &x in scratch.iter() {
                let _ = sub.producer.push(x);
            }
            store_max(&sub.peak[sub.index].input_peak, block_peak);
        }
    }
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
        push_decoded_48k("sess-a", &[0.25, -0.5, 0.75], 0.75);
        assert_eq!(consumer.pop(), Some(0.25));
        assert_eq!(consumer.pop(), Some(-0.5));
        assert_eq!(consumer.pop(), Some(0.75));
    }

    #[test]
    fn push_to_unknown_session_is_silent_noop() {
        // No subscriber for this session: must not panic, nothing to deliver.
        push_decoded_48k("ghost", &[1.0, 1.0], 1.0);
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
        push_decoded_48k("sess-c", &[0.1], 0.1);
        assert_eq!(c1.pop(), Some(0.1));
        assert_eq!(c2.pop(), Some(0.1));
    }
}
