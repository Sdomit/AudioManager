//! Lock-free live DSP parameter delivery (issue #32, step 2b core).
//!
//! The audio callback owns concrete effect slots ([`InputDspSlots`] /
//! [`BusDspSlots`]); the IPC thread owns the matching shared atomic block
//! ([`InputDspShared`] / [`BusDspShared`]). Parameters cross the realtime
//! boundary through a **seqlock**, so the callback never observes a half-written
//! coefficient set, never locks, never allocates, and never spins:
//!
//! - Writer (IPC thread, single writer): bump `generation` to odd (publish in
//!   flight), write the field atomics, bump to even (done). A `Release` fence
//!   brackets the field writes.
//! - Reader (callback, once per block): read `generation`; if odd (write in
//!   flight) or unchanged since last applied, do nothing and keep the current
//!   effects. Otherwise copy the fields into a stack snapshot, re-read
//!   `generation`, and apply the snapshot only if it is unchanged — a mismatch
//!   means a write raced, so it keeps the current effects and retries next block.
//!
//! Coefficients (biquad sets, gate/comp/limiter envelope coefficients) are
//! precomputed on the IPC thread via the effect modules' `*::compute` helpers,
//! so the callback runs no `sin`/`cos`/`exp`/`powf`.

use std::sync::atomic::{fence, AtomicBool, AtomicU32, Ordering};

use super::config::{
    BandKind, BusDspConfig, DenoiseBackend, DspConfig, DspStage, EqBand, MAX_EQ_BANDS,
};

/// Pack a 6-stage order (each stage 0..5) into 3-bit fields of a u32 so the
/// seqlock can deliver it lock-free. Input must be a 6-element permutation
/// (guaranteed by `DspConfig::clamp` → `normalize_order`).
fn pack_order(order: &[DspStage]) -> u32 {
    let mut v = 0u32;
    for (i, &s) in order.iter().take(6).enumerate() {
        v |= ((s as u32) & 0x7) << (i * 3);
    }
    v
}

fn stage_from_code(c: u32) -> DspStage {
    match c {
        0 => DspStage::Denoise,
        1 => DspStage::Hpf,
        2 => DspStage::Gate,
        3 => DspStage::Eq,
        4 => DspStage::Comp,
        _ => DspStage::Limiter,
    }
}

fn unpack_order(v: u32) -> [DspStage; 6] {
    let mut out = [DspStage::Denoise; 6];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = stage_from_code((v >> (i * 3)) & 0x7);
    }
    out
}
use super::denoise::Denoiser;
use super::dynamics::{Compressor, CompressorCoeffs, Limiter, LimiterCoeffs};
use super::filter::{
    high_pass_coeffs, high_pass_coeffs_q, high_shelf_coeffs, low_pass_coeffs, low_shelf_coeffs,
    notch_coeffs, peaking_coeffs, BiquadFilter,
};
use super::gate::{GateCoeffs, NoiseGate};
use super::DspEffect;

const RELAXED: Ordering = Ordering::Relaxed;

/// Precompute one EQ band's biquad coefficients for its selected shape. Runs on
/// the IPC thread only (the realtime path applies the resulting `[f32; 5]`). The
/// frequency is Nyquist-clamped here so every shape stays stable near Nyquist.
#[inline]
fn eq_band_coeffs(b: &EqBand, sr: f32) -> [f32; 5] {
    let f = nyquist_clamp(b.freq_hz, sr);
    match b.kind {
        BandKind::Peaking => peaking_coeffs(f, b.q, b.gain_db, sr),
        BandKind::LowShelf => low_shelf_coeffs(f, b.gain_db, sr),
        BandKind::HighShelf => high_shelf_coeffs(f, b.gain_db, sr),
        BandKind::LowPass => low_pass_coeffs(f, b.q, sr),
        BandKind::HighPass => high_pass_coeffs_q(f, b.q, sr),
        BandKind::Notch => notch_coeffs(f, b.q, sr),
    }
}

/// Clamp a filter frequency below Nyquist for the active sample rate. Biquad
/// coefficients degrade and can go unstable as the cutoff approaches Nyquist, so
/// cap at `0.49 * sample_rate` (the config layer already enforces the 10 Hz floor
/// and 20 kHz ceiling).
#[inline]
fn nyquist_clamp(freq_hz: f32, sample_rate: f32) -> f32 {
    freq_hz.clamp(10.0, sample_rate * 0.49)
}

/// `f32` stored in an `AtomicU32` via bit-cast. All field accesses are `Relaxed`;
/// ordering is provided by the seqlock generation fences.
struct AtomicF32(AtomicU32);

impl AtomicF32 {
    fn new(v: f32) -> Self {
        Self(AtomicU32::new(v.to_bits()))
    }
    #[inline]
    fn load(&self) -> f32 {
        f32::from_bits(self.0.load(RELAXED))
    }
    #[inline]
    fn store(&self, v: f32) {
        self.0.store(v.to_bits(), RELAXED);
    }
}

// ── Per-effect atomic blocks ───────────────────────────────────────────────────

struct AtomicBiquad {
    enabled: AtomicBool,
    coeffs: [AtomicF32; 5],
}

