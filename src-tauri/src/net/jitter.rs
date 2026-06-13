//! Reorder + jitter buffer for the phone's Opus RTP stream (#43).
//!
//! The WebRTC reader drops each arriving RTP payload in via [`JitterBuffer::insert`]
//! (out of order is fine). A separate feeder task calls [`JitterBuffer::tick`] once
//! per frame-time (~20 ms) and gets back exactly one action: play a frame, conceal
//! a gap with Opus PLC, or idle while priming/underrunning. Decoupling arrival from
//! playout this way absorbs network jitter; the depth we prime/maintain trades
//! latency against dropout resilience and is set by [`LatencyMode`].
//!
//! Sequence numbers are 16-bit and wrap; we extend them to a monotonic 64-bit key
//! so the `BTreeMap` orders correctly across the wrap and late/duplicate frames are
//! dropped cleanly.

use std::collections::BTreeMap;

/// User-facing latency/robustness trade. Larger target depth = more buffering =
/// more delay but fewer dropouts on jittery WiFi.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LatencyMode {
    Fastest,
    Balanced,
    Stable,
}

impl LatencyMode {
    pub fn from_u8(v: u8) -> Self {
        match v {
            0 => LatencyMode::Fastest,
            2 => LatencyMode::Stable,
            _ => LatencyMode::Balanced,
        }
    }

    pub fn as_u8(self) -> u8 {
        match self {
            LatencyMode::Fastest => 0,
            LatencyMode::Balanced => 1,
            LatencyMode::Stable => 2,
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "fastest" => Some(LatencyMode::Fastest),
            "balanced" => Some(LatencyMode::Balanced),
            "stable" => Some(LatencyMode::Stable),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            LatencyMode::Fastest => "fastest",
            LatencyMode::Balanced => "balanced",
            LatencyMode::Stable => "stable",
        }
    }

    /// Frames (~20 ms each) to buffer before and during playout.
    pub fn target_frames(self) -> usize {
        match self {
            LatencyMode::Fastest => 1,
            LatencyMode::Balanced => 3,
            LatencyMode::Stable => 6,
        }
    }
}

/// What the feeder should do for one frame-time.
#[derive(Debug, PartialEq, Eq)]
pub enum Tick {
    /// Decode and play this Opus payload.
    Decode(Vec<u8>),
    /// Expected frame is missing but later audio is queued: run Opus PLC.
    Conceal,
    /// Priming or underrunning: emit nothing this tick (ring plays silence).
    Idle,
}

/// Frames kept beyond the target before we start dropping the oldest, so normal
/// jitter doesn't trigger drops but sustained over-fill (clock drift) is bounded.
const HYSTERESIS: usize = 2;

/// Start extended sequences well above 0 so the first wrap-backwards can't underflow.
const INITIAL_EXT: u64 = 1 << 32;

pub struct JitterBuffer {
    frames: BTreeMap<u64, Vec<u8>>,
    /// Highest extended sequence seen, for extending the next 16-bit seq.
    highest: Option<u64>,
    /// Next extended sequence to play; set once primed.
    next: Option<u64>,
    started: bool,
    pub plc: u64,
    pub late_drops: u64,
}

impl Default for JitterBuffer {
    fn default() -> Self {
        Self::new()
    }
}

impl JitterBuffer {
    pub fn new() -> Self {
        Self {
            frames: BTreeMap::new(),
            highest: None,
            next: None,
            started: false,
            plc: 0,
            late_drops: 0,
        }
    }

    pub fn depth(&self) -> usize {
        self.frames.len()
    }

    /// Queue one RTP payload by its 16-bit sequence number.
    pub fn insert(&mut self, seq: u16, payload: Vec<u8>) {
        let ext = match self.highest {
            // Seed the low 16 bits with the first seq so later extends align.
            None => INITIAL_EXT + u64::from(seq),
            Some(h) => extend(h, seq),
        };
        self.highest = Some(self.highest.map_or(ext, |h| h.max(ext)));
        // Drop frames we have already played past (late or duplicate).
        if let Some(n) = self.next {
            if ext < n {
                self.late_drops += 1;
                return;
            }
        }
        self.frames.insert(ext, payload);
    }

    /// Advance one frame-time. `target` is the mode's buffered-frame goal.
    pub fn tick(&mut self, target: usize) -> Tick {
        let target = target.max(1);

        // Bound playout latency: sustained over-fill (a burst, or feeder/clock
        // drift) drops the oldest queued frames back toward the target.
        while self.frames.len() > target + HYSTERESIS {
            if let Some((&k, _)) = self.frames.iter().next() {
                self.frames.remove(&k);
                self.late_drops += 1;
                if self.next == Some(k) {
                    self.next = Some(k + 1);
                }
            } else {
                break;
            }
        }

        if !self.started {
            if self.frames.len() < target {
                return Tick::Idle; // still priming
            }
            self.started = true;
            self.next = self.frames.keys().next().copied();
        }

        let Some(n) = self.next else {
            return Tick::Idle;
        };

        if let Some(payload) = self.frames.remove(&n) {
            self.next = Some(n + 1);
            Tick::Decode(payload)
        } else if self.frames.is_empty() {
            // Underrun: nothing buffered. Re-prime so a brief stall doesn't turn
            // into perpetual concealment once packets resume.
            self.started = false;
            Tick::Idle
        } else {
            // Gap with later frames queued: conceal this one and move on.
            self.next = Some(n + 1);
            self.plc += 1;
            Tick::Conceal
        }
    }
}

