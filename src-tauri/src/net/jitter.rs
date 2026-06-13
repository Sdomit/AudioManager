//! Reorder + jitter buffer for the phone's Opus RTP stream (#43).
//!
//! The WebRTC reader drops each arriving RTP payload in via [`JitterBuffer::insert`]
//! (out of order is fine), then drains with [`JitterBuffer::drain_one`] until it
//! returns `None`. Draining releases at most one frame per call and holds a
//! `target`-frame reorder window, so it emits at the *arrival* rate — the mixer's
//! ring (drained at 48 kHz) is the actual playout clock. There is deliberately no
//! separate wall-clock feeder: a second clock drifting against the audio clock is
//! exactly what produces runaway concealment.
//!
//! The held window trades latency against reorder/loss tolerance and is set by
//! [`LatencyMode`]. Sequence numbers are 16-bit and wrap; we extend them to a
//! monotonic 64-bit key so the `BTreeMap` orders correctly across the wrap and
//! late/duplicate frames are dropped cleanly.

use std::collections::BTreeMap;

/// User-facing latency/robustness trade. Larger target depth = more buffering =
/// more delay but fewer dropouts on jittery WiFi. `Adaptive` ("Podcast
/// (Adaptive)") is the opt-in robust mode: the buffer depth floats with the
/// network, Opus in-band FEC recovers losses, and clock drift is compensated.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LatencyMode {
    Fastest,
    Balanced,
    Stable,
    Adaptive,
}

impl LatencyMode {
    pub fn from_u8(v: u8) -> Self {
        match v {
            0 => LatencyMode::Fastest,
            2 => LatencyMode::Stable,
            3 => LatencyMode::Adaptive,
            _ => LatencyMode::Balanced,
        }
    }

    pub fn as_u8(self) -> u8 {
        match self {
            LatencyMode::Fastest => 0,
            LatencyMode::Balanced => 1,
            LatencyMode::Stable => 2,
            LatencyMode::Adaptive => 3,
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "fastest" => Some(LatencyMode::Fastest),
            "balanced" => Some(LatencyMode::Balanced),
            "stable" => Some(LatencyMode::Stable),
            "adaptive" => Some(LatencyMode::Adaptive),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            LatencyMode::Fastest => "fastest",
            LatencyMode::Balanced => "balanced",
            LatencyMode::Stable => "stable",
            LatencyMode::Adaptive => "adaptive",
        }
    }

    /// Reorder/jitter window held before release, in ~20 ms frames. The mixer
    /// ring adds only a few ms on top, so these set the dominant added latency:
    /// Fastest ~20 ms, Balanced ~40 ms, Stable ~100 ms. Adaptive's value here is
    /// only a static fallback — its live depth comes from the buffer's controller.
    pub fn target_frames(self) -> usize {
        match self {
            LatencyMode::Fastest => 1,
            LatencyMode::Balanced => 2,
            LatencyMode::Stable => 5,
            LatencyMode::Adaptive => ADAPT_FLOOR,
        }
    }
}

/// Adaptive-depth bounds and ballistics (Adaptive mode only).
const ADAPT_FLOOR: usize = 2;
const ADAPT_CEIL: usize = 12;
/// Frames to grow the window per loss event (fast attack).
const ADAPT_BUMP: usize = 2;
/// Clean releases before shrinking the window by one (~5 s at 50 fps; slow release).
const ADAPT_SHRINK_AFTER: u32 = 250;

/// One released playout step.
#[derive(Debug, PartialEq, Eq)]
pub enum Tick {
    /// Decode and play this Opus payload.
    Decode(Vec<u8>),
    /// A frame was lost (gap); run Opus PLC for one frame to bridge it.
    Conceal,
    /// Adaptive only: the lost frame's successor is buffered, so decode it with
    /// Opus in-band FEC to *reconstruct* the lost frame instead of concealing.
    /// The successor itself is decoded normally on the next drain.
    RecoverFec { next_payload: Vec<u8> },
}

/// Start extended sequences well above 0 so the first wrap-backwards can't underflow.
const INITIAL_EXT: u64 = 1 << 32;