impl AtomicBiquad {
    fn new() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            coeffs: std::array::from_fn(|_| AtomicF32::new(0.0)),
        }
    }
    fn store(&self, enabled: bool, coeffs: [f32; 5]) {
        self.enabled.store(enabled, RELAXED);
        // Finiteness guard (IPC side, off the RT path): a NaN/Inf coefficient
        // published here would propagate through the biquad's `y1/y2` recursion
        // and permanently wedge the channel. Sanitize a non-finite set to a
        // passthrough biquad `[b0=1, b1=0, b2=0, a1=0, a2=0]` (y = x).
        let coeffs = if coeffs.iter().all(|c| c.is_finite()) {
            coeffs
        } else {
            [1.0, 0.0, 0.0, 0.0, 0.0]
        };
        for (a, v) in self.coeffs.iter().zip(coeffs) {
            a.store(v);
        }
    }
    fn load(&self) -> (bool, [f32; 5]) {
        (
            self.enabled.load(RELAXED),
            std::array::from_fn(|i| self.coeffs[i].load()),
        )
    }
}

struct AtomicGate {
    enabled: AtomicBool,
    threshold_lin: AtomicF32,
    attack_coeff: AtomicF32,
    release_coeff: AtomicF32,
    hold_samples: AtomicU32,
}

impl AtomicGate {
    fn new() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            threshold_lin: AtomicF32::new(0.0),
            attack_coeff: AtomicF32::new(0.0),
            release_coeff: AtomicF32::new(0.0),
            hold_samples: AtomicU32::new(0),
        }
    }
    fn store(&self, enabled: bool, c: GateCoeffs) {
        self.enabled.store(enabled, RELAXED);
        self.threshold_lin.store(c.threshold_lin);
        self.attack_coeff.store(c.attack_coeff);
        self.release_coeff.store(c.release_coeff);
        self.hold_samples.store(c.hold_samples, RELAXED);
    }
    fn load(&self) -> (bool, GateCoeffs) {
        (
            self.enabled.load(RELAXED),
            GateCoeffs {
                threshold_lin: self.threshold_lin.load(),
                attack_coeff: self.attack_coeff.load(),
                release_coeff: self.release_coeff.load(),
                hold_samples: self.hold_samples.load(RELAXED),
            },
        )
    }
}

struct AtomicComp {
    enabled: AtomicBool,
    threshold_db: AtomicF32,
    ratio: AtomicF32,
    makeup_lin: AtomicF32,
    env_attack: AtomicF32,
    env_release: AtomicF32,
    gain_attack: AtomicF32,
    gain_release: AtomicF32,
}

impl AtomicComp {
    fn new() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            threshold_db: AtomicF32::new(0.0),
            ratio: AtomicF32::new(1.0),
            makeup_lin: AtomicF32::new(1.0),
            env_attack: AtomicF32::new(0.0),
            env_release: AtomicF32::new(0.0),
            gain_attack: AtomicF32::new(0.0),
            gain_release: AtomicF32::new(0.0),
        }
    }
    fn store(&self, enabled: bool, c: CompressorCoeffs) {
        self.enabled.store(enabled, RELAXED);
        self.threshold_db.store(c.threshold_db);
        self.ratio.store(c.ratio);
        self.makeup_lin.store(c.makeup_lin);
        self.env_attack.store(c.env_attack);
        self.env_release.store(c.env_release);
        self.gain_attack.store(c.gain_attack);
        self.gain_release.store(c.gain_release);
    }
    fn load(&self) -> (bool, CompressorCoeffs) {
        (
            self.enabled.load(RELAXED),
            CompressorCoeffs {
                threshold_db: self.threshold_db.load(),
                ratio: self.ratio.load(),
                makeup_lin: self.makeup_lin.load(),
                env_attack: self.env_attack.load(),
                env_release: self.env_release.load(),
                gain_attack: self.gain_attack.load(),
                gain_release: self.gain_release.load(),
            },
        )
    }
}

struct AtomicLimiter {
    enabled: AtomicBool,
    threshold_lin: AtomicF32,
    attack: AtomicF32,
    release: AtomicF32,
}

impl AtomicLimiter {
    fn new() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            threshold_lin: AtomicF32::new(1.0),
            attack: AtomicF32::new(0.0),
            release: AtomicF32::new(0.0),
        }
    }
    fn store(&self, enabled: bool, c: LimiterCoeffs) {
        self.enabled.store(enabled, RELAXED);
        self.threshold_lin.store(c.threshold_lin);
        self.attack.store(c.attack);
        self.release.store(c.release);
    }
    fn load(&self) -> (bool, LimiterCoeffs) {
        (
            self.enabled.load(RELAXED),
            LimiterCoeffs {
                threshold_lin: self.threshold_lin.load(),
                attack: self.attack.load(),
                release: self.release.load(),
            },
        )
    }
}

// ── Snapshots ──────────────────────────────────────────────────────────────────

/// Stack copy of one input's full effect parameter set, read atomically out of
/// [`InputDspShared`]. Public so tests can assert internal consistency.
pub struct InputDspSnapshot {
    pub denoise_enabled: bool,
    pub denoise_use_dfn: bool,
    pub order: [DspStage; 6],
    pub hpf: (bool, [f32; 5]),
    pub eq: [(bool, [f32; 5]); MAX_EQ_BANDS],
    pub gate: (bool, GateCoeffs),
    pub comp: (bool, CompressorCoeffs),
    pub limiter: (bool, LimiterCoeffs),
}

/// Stack copy of one bus's effect parameter set.
pub struct BusDspSnapshot {
    pub eq: [(bool, [f32; 5]); MAX_EQ_BANDS],
    pub limiter: (bool, LimiterCoeffs),
}