/// Extend a 16-bit sequence to monotonic 64-bit relative to the highest seen,
/// choosing the nearest value across the wrap (handles reordering within ±32k).
fn extend(highest: u64, seq: u16) -> u64 {
    let low = (highest & 0xffff) as u16;
    let delta = i32::from(seq.wrapping_sub(low) as i16);
    (highest as i64 + i64::from(delta)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(n: u8) -> Vec<u8> {
        vec![n]
    }

    #[test]
    fn modes_round_trip_and_have_increasing_depth() {
        for m in [LatencyMode::Fastest, LatencyMode::Balanced, LatencyMode::Stable] {
            assert_eq!(LatencyMode::from_u8(m.as_u8()), m);
            assert_eq!(LatencyMode::from_str(m.as_str()), Some(m));
        }
        assert!(
            LatencyMode::Fastest.target_frames() < LatencyMode::Balanced.target_frames()
                && LatencyMode::Balanced.target_frames() < LatencyMode::Stable.target_frames()
        );
        // Unknown ints/strings fall back to Balanced / None.
        assert_eq!(LatencyMode::from_u8(99), LatencyMode::Balanced);
        assert_eq!(LatencyMode::from_str("zoom"), None);
    }

    #[test]
    fn primes_to_target_then_plays_in_order() {
        let mut jb = JitterBuffer::new();
        // target 2: idle until two frames buffered.
        jb.insert(10, frame(1));
        assert_eq!(jb.tick(2), Tick::Idle);
        jb.insert(11, frame(2));
        assert_eq!(jb.tick(2), Tick::Decode(frame(1)));
        assert_eq!(jb.tick(2), Tick::Decode(frame(2)));
        // Drained: idle.
        assert_eq!(jb.tick(2), Tick::Idle);
    }

    #[test]
    fn reordered_frame_is_placed_correctly() {
        let mut jb = JitterBuffer::new();
        jb.insert(20, frame(1));
        jb.insert(22, frame(3));
        jb.insert(21, frame(2)); // arrives late but before playout
        assert_eq!(jb.tick(2), Tick::Decode(frame(1)));
        assert_eq!(jb.tick(2), Tick::Decode(frame(2)));
        assert_eq!(jb.tick(2), Tick::Decode(frame(3)));
    }

    #[test]
    fn gap_with_later_frames_conceals() {
        let mut jb = JitterBuffer::new();
        jb.insert(30, frame(1));
        jb.insert(31, frame(2));
        jb.insert(33, frame(4)); // 32 missing
        assert_eq!(jb.tick(2), Tick::Decode(frame(1)));
        assert_eq!(jb.tick(2), Tick::Decode(frame(2)));
        assert_eq!(jb.tick(2), Tick::Conceal); // 32 lost -> PLC
        assert_eq!(jb.tick(2), Tick::Decode(frame(4)));
        assert_eq!(jb.plc, 1);
    }

    #[test]
    fn sequence_wraparound_orders_correctly() {
        let mut jb = JitterBuffer::new();
        jb.insert(65534, frame(1));
        jb.insert(65535, frame(2));
        jb.insert(0, frame(3));
        jb.insert(1, frame(4));
        assert_eq!(jb.tick(2), Tick::Decode(frame(1)));
        assert_eq!(jb.tick(2), Tick::Decode(frame(2)));
        assert_eq!(jb.tick(2), Tick::Decode(frame(3)));
        assert_eq!(jb.tick(2), Tick::Decode(frame(4)));
    }

    #[test]
    fn overfill_drops_oldest_to_bound_latency() {
        let mut jb = JitterBuffer::new();
        // target 1 + HYSTERESIS 2 = keep 3; insert 6 -> 3 dropped.
        for i in 0..6u16 {
            jb.insert(100 + i, frame(i as u8));
        }
        let _ = jb.tick(1);
        assert!(jb.depth() <= 1 + HYSTERESIS);
        assert!(jb.late_drops >= 3);
    }

    #[test]
    fn late_frame_after_playout_is_dropped() {
        let mut jb = JitterBuffer::new();
        jb.insert(200, frame(1));
        jb.insert(201, frame(2));
        assert_eq!(jb.tick(1), Tick::Decode(frame(1)));
        // 200 arrives again, already played -> dropped, not replayed.
        jb.insert(200, frame(9));
        assert_eq!(jb.late_drops, 1);
        assert_eq!(jb.tick(1), Tick::Decode(frame(2)));
    }
}