pub struct JitterBuffer {
    frames: BTreeMap<u64, Vec<u8>>,
    /// Highest extended sequence seen, for extending the next 16-bit seq.
    highest: Option<u64>,
    /// Next extended sequence to play; set once the window first fills.
    next: Option<u64>,
    started: bool,
    pub plc: u64,
    pub late_drops: u64,
    pub reorder: u64,
    // ── Adaptive controller state (only read/written by drain_one_adaptive) ──
    /// Live reorder/jitter window for Adaptive mode; floats in [FLOOR, CEIL].
    adaptive_target: usize,
    /// Consecutive clean releases since the last loss (drives slow shrink).
    clean_run: u32,
    /// Frames reconstructed via Opus in-band FEC.
    pub fec_recovered: u64,
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
            reorder: 0,
            adaptive_target: ADAPT_FLOOR,
            clean_run: 0,
            fec_recovered: 0,
        }
    }

    pub fn depth(&self) -> usize {
        self.frames.len()
    }

    /// Current Adaptive-mode window depth (frames). Observability / Phase 3.
    #[allow(dead_code)] // surfaced in Phase 3
    pub fn adaptive_target(&self) -> usize {
        self.adaptive_target
    }

    /// Queue one RTP payload by its 16-bit sequence number.
    pub fn insert(&mut self, seq: u16, payload: Vec<u8>) {
        let ext = match self.highest {
            // Seed the low 16 bits with the first seq so later extends align.
            None => INITIAL_EXT + u64::from(seq),
            Some(h) => extend(h, seq),
        };
        // Arrived below the highest seen but still ahead of playout = reordered.
        if self.highest.is_some_and(|h| ext < h) {
            self.reorder += 1;
        }
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

    /// Release at most one frame for playout, holding a `target`-frame reorder
    /// window. Call in a loop after each `insert` until it returns `None`:
    /// in steady state one frame in releases one frame out, so output is paced
    /// by arrivals (the ring/mixer is the real playout clock). Returns `None`
    /// while the window is still filling or has drained back to the hold depth.
    pub fn drain_one(&mut self, target: usize) -> Option<Tick> {
        // Hold `target` frames as reorder/jitter slack; only release the surplus.
        if self.frames.len() <= target {
            return None;
        }
        if !self.started {
            self.started = true;
            self.next = self.frames.keys().next().copied();
        }
        let n = self.next?;
        if let Some(payload) = self.frames.remove(&n) {
            self.next = Some(n + 1);
            Some(Tick::Decode(payload))
        } else {
            // The expected frame never arrived though newer ones are buffered
            // beyond the window: it is lost. Skip to the oldest buffered frame
            // and count a single concealment for the whole gap.
            if let Some(&oldest) = self.frames.keys().next() {
                self.next = Some(oldest);
            }
            self.plc += 1;
            Some(Tick::Conceal)
        }
    }

    /// Adaptive-mode drain: same reorder/hold logic as [`drain_one`] but the hold
    /// depth floats (`adaptive_target`), and on a single-frame gap whose successor
    /// is buffered it emits [`Tick::RecoverFec`] so the caller can reconstruct the
    /// lost frame from the next packet's in-band FEC instead of concealing.
    ///
    /// Never called for the fixed modes, so their path is untouched.
    pub fn drain_one_adaptive(&mut self) -> Option<Tick> {
        if self.frames.len() <= self.adaptive_target {
            return None;
        }
        if !self.started {
            self.started = true;
            self.next = self.frames.keys().next().copied();
        }
        let n = self.next?;
        if let Some(payload) = self.frames.remove(&n) {
            self.note_clean();
            self.next = Some(n + 1);
            return Some(Tick::Decode(payload));
        }
        // Gap at `n`. Look at the oldest buffered frame.
        let oldest = *self.frames.keys().next()?;
        self.note_loss();
        if oldest == n + 1 {
            // The immediately-next frame is present: reconstruct `n` from its FEC.
            // Leave it buffered; `next = n+1` so the following drain decodes it
            // normally. Counts as a recovery, not a concealment.
            self.next = Some(n + 1);
            self.fec_recovered += 1;
            let next_payload = self.frames.get(&(n + 1)).cloned()?;
            Some(Tick::RecoverFec { next_payload })
        } else {
            // Multi-frame gap (or N+1 also lost): skip the gap, conceal once.
            self.next = Some(oldest);
            self.plc += 1;
            Some(Tick::Conceal)
        }
    }

    /// A clean release: ratchet the adaptive window down on a sustained-clean link.
    fn note_clean(&mut self) {
        self.clean_run += 1;
        if self.clean_run >= ADAPT_SHRINK_AFTER {
            self.adaptive_target = self.adaptive_target.saturating_sub(1).max(ADAPT_FLOOR);
            self.clean_run = 0;
        }
    }

    /// A loss event: grow the window fast so the next loss has FEC headroom.
    fn note_loss(&mut self) {
        self.adaptive_target = (self.adaptive_target + ADAPT_BUMP).min(ADAPT_CEIL);
        self.clean_run = 0;
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
        for m in [
            LatencyMode::Fastest,
            LatencyMode::Balanced,
            LatencyMode::Stable,
            LatencyMode::Adaptive,
        ] {
            assert_eq!(LatencyMode::from_u8(m.as_u8()), m);
            assert_eq!(LatencyMode::from_str(m.as_str()), Some(m));
        }
        assert_eq!(LatencyMode::from_u8(3), LatencyMode::Adaptive);
        assert_eq!(LatencyMode::Adaptive.as_str(), "adaptive");
        assert!(
            LatencyMode::Fastest.target_frames() < LatencyMode::Balanced.target_frames()
                && LatencyMode::Balanced.target_frames() < LatencyMode::Stable.target_frames()
        );
        // Unknown ints/strings fall back to Balanced / None.
        assert_eq!(LatencyMode::from_u8(99), LatencyMode::Balanced);
        assert_eq!(LatencyMode::from_str("zoom"), None);
    }

    /// Drain everything currently releasable at `target`.
    fn drain(jb: &mut JitterBuffer, target: usize) -> Vec<Tick> {
        let mut out = Vec::new();
        while let Some(t) = jb.drain_one(target) {
            out.push(t);
        }
        out
    }

    #[test]
    fn holds_target_window_then_releases_surplus_in_order() {
        let mut jb = JitterBuffer::new();
        // target 2: holds 2, releases only the surplus.
        jb.insert(10, frame(1));
        jb.insert(11, frame(2));
        assert_eq!(drain(&mut jb, 2), vec![]); // window not exceeded yet
        jb.insert(12, frame(3));
        assert_eq!(drain(&mut jb, 2), vec![Tick::Decode(frame(1))]); // 1 surplus
        jb.insert(13, frame(4));
        assert_eq!(drain(&mut jb, 2), vec![Tick::Decode(frame(2))]);
    }

    #[test]
    fn reordered_frame_is_placed_correctly() {
        let mut jb = JitterBuffer::new();
        jb.insert(20, frame(1));
        jb.insert(22, frame(3));
        jb.insert(21, frame(2)); // arrives late but still within the window
        jb.insert(23, frame(4));
        // target 0: release everything, in sequence order despite arrival order.
        assert_eq!(
            drain(&mut jb, 0),
            vec![
                Tick::Decode(frame(1)),
                Tick::Decode(frame(2)),
                Tick::Decode(frame(3)),
                Tick::Decode(frame(4)),
            ]
        );
    }

    #[test]
    fn gap_conceals_once_then_resumes() {
        let mut jb = JitterBuffer::new();
        jb.insert(30, frame(1));
        jb.insert(31, frame(2));
        jb.insert(33, frame(4)); // 32 lost
        let out = drain(&mut jb, 0);
        assert_eq!(
            out,
            vec![
                Tick::Decode(frame(1)),
                Tick::Decode(frame(2)),
                Tick::Conceal, // 32 missing -> one PLC
                Tick::Decode(frame(4)),
            ]
        );
        assert_eq!(jb.plc, 1);
    }

    #[test]
    fn sequence_wraparound_orders_correctly() {
        let mut jb = JitterBuffer::new();
        jb.insert(65534, frame(1));
        jb.insert(65535, frame(2));
        jb.insert(0, frame(3));
        jb.insert(1, frame(4));
        assert_eq!(
            drain(&mut jb, 0),
            vec![
                Tick::Decode(frame(1)),
                Tick::Decode(frame(2)),
                Tick::Decode(frame(3)),
                Tick::Decode(frame(4)),
            ]
        );
    }

    #[test]
    fn steady_state_is_one_in_one_out() {
        let mut jb = JitterBuffer::new();
        // Prime the window (target 3).
        for i in 0..4u16 {
            jb.insert(100 + i, frame(i as u8));
        }
        let primed = drain(&mut jb, 3);
        assert_eq!(primed.len(), 1); // only the surplus over the window
        assert_eq!(jb.depth(), 3);
        // Each further arrival releases exactly one frame; depth stays at target.
        for i in 4..20u16 {
            jb.insert(100 + i, frame(i as u8));
            assert_eq!(drain(&mut jb, 3).len(), 1);
            assert_eq!(jb.depth(), 3);
        }
        assert_eq!(jb.plc, 0); // no loss -> no concealment
    }

    #[test]
    fn late_frame_after_playout_is_dropped() {
        let mut jb = JitterBuffer::new();
        jb.insert(200, frame(1));
        jb.insert(201, frame(2));
        assert_eq!(drain(&mut jb, 0), vec![Tick::Decode(frame(1)), Tick::Decode(frame(2))]);
        // 200 arrives again, already played -> dropped, not replayed.
        jb.insert(200, frame(9));
        assert_eq!(jb.late_drops, 1);
        assert_eq!(drain(&mut jb, 0), vec![]);
    }

    // ── Adaptive mode (Podcast) ──

    fn drain_adaptive(jb: &mut JitterBuffer) -> Vec<Tick> {
        let mut out = Vec::new();
        while let Some(t) = jb.drain_one_adaptive() {
            out.push(t);
        }
        out
    }

    #[test]
    fn adaptive_recovers_lost_frame_via_fec_when_successor_present() {
        let mut jb = JitterBuffer::new();
        // 12 lost; 13 (its successor) is buffered, so FEC can reconstruct 12.
        for s in [10u16, 11, 13, 14, 15] {
            jb.insert(s, frame(s as u8));
        }
        // The loss at 12 grows the window, so this pass stops after recovering it.
        let out = drain_adaptive(&mut jb);
        assert_eq!(
            out,
            vec![
                Tick::Decode(frame(10)),
                Tick::Decode(frame(11)),
                Tick::RecoverFec { next_payload: frame(13) }, // reconstruct 12 from 13
            ]
        );
        assert_eq!(jb.fec_recovered, 1);
        assert_eq!(jb.plc, 0);
        // 13 is still buffered; once the window is exceeded again it decodes normally.
        jb.insert(16, frame(16));
        jb.insert(17, frame(17));
        assert_eq!(jb.drain_one_adaptive(), Some(Tick::Decode(frame(13))));
    }

    #[test]
    fn adaptive_conceals_multiframe_gap_no_fec() {
        let mut jb = JitterBuffer::new();
        // 12 AND 13 lost (successor of 12 is absent) → cannot FEC, conceal once.
        for s in [10u16, 11, 14, 15, 16] {
            jb.insert(s, frame(s as u8));
        }
        let out = drain_adaptive(&mut jb);
        assert_eq!(
            out,
            vec![
                Tick::Decode(frame(10)),
                Tick::Decode(frame(11)),
                Tick::Conceal,
            ]
        );
        assert_eq!(jb.fec_recovered, 0);
        assert_eq!(jb.plc, 1);
    }

    #[test]
    fn fixed_mode_drain_never_recovers_fec() {
        let mut jb = JitterBuffer::new();
        for s in [10u16, 11, 13, 14, 15] {
            jb.insert(s, frame(s as u8));
        }
        let out = drain(&mut jb, 2);
        assert!(out.iter().all(|t| !matches!(t, Tick::RecoverFec { .. })));
        assert!(out.iter().any(|t| *t == Tick::Conceal)); // it conceals the gap instead
    }

    #[test]
    fn adaptive_depth_grows_on_loss_and_shrinks_when_clean() {
        let mut jb = JitterBuffer::new();
        assert_eq!(jb.adaptive_target(), ADAPT_FLOOR);
        for _ in 0..10 {
            jb.note_loss();
        }
        assert_eq!(jb.adaptive_target(), ADAPT_CEIL); // +2 each, capped
        for _ in 0..(ADAPT_SHRINK_AFTER as usize * (ADAPT_CEIL - ADAPT_FLOOR + 1)) {
            jb.note_clean();
        }
        assert_eq!(jb.adaptive_target(), ADAPT_FLOOR); // bleeds back to floor
    }
}