// ── Shared atomic blocks (IPC writer side) ─────────────────────────────────────

/// Shared per-input DSP parameter block. The IPC thread publishes into it; the
/// audio callback reloads from it. One per active input.
pub struct InputDspShared {
    generation: AtomicU32,
    denoise_enabled: AtomicBool,
    denoise_use_dfn: AtomicBool,
    /// Stage order packed into 3-bit fields (see `pack_order`).
    order: AtomicU32,
    hpf: AtomicBiquad,
    eq: [AtomicBiquad; MAX_EQ_BANDS],
    gate: AtomicGate,
    comp: AtomicComp,
    limiter: AtomicLimiter,
}

impl InputDspShared {
    /// Construct seeded from `cfg` at generation 0. `cfg` must already be clamped
    /// (`DspConfig::clamp`); `sample_rate` is the engine rate.
    pub fn new(cfg: &DspConfig, sample_rate: f32) -> Self {
        let s = Self {
            generation: AtomicU32::new(0),
            denoise_enabled: AtomicBool::new(false),
            denoise_use_dfn: AtomicBool::new(false),
            order: AtomicU32::new(pack_order(&DspStage::ALL)),
            hpf: AtomicBiquad::new(),
            eq: std::array::from_fn(|_| AtomicBiquad::new()),
            gate: AtomicGate::new(),
            comp: AtomicComp::new(),
            limiter: AtomicLimiter::new(),
        };
        s.write_fields(cfg, sample_rate);
        s
    }

    /// Publish a new clamped config. Single-writer seqlock: odd generation while
    /// writing, even when done; `Release` fences bracket the field writes.
    pub fn publish(&self, cfg: &DspConfig, sample_rate: f32) {
        let g = self.generation.load(RELAXED);
        self.generation.store(g.wrapping_add(1), RELAXED); // enter: odd
        fence(Ordering::Release);
        self.write_fields(cfg, sample_rate);
        fence(Ordering::Release);
        self.generation.store(g.wrapping_add(2), RELAXED); // exit: even
    }

    fn write_fields(&self, cfg: &DspConfig, sr: f32) {
        self.denoise_enabled
            .store(cfg.denoise.enabled, RELAXED);
        self.denoise_use_dfn
            .store(cfg.denoise.backend == DenoiseBackend::DeepFilterNet, RELAXED);
        self.order.store(pack_order(&cfg.order), RELAXED);
        self.hpf.store(
            cfg.hpf.enabled,
            high_pass_coeffs(nyquist_clamp(cfg.hpf.freq_hz, sr), sr),
        );
        for (i, slot) in self.eq.iter().enumerate() {
            match cfg.eq.bands.get(i) {
                Some(b) => slot.store(cfg.eq.enabled && b.enabled, eq_band_coeffs(b, sr)),
                None => slot.store(false, peaking_coeffs(1_000.0, 1.0, 0.0, sr)),
            }
        }
        self.gate.store(
            cfg.gate.enabled,
            GateCoeffs::compute(
                cfg.gate.threshold_db,
                cfg.gate.attack_ms,
                cfg.gate.release_ms,
                cfg.gate.hold_ms,
                sr,
            ),
        );
        self.comp.store(
            cfg.compressor.enabled,
            CompressorCoeffs::compute(
                cfg.compressor.threshold_db,
                cfg.compressor.ratio,
                cfg.compressor.attack_ms,
                cfg.compressor.release_ms,
                cfg.compressor.makeup_db,
                sr,
            ),
        );
        self.limiter.store(
            cfg.limiter.enabled,
            LimiterCoeffs::compute(
                cfg.limiter.threshold_db,
                cfg.limiter.attack_ms,
                cfg.limiter.release_ms,
                sr,
            ),
        );
    }

    fn read_fields(&self) -> InputDspSnapshot {
        InputDspSnapshot {
            denoise_enabled: self.denoise_enabled.load(RELAXED),
            denoise_use_dfn: self.denoise_use_dfn.load(RELAXED),
            order: unpack_order(self.order.load(RELAXED)),
            hpf: self.hpf.load(),
            eq: std::array::from_fn(|i| self.eq[i].load()),
            gate: self.gate.load(),
            comp: self.comp.load(),
            limiter: self.limiter.load(),
        }
    }

    /// Seqlock read. Returns `None` if a write is in flight or raced (caller keeps
    /// the previous state). Does not consult `last_gen` — see [`Self::reload_if_changed`].
    pub fn try_snapshot(&self) -> Option<InputDspSnapshot> {
        let s1 = self.generation.load(RELAXED);
        if s1 & 1 != 0 {
            return None;
        }
        fence(Ordering::Acquire);
        let snap = self.read_fields();
        fence(Ordering::Acquire);
        if self.generation.load(RELAXED) != s1 {
            return None;
        }
        Some(snap)
    }

    /// Callback entry point: apply a newly published config to `slots`, if any.
    /// No-op (returns `false`) when a write is in flight, the generation is
    /// unchanged since the last apply, or a write raced the read. Never locks,
    /// allocates, or spins.
    pub fn reload_if_changed(&self, slots: &mut InputDspSlots) -> bool {
        let s1 = self.generation.load(RELAXED);
        if s1 & 1 != 0 || s1 == slots.last_gen {
            return false;
        }
        fence(Ordering::Acquire);
        let snap = self.read_fields();
        fence(Ordering::Acquire);
        if self.generation.load(RELAXED) != s1 {
            return false;
        }
        slots.apply(&snap);
        slots.last_gen = s1;
        true
    }
}

/// Shared per-bus DSP parameter block. Carries a parametric EQ (post-sum tone
/// shaping) and the final limiter, published through the same seqlock as inputs.
pub struct BusDspShared {
    generation: AtomicU32,
    eq: [AtomicBiquad; MAX_EQ_BANDS],
    limiter: AtomicLimiter,
}

impl BusDspShared {
    pub fn new(cfg: &BusDspConfig, sample_rate: f32) -> Self {
        let s = Self {
            generation: AtomicU32::new(0),
            eq: std::array::from_fn(|_| AtomicBiquad::new()),
            limiter: AtomicLimiter::new(),
        };
        s.write_fields(cfg, sample_rate);
        s
    }

    pub fn publish(&self, cfg: &BusDspConfig, sample_rate: f32) {
        let g = self.generation.load(RELAXED);
        self.generation.store(g.wrapping_add(1), RELAXED);
        fence(Ordering::Release);
        self.write_fields(cfg, sample_rate);
        fence(Ordering::Release);
        self.generation.store(g.wrapping_add(2), RELAXED);
    }

    fn write_fields(&self, cfg: &BusDspConfig, sr: f32) {
        for (i, slot) in self.eq.iter().enumerate() {
            match cfg.eq.bands.get(i) {
                Some(b) => slot.store(cfg.eq.enabled && b.enabled, eq_band_coeffs(b, sr)),
                None => slot.store(false, peaking_coeffs(1_000.0, 1.0, 0.0, sr)),
            }
        }
        self.limiter.store(
            cfg.limiter.enabled,
            LimiterCoeffs::compute(
                cfg.limiter.threshold_db,
                cfg.limiter.attack_ms,
                cfg.limiter.release_ms,
                sr,
            ),
        );
    }

    pub fn reload_if_changed(&self, slots: &mut BusDspSlots) -> bool {
        let s1 = self.generation.load(RELAXED);
        if s1 & 1 != 0 || s1 == slots.last_gen {
            return false;
        }
        fence(Ordering::Acquire);
        let eq = std::array::from_fn(|i| self.eq[i].load());
        let limiter = self.limiter.load();
        fence(Ordering::Acquire);
        if self.generation.load(RELAXED) != s1 {
            return false;
        }
        slots.apply(&BusDspSnapshot { eq, limiter });
        slots.last_gen = s1;
        true
    }
}

// ── Concrete effect slots (audio-callback side) ────────────────────────────────

/// Enable flush-to-zero (FTZ) + denormals-are-zero (DAZ) for SSE float math on
/// the calling (realtime) thread.
///
/// Biquad `y1/y2` delay state and the one-pole gate/compressor/limiter envelope
/// tails decay toward zero whenever the input goes near-silent. Once those
/// values reach the subnormal range, every dependent FPU op can stall for
/// hundreds of cycles on x86 — enough to blow the audio deadline and produce
/// dropouts. Setting FTZ+DAZ makes the hardware treat subnormal inputs and
/// results as zero, so the tails snap cleanly to 0 with no stall.
///
/// Called at the top of every realtime `process_block` rather than once at
/// stream start: it costs ~3 instructions per block, is idempotent, and is
/// robust to whatever thread the host actually runs the callback on without
/// having to reach into the mixer/stream-setup code (which the DSP worktree
/// keeps untouched to avoid merge collisions). Read-modify-write preserves the
/// rounding mode and exception masks. x86_64 only; a documented no-op elsewhere
/// (the app ships x86_64).
#[cfg(target_arch = "x86_64")]
#[inline]
fn enable_flush_denormals() {
    use core::arch::asm;
    // FTZ = bit 15 (0x8000), DAZ = bit 6 (0x0040). Read-modify-write via
    // `stmxcsr`/`ldmxcsr` so the rounding mode and exception masks are preserved.
    // (The `_mm_getcsr`/`_mm_setcsr` intrinsics are deprecated in favor of asm.)
    let mut mxcsr: u32 = 0;
    unsafe {
        asm!("stmxcsr [{0}]", in(reg) &mut mxcsr, options(nostack, preserves_flags));
        mxcsr |= 0x8040;
        asm!("ldmxcsr [{0}]", in(reg) &mxcsr, options(nostack, readonly, preserves_flags));
    }
}

#[cfg(not(target_arch = "x86_64"))]
#[inline]
fn enable_flush_denormals() {}

/// Re-enable helper: set enabled + coeffs, and `reset()` the effect when it just
/// transitioned disabled→enabled so stale envelope/filter state cannot pop.
#[inline]
fn apply_biquad(f: &mut BiquadFilter, enabled: bool, coeffs: [f32; 5]) {
    let was = f.is_enabled();
    f.set_enabled(enabled);
    f.set_coeffs(coeffs);
    if enabled && !was {
        f.reset();
    }
}

/// Drive one concrete effect across a whole interleaved block. Generic over the
/// concrete type so `process` is monomorphized and inlined — the inner loop
/// carries zero per-sample dispatch. The caller hoists the `is_enabled` check
/// out to once per block. Equivalent to running the effect per frame in order:
/// each effect completes the block before the next reads it, and every effect
/// still sees frames in index order, so the output matches per-frame processing.
#[inline(always)]
fn process_block_effect<E: DspEffect>(effect: &mut E, interleaved: &mut [f32], channels: usize) {
    if channels == 2 {
        for frame in interleaved.chunks_exact_mut(2) {
            let mut b = [frame[0], frame[1]];
            effect.process(&mut b, 2);
            frame[0] = b[0];
            frame[1] = b[1];
        }
    } else {
        for s in interleaved.iter_mut() {
            let mut b = [*s, 0.0];
            effect.process(&mut b, 1);
            *s = b[0];
        }
    }
}

/// Fixed per-input effect chain in processing order HPF → Gate → EQ → Comp →
/// Limiter. Allocated once before the stream starts; effects are toggled and
/// retuned in place via [`InputDspShared::reload_if_changed`], never rebuilt.
pub struct InputDspSlots {
    last_gen: u32,
    denoiser: Denoiser,
    denoise_enabled: bool,
    order: [DspStage; 6],
    hpf: BiquadFilter,
    gate: NoiseGate,
    eq: [BiquadFilter; MAX_EQ_BANDS],
    comp: Compressor,
    limiter: Limiter,
}

impl InputDspSlots {
    /// Build a bypassed chain seeded with default parameters. The first
    /// `reload_if_changed` applies the shared block's seeded config (so a
    /// preset/rebuild config takes effect on the first block).
    pub fn new(sample_rate: f32) -> Self {
        let cfg = DspConfig::default();
        let mut hpf = BiquadFilter::high_pass(cfg.hpf.freq_hz, sample_rate);
        hpf.set_enabled(false);
        let eq = std::array::from_fn(|i| {
            let b = &cfg.eq.bands[i];
            let mut f = BiquadFilter::peaking(b.freq_hz, b.q, b.gain_db, sample_rate);
            f.set_enabled(false);
            f
        });
        let mut gate = NoiseGate::new(
            cfg.gate.threshold_db,
            cfg.gate.attack_ms,
            cfg.gate.release_ms,
            cfg.gate.hold_ms,
            sample_rate,
        );
        gate.set_enabled(false);
        let mut comp = Compressor::new(
            cfg.compressor.threshold_db,
            cfg.compressor.ratio,
            cfg.compressor.attack_ms,
            cfg.compressor.release_ms,
            cfg.compressor.makeup_db,
            sample_rate,
        );
        comp.set_enabled(false);
        let mut limiter = Limiter::new(
            cfg.limiter.threshold_db,
            cfg.limiter.attack_ms,
            cfg.limiter.release_ms,
            sample_rate,
        );
        limiter.set_enabled(false);
        Self {
            last_gen: u32::MAX,
            denoiser: Denoiser::new(sample_rate),
            denoise_enabled: false,
            order: DspStage::ALL,
            hpf,
            gate,
            eq,
            comp,
            limiter,
        }
    }

    fn apply(&mut self, s: &InputDspSnapshot) {
        // Denoiser: pick the backend, then flush bridging buffers on a
        // disabled→enabled transition or a backend switch so stale queued audio
        // can't play out.
        let denoise_was = self.denoise_enabled;
        self.denoise_enabled = s.denoise_enabled;
        let backend_changed = self.denoiser.set_use_dfn(s.denoise_use_dfn);
        if s.denoise_enabled && (!denoise_was || backend_changed) {
            self.denoiser.reset();
        }
        self.order = s.order;
        apply_biquad(&mut self.hpf, s.hpf.0, s.hpf.1);
        for (band, snap) in self.eq.iter_mut().zip(s.eq.iter()) {
            apply_biquad(band, snap.0, snap.1);
        }
        let gate_was = self.gate.is_enabled();
        self.gate.set_enabled(s.gate.0);
        self.gate.set_coeffs(s.gate.1);
        if s.gate.0 && !gate_was {
            self.gate.reset();
        }
        let comp_was = self.comp.is_enabled();
        self.comp.set_enabled(s.comp.0);
        self.comp.set_coeffs(s.comp.1);
        if s.comp.0 && !comp_was {
            self.comp.reset();
        }
        let lim_was = self.limiter.is_enabled();
        self.limiter.set_enabled(s.limiter.0);
        self.limiter.set_coeffs(s.limiter.1);
        if s.limiter.0 && !lim_was {
            self.limiter.reset();
        }
    }

    /// Process one stereo frame through the enabled effects in chain order.
    /// `channels` is 1 or 2. Empty/bypassed when nothing is enabled.
    #[inline]
    pub fn process(&mut self, buf: &mut [f32; 2], channels: usize) {
        if self.hpf.is_enabled() {
            self.hpf.process(buf, channels);
        }
        if self.gate.is_enabled() {
            self.gate.process(buf, channels);
        }
        for band in &mut self.eq {
            if band.is_enabled() {
                band.process(buf, channels);
            }
        }
        if self.comp.is_enabled() {
            self.comp.process(buf, channels);
        }
        if self.limiter.is_enabled() {
            self.limiter.process(buf, channels);
        }
    }

    /// Block form of [`Self::process`]: same chain order (HPF → Gate → EQ →
    /// Comp → Limiter) and identical output, but each enabled effect's
    /// `is_enabled` check is hoisted out of the per-sample loop and its
    /// `process` is monomorphized (no dispatch per sample). `channels` is
    /// 1 (mono) or 2 (`[L, R, …]`). `interleaved.len()` must be a multiple of
    /// `channels`.
    #[inline]
    pub fn process_block(&mut self, interleaved: &mut [f32], channels: usize) {
        enable_flush_denormals();
        // Walk the stages in the wired order. Each stage runs only if enabled;
        // disabled stages are cheap skips. Block-only path — the realtime mixer
        // always uses `process_block` (the per-frame `process` keeps the fixed
        // canonical order and omits the denoiser).
        for stage in self.order {
            match stage {
                DspStage::Denoise => {
                    if self.denoise_enabled {
                        self.denoiser.process(interleaved, channels);
                    }
                }
                DspStage::Hpf => {
                    if self.hpf.is_enabled() {
                        process_block_effect(&mut self.hpf, interleaved, channels);
                    }
                }
                DspStage::Gate => {
                    if self.gate.is_enabled() {
                        process_block_effect(&mut self.gate, interleaved, channels);
                    }
                }
                DspStage::Eq => {
                    for band in &mut self.eq {
                        if band.is_enabled() {
                            process_block_effect(band, interleaved, channels);
                        }
                    }
                }
                DspStage::Comp => {
                    if self.comp.is_enabled() {
                        process_block_effect(&mut self.comp, interleaved, channels);
                    }
                }
                DspStage::Limiter => {
                    if self.limiter.is_enabled() {
                        process_block_effect(&mut self.limiter, interleaved, channels);
                    }
                }
            }
        }
    }
}

/// Fixed per-bus effect chain (EQ → Limiter), processed post-sum/pre-clip.
pub struct BusDspSlots {
    last_gen: u32,
    eq: [BiquadFilter; MAX_EQ_BANDS],
    limiter: Limiter,
}

impl BusDspSlots {
    pub fn new(sample_rate: f32) -> Self {
        let cfg = BusDspConfig::default();
        let eq = std::array::from_fn(|i| {
            let b = &cfg.eq.bands[i];
            let mut f = BiquadFilter::peaking(b.freq_hz, b.q, b.gain_db, sample_rate);
            f.set_enabled(false);
            f
        });
        let mut limiter = Limiter::new(
            cfg.limiter.threshold_db,
            cfg.limiter.attack_ms,
            cfg.limiter.release_ms,
            sample_rate,
        );
        limiter.set_enabled(false);
        Self {
            last_gen: u32::MAX,
            eq,
            limiter,
        }
    }

    fn apply(&mut self, s: &BusDspSnapshot) {
        for (band, snap) in self.eq.iter_mut().zip(s.eq.iter()) {
            apply_biquad(band, snap.0, snap.1);
        }
        let was = self.limiter.is_enabled();
        self.limiter.set_enabled(s.limiter.0);
        self.limiter.set_coeffs(s.limiter.1);
        if s.limiter.0 && !was {
            self.limiter.reset();
        }
    }

    #[inline]
    pub fn process(&mut self, buf: &mut [f32; 2], channels: usize) {
        for band in &mut self.eq {
            if band.is_enabled() {
                band.process(buf, channels);
            }
        }
        if self.limiter.is_enabled() {
            self.limiter.process(buf, channels);
        }
    }

    /// Block form of [`Self::process`]: same chain order (EQ → Limiter).
    #[inline]
    pub fn process_block(&mut self, interleaved: &mut [f32], channels: usize) {
        enable_flush_denormals();
        for band in &mut self.eq {
            if band.is_enabled() {
                process_block_effect(band, interleaved, channels);
            }
        }
        if self.limiter.is_enabled() {
            process_block_effect(&mut self.limiter, interleaved, channels);
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 48_000.0;

    #[cfg(target_arch = "x86_64")]
    #[test]
    fn ftz_daz_flush_subnormals_to_zero() {
        use std::hint::black_box;
        enable_flush_denormals();
        // FTZ (subnormal *result* → 0): MIN_POSITIVE is the smallest normal f32;
        // *0.25 underflows into the subnormal range. `black_box` blocks
        // const-folding so the multiply runs on the FPU with the flag live.
        let ftz = black_box(black_box(f32::MIN_POSITIVE) * black_box(0.25_f32));
        assert_eq!(ftz, 0.0, "FTZ should flush a subnormal product to zero");
        // DAZ (subnormal *input* → 0): build the denormal via `from_bits` (no
        // arithmetic, so FTZ can't pre-flush it), then multiply by 1e30. With DAZ
        // the input is read as 0 → result 0; without DAZ it would be a normal
        // ~1.4e-15, so a zero result isolates DAZ.
        let daz = black_box(black_box(f32::from_bits(1)) * black_box(1.0e30_f32));
        assert_eq!(daz, 0.0, "DAZ should treat a subnormal input as zero");
    }

    #[test]
    fn nonfinite_biquad_coeffs_sanitized_to_passthrough() {
        let passthrough = [1.0, 0.0, 0.0, 0.0, 0.0];
        for bad in [
            [f32::NAN, 1.0, 2.0, 3.0, 4.0],
            [0.5, f32::INFINITY, 0.0, 0.0, 0.0],
            [0.5, 0.0, f32::NEG_INFINITY, 0.0, 0.0],
            [0.5, 0.0, 0.0, f32::NAN, 0.0],
            [0.5, 0.0, 0.0, 0.0, f32::INFINITY],
        ] {
            let ab = AtomicBiquad::new();
            ab.store(true, bad);
            let (en, c) = ab.load();
            assert!(en);
            assert_eq!(c, passthrough, "non-finite coeffs must become passthrough");
        }
        // A finite set publishes unchanged.
        let ab = AtomicBiquad::new();
        let good = [0.5, -0.1, 0.2, -0.3, 0.4];
        ab.store(true, good);
        assert_eq!(ab.load().1, good);
    }

    fn cfg_with(gate_db: f32, ratio: f32) -> DspConfig {
        let mut c = DspConfig::default();
        c.gate.enabled = true;
        c.gate.threshold_db = gate_db;
        c.compressor.enabled = true;
        c.compressor.ratio = ratio;
        c
    }

    #[test]
    fn default_slots_pass_signal_through() {
        let mut slots = InputDspSlots::new(SR);
        let mut buf = [0.42, -0.17];
        slots.process(&mut buf, 2);
        assert_eq!(buf, [0.42, -0.17]);
    }

    #[test]
    fn publish_enables_effects_and_reload_picks_it_up() {
        let shared = InputDspShared::new(&DspConfig::default(), SR);
        let mut slots = InputDspSlots::new(SR);
        // Seeded default at gen 0 -> first reload applies bypass.
        assert!(shared.reload_if_changed(&mut slots));
        // Nothing enabled yet.
        let mut buf = [0.3, 0.3];
        slots.process(&mut buf, 2);
        assert_eq!(buf, [0.3, 0.3]);

        // Publish a config with the gate enabled; reload must pick it up once.
        let mut c = DspConfig::default();
        c.gate.enabled = true;
        c.gate.threshold_db = -6.0; // high threshold -> closes on quiet signal
        c.clamp();
        shared.publish(&c, SR);
        assert!(shared.reload_if_changed(&mut slots));
        // A second reload with no new publish is a no-op.
        assert!(!shared.reload_if_changed(&mut slots));

        // Quiet signal below the gate threshold is attenuated over time.
        let mut last = 1.0f32;
        for _ in 0..4_000 {
            let mut b = [0.01, 0.01];
            slots.process(&mut b, 2);
            last = b[0].abs();
        }
        assert!(
            last < 0.01,
            "gate should attenuate sub-threshold signal, got {last}"
        );
    }

    #[test]
    fn write_in_flight_is_ignored() {
        let shared = InputDspShared::new(&DspConfig::default(), SR);
        let mut slots = InputDspSlots::new(SR);
        assert!(shared.reload_if_changed(&mut slots)); // apply gen 0
                                                       // Force an odd generation (simulate a publish in progress).
        shared.generation.store(3, Ordering::Relaxed);
        assert!(
            !shared.reload_if_changed(&mut slots),
            "odd generation must be ignored"
        );
        assert!(shared.try_snapshot().is_none());
    }

    #[test]
    fn bus_limiter_publish_and_reload() {
        let shared = BusDspShared::new(&BusDspConfig::default(), SR);
        let mut slots = BusDspSlots::new(SR);
        assert!(shared.reload_if_changed(&mut slots));
        let mut c = BusDspConfig::default();
        c.limiter.enabled = true;
        c.limiter.threshold_db = -6.0;
        c.clamp();
        shared.publish(&c, SR);
        assert!(shared.reload_if_changed(&mut slots));
        // A hot signal is pulled toward the ceiling.
        let mut peak = 0.0f32;
        for _ in 0..2_000 {
            let mut b = [0.99, 0.99];
            slots.process(&mut b, 2);
            peak = b[0].abs();
        }
        assert!(
            peak < 0.95,
            "bus limiter should pull a hot signal down, got {peak}"
        );
    }

    #[test]
    fn eq_band_kind_selects_coeffs() {
        // A non-peaking band must publish the coefficients of its shape, not
        // the old hardcoded peaking set.
        let mut c = DspConfig::default();
        c.eq.enabled = true;
        c.eq.bands[0].enabled = true;
        c.eq.bands[0].kind = BandKind::LowShelf;
        c.eq.bands[0].freq_hz = 200.0;
        c.eq.bands[0].gain_db = 6.0;
        c.clamp();
        let shared = InputDspShared::new(&c, SR);
        let snap = shared.try_snapshot().expect("clean snapshot");
        assert!(snap.eq[0].0, "band 0 should be enabled");
        assert_eq!(snap.eq[0].1, low_shelf_coeffs(200.0, 6.0, SR));
    }

    #[test]
    fn bus_eq_alters_signal() {
        let shared = BusDspShared::new(&BusDspConfig::default(), SR);
        let mut slots = BusDspSlots::new(SR);
        assert!(shared.reload_if_changed(&mut slots));
        // Bypassed: DC passes through untouched.
        let mut b = [0.5, -0.5];
        slots.process(&mut b, 2);
        assert_eq!(b, [0.5, -0.5]);

        // Enable a low shelf: DC sits in the shelf band, so it is boosted.
        let mut c = BusDspConfig::default();
        c.eq.enabled = true;
        c.eq.bands[0].enabled = true;
        c.eq.bands[0].kind = BandKind::LowShelf;
        c.eq.bands[0].freq_hz = 300.0;
        c.eq.bands[0].gain_db = 6.0;
        c.clamp();
        shared.publish(&c, SR);
        assert!(shared.reload_if_changed(&mut slots));
        let mut out = 0.0f32;
        for _ in 0..2_000 {
            let mut x = [0.5, 0.5];
            slots.process(&mut x, 2);
            assert!(x[0].is_finite());
            out = x[0];
        }
        assert!(out > 0.6, "low-shelf boost should lift DC, got {out}");
    }

    #[test]
    fn seqlock_never_tears_under_concurrent_publish() {
        use std::sync::Arc;
        use std::thread;

        let a = cfg_with(-40.0, 4.0);
        let b = cfg_with(-10.0, 12.0);
        let shared = Arc::new(InputDspShared::new(&a, SR));

        let ta = GateCoeffs::compute(-40.0, 10.0, 150.0, 80.0, SR).threshold_lin;
        let tb = GateCoeffs::compute(-10.0, 10.0, 150.0, 80.0, SR).threshold_lin;

        let writer = {
            let s = Arc::clone(&shared);
            thread::spawn(move || {
                for i in 0..20_000u32 {
                    s.publish(if i & 1 == 0 { &a } else { &b }, SR);
                }
            })
        };

        for _ in 0..200_000u32 {
            if let Some(snap) = shared.try_snapshot() {
                let gt = snap.gate.1.threshold_lin;
                let rr = snap.comp.1.ratio;
                let is_a = (gt - ta).abs() < 1e-6 && (rr - 4.0).abs() < 1e-6;
                let is_b = (gt - tb).abs() < 1e-6 && (rr - 12.0).abs() < 1e-6;
                assert!(is_a || is_b, "torn snapshot: gate_thr={gt} ratio={rr}");
            }
        }
        writer.join().unwrap();
    }

    #[test]
    fn process_block_matches_per_frame_process() {
        // With several stateful effects enabled, block processing must produce
        // the same output as the per-frame loop: each effect runs the whole
        // block before the next, but every effect still sees frames in order.
        let mut c = DspConfig::default();
        c.hpf.enabled = true;
        c.gate.enabled = true;
        c.compressor.enabled = true;
        c.compressor.ratio = 4.0;
        c.limiter.enabled = true;
        c.limiter.threshold_db = -3.0;
        c.clamp();

        let shared = InputDspShared::new(&c, SR);
        let mut per_frame = InputDspSlots::new(SR);
        let mut block = InputDspSlots::new(SR);
        assert!(shared.reload_if_changed(&mut per_frame));
        assert!(shared.reload_if_changed(&mut block));

        let n = 512usize;
        let mut a: Vec<f32> = (0..n * 2)
            .map(|i| ((i as f32) * 0.013).sin() * 0.6)
            .collect();
        let mut b = a.clone();

        for frame in a.chunks_exact_mut(2) {
            let mut f = [frame[0], frame[1]];
            per_frame.process(&mut f, 2);
            frame[0] = f[0];
            frame[1] = f[1];
        }
        block.process_block(&mut b, 2);

        for (x, y) in a.iter().zip(b.iter()) {
            assert!((x - y).abs() < 1e-6, "block != per-frame: {x} vs {y}");
        }
    }

    #[test]
    fn process_block_mono_matches_per_frame() {
        let mut c = DspConfig::default();
        c.hpf.enabled = true;
        c.compressor.enabled = true;
        c.clamp();
        let shared = InputDspShared::new(&c, SR);
        let mut per_frame = InputDspSlots::new(SR);
        let mut block = InputDspSlots::new(SR);
        assert!(shared.reload_if_changed(&mut per_frame));
        assert!(shared.reload_if_changed(&mut block));

        let n = 256usize;
        let mut a: Vec<f32> = (0..n).map(|i| ((i as f32) * 0.021).sin() * 0.5).collect();
        let mut b = a.clone();

        for s in a.iter_mut() {
            let mut f = [*s, 0.0];
            per_frame.process(&mut f, 1);
            *s = f[0];
        }
        block.process_block(&mut b, 1);

        for (x, y) in a.iter().zip(b.iter()) {
            assert!((x - y).abs() < 1e-6, "mono block != per-frame: {x} vs {y}");
        }
    }

    #[test]
    fn order_pack_round_trips() {
        let order = [
            DspStage::Limiter,
            DspStage::Comp,
            DspStage::Eq,
            DspStage::Gate,
            DspStage::Hpf,
            DspStage::Denoise,
        ];
        assert_eq!(unpack_order(pack_order(&order)), order);
        assert_eq!(unpack_order(pack_order(&DspStage::ALL)), DspStage::ALL);
    }

    #[test]
    fn stage_order_changes_block_output() {
        // Compressor with makeup gain then a hard limiter is NOT the same as
        // limiter then compressor: boosting before clamping vs clamping before
        // boosting. Same params, different order → different output.
        let mut base = DspConfig::default();
        base.compressor.enabled = true;
        base.compressor.threshold_db = -24.0;
        base.compressor.ratio = 8.0;
        base.compressor.makeup_db = 18.0;
        base.limiter.enabled = true;
        base.limiter.threshold_db = -6.0;

        let mut comp_first = base.clone();
        comp_first.order = vec![DspStage::Comp, DspStage::Limiter];
        comp_first.clamp();
        let mut lim_first = base.clone();
        lim_first.order = vec![DspStage::Limiter, DspStage::Comp];
        lim_first.clamp();

        let run = |cfg: &DspConfig| {
            let shared = InputDspShared::new(cfg, SR);
            let mut slots = InputDspSlots::new(SR);
            assert!(shared.reload_if_changed(&mut slots));
            let mut buf: Vec<f32> = (0..512 * 2)
                .map(|i| ((i as f32) * 0.05).sin() * 0.9)
                .collect();
            slots.process_block(&mut buf, 2);
            buf
        };

        let a = run(&comp_first);
        let b = run(&lim_first);
        let diff: f32 = a.iter().zip(b.iter()).map(|(x, y)| (x - y).abs()).sum();
        assert!(diff > 1e-3, "stage order should change output, diff={diff}");
    }
}
