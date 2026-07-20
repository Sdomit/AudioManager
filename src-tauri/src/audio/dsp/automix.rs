//! Cross-input gain-sharing automix — the live sound gate (Feature B, B1).
//!
//! When several mics (typically phones) sit close together in one room they all
//! capture the same voice, producing echo / comb-filtering / doubling. A
//! Dugan-style gain-sharing automixer assigns each member mic a gain equal to its
//! share of the group's total level, so the open gains sum to ~1 (one-mic-open
//! equivalent, no ambient buildup). The closest/loudest mic dominates; duplicate
//! captures of the same voice are pushed down. Gains move smoothly with the
//! talker — no hard switching, no pumping.
//!
//! This is inherently cross-input, so it cannot live in the per-input DSP chain
//! (`InputDspSlots`). The mixer callback runs it once per block after every
//! input's per-input DSP and before the per-frame mix: it reads each member's
//! processed block, updates a per-member energy follower, derives shares, and
//! writes a gain multiplier per member that the mix loop folds into the per-input
//! gain.
//!
//! RT-safety: no allocation, no locks, no transcendental on the hot path
//! (coefficients are precomputed on the IPC thread; the block-rate follower uses
//! `powi`). FTZ/DAZ is already armed by the mixer callback, so squared subnormals
//! flush to zero.

use super::config::AutomixConfig;
use crate::audio::mixer::MAX_INPUTS;

/// Maximum simultaneous automix groups per engine. Each group is a disjoint set
/// of input slots; kept small (≤ MAX_INPUTS/2) — the realtime state is a fixed
/// array of this many [`AutomixGroup`]s.
pub const MAX_AUTOMIX_GROUPS: usize = 4;

#[inline(always)]
fn db_to_lin(db: f32) -> f32 {
    10.0_f32.powf(db / 20.0)
}

#[inline(always)]
fn ms_to_coeff(ms: f32, sr: f32) -> f32 {
    if ms <= 0.0 {
        return 0.0;
    }
    (-1.0 / (ms * 0.001 * sr)).exp()
}

/// Automix coefficients, precomputed on the IPC thread so the realtime callback
/// never runs `exp`/`powf`. `attack_coeff`/`release_coeff` are per-sample one-pole
/// coefficients; the callback raises them to `powi(frames)` for the block rate.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct AutomixCoeffs {
    pub attack_coeff: f32,
    pub release_coeff: f32,
    pub floor_lin: f32,
    pub noise_floor_lin: f32,
}

impl AutomixCoeffs {
    pub fn compute(cfg: &AutomixConfig, sample_rate: f32) -> Self {
        Self {
            attack_coeff: ms_to_coeff(cfg.attack_ms, sample_rate),
            release_coeff: ms_to_coeff(cfg.release_ms, sample_rate),
            floor_lin: db_to_lin(cfg.floor_db),
            noise_floor_lin: db_to_lin(cfg.noise_floor_db),
        }
    }
}

/// A resolved automix group ready to cross the realtime boundary: which input
/// slots are members (`member_mask`, bit `i` = input slot `i`) plus the tuned
/// params. The IPC layer resolves member device ids → slot indices per engine and
/// builds these before publishing.
#[derive(Debug, Clone, Copy)]
pub struct AutomixGroupUpdate {
    pub enabled: bool,
    pub member_mask: u32,
    pub config: AutomixConfig,
}

/// Realtime per-group processor. Owns a per-member energy follower (smoothed
/// mean-square power) and the last applied share gain (held across silent
/// blocks). Lives in the audio callback; retuned in place via [`Self::set`].
pub struct AutomixGroup {
    enabled: bool,
    member_mask: u32,
    coeffs: AutomixCoeffs,
    /// Smoothed mean-square power per input slot.
    power: [f32; MAX_INPUTS],
    /// Last applied share gain per input slot (held when the group is idle).
    gain: [f32; MAX_INPUTS],
}

impl Default for AutomixGroup {
    fn default() -> Self {
        Self::new()
    }
}

impl AutomixGroup {
    pub fn new() -> Self {
        Self {
            enabled: false,
            member_mask: 0,
            coeffs: AutomixCoeffs::default(),
            power: [0.0; MAX_INPUTS],
            gain: [1.0; MAX_INPUTS],
        }
    }

    /// Clear follower + applied-gain state. Gains reset to unity (no attenuation)
    /// so a regroup starts transparent and ramps in once audio arrives.
    pub fn reset(&mut self) {
        self.power = [0.0; MAX_INPUTS];
        self.gain = [1.0; MAX_INPUTS];
    }

    /// Apply a published snapshot. A membership change resets the follower/gain
    /// state so a removed member can't leave stale energy or a sticky gain on a
    /// reused slot index.
    pub fn set(&mut self, enabled: bool, member_mask: u32, coeffs: AutomixCoeffs) {
        if member_mask != self.member_mask {
            self.reset();
        }
        self.enabled = enabled;
        self.member_mask = member_mask;
        self.coeffs = coeffs;
    }

    /// Compute this block's share gains and fold them into `out_gain` (one
    /// multiplier per input slot). `scratch[i][..avail_frames[i] * in_ch[i]]` is
    /// input `i`'s post-DSP block. Non-members and a disabled/empty group leave
    /// `out_gain` untouched.
    #[inline]
    pub fn process_block(
        &mut self,
        scratch: &[Vec<f32>],
        avail_frames: &[usize],
        in_ch: &[usize],
        n: usize,
        frames: usize,
        out_gain: &mut [f32],
    ) {
        if !self.enabled || self.member_mask == 0 || frames == 0 {
            return;
        }
        let n = n.min(MAX_INPUTS);
        // Block-rate one-pole coefficients: a per-sample coeff applied once over
        // `frames` samples equals `coeff^frames`. `powi` is a few multiplies — no
        // transcendental on the realtime path.
        let ac = self.coeffs.attack_coeff.powi(frames as i32);
        let rc = self.coeffs.release_coeff.powi(frames as i32);

        let mut level = [0.0f32; MAX_INPUTS];
        let mut total = 0.0f32;
        for i in 0..n {
            if self.member_mask & (1 << i) == 0 {
                continue;
            }
            let m = (avail_frames[i] * in_ch[i]).min(scratch[i].len());
            let inst = if m > 0 {
                let mut sum_sq = 0.0f32;
                for &x in &scratch[i][..m] {
                    sum_sq += x * x;
                }
                sum_sq / m as f32
            } else {
                0.0
            };
            // Rising power tracks at attack speed, falling at release speed.
            let coeff = if inst > self.power[i] { ac } else { rc };
            self.power[i] = inst + coeff * (self.power[i] - inst);
            level[i] = self.power[i].sqrt();
            total += level[i];
        }

        // Activity gate: above the floor recompute shares; below it the group is
        // idle (room silent) — hold the last gains rather than dividing
        // near-zero energy. `noise_floor_lin` is finite-positive, so `total`
        // exceeding it guarantees `total > 0` (no divide-by-zero).
        if total > self.coeffs.noise_floor_lin {
            for i in 0..n {
                if self.member_mask & (1 << i) == 0 {
                    continue;
                }
                let share = level[i] / total;
                self.gain[i] = share.max(self.coeffs.floor_lin).min(1.0);
            }
        }

        for i in 0..n {
            if self.member_mask & (1 << i) == 0 {
                continue;
            }
            out_gain[i] *= self.gain[i];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 48_000.0;
    const FRAMES: usize = 480; // 10 ms at 48 kHz

    fn coeffs() -> AutomixCoeffs {
        AutomixCoeffs::compute(&AutomixConfig::default(), SR)
    }

    /// Build `n` mono scratch buffers filled with the given constant amplitudes.
    fn scratch(amps: &[f32]) -> (Vec<Vec<f32>>, [usize; MAX_INPUTS], [usize; MAX_INPUTS]) {
        let bufs: Vec<Vec<f32>> = amps.iter().map(|&a| vec![a; FRAMES]).collect();
        let mut avail = [0usize; MAX_INPUTS];
        let mut chans = [1usize; MAX_INPUTS];
        for i in 0..amps.len() {
            avail[i] = FRAMES;
            chans[i] = 1;
        }
        (bufs, avail, chans)
    }

    /// Run the group to steady state on constant input, return the per-slot gains.
    fn converge(g: &mut AutomixGroup, amps: &[f32]) -> [f32; MAX_INPUTS] {
        let (bufs, avail, chans) = scratch(amps);
        let mut out = [1.0f32; MAX_INPUTS];
        for _ in 0..400 {
            out = [1.0f32; MAX_INPUTS];
            g.process_block(&bufs, &avail, &chans, amps.len(), FRAMES, &mut out);
        }
        out
    }

    #[test]
    fn compute_matches_expected() {
        let c = coeffs();
        assert!((c.floor_lin - db_to_lin(-60.0)).abs() < 1e-9);
        assert!((c.noise_floor_lin - db_to_lin(-50.0)).abs() < 1e-9);
        assert!(c.attack_coeff > 0.0 && c.attack_coeff < 1.0);
        assert!(c.release_coeff > c.attack_coeff); // longer time → slower → larger coeff
    }

    #[test]
    fn equal_members_split_to_half_and_sum_to_one() {
        let mut g = AutomixGroup::new();
        g.set(true, 0b11, coeffs());
        let out = converge(&mut g, &[0.1, 0.1]);
        assert!((out[0] - 0.5).abs() < 0.02, "out0 = {}", out[0]);
        assert!((out[1] - 0.5).abs() < 0.02, "out1 = {}", out[1]);
        assert!((out[0] + out[1] - 1.0).abs() < 0.02);
    }

    #[test]
    fn loudest_member_dominates_quiet_floored_above_min() {
        let mut g = AutomixGroup::new();
        g.set(true, 0b11, coeffs());
        // 0.2 vs 0.05 → levels 0.2/0.05 → shares 0.8 / 0.2.
        let out = converge(&mut g, &[0.2, 0.05]);
        assert!(
            out[0] > out[1],
            "loud {} should beat quiet {}",
            out[0],
            out[1]
        );
        assert!((out[0] - 0.8).abs() < 0.03, "loud share = {}", out[0]);
        assert!(
            out[1] >= db_to_lin(-60.0),
            "quiet must stay above the floor"
        );
        assert!(out[0] <= 1.0 && out[1] <= 1.0);
    }

    #[test]
    fn silent_group_holds_unity_gain() {
        let mut g = AutomixGroup::new();
        g.set(true, 0b11, coeffs());
        let out = converge(&mut g, &[0.0, 0.0]);
        // Below the activity gate the group never recomputes → gains stay at the
        // initial unity, so silence is never attenuated and there is no NaN.
        assert_eq!(out[0], 1.0);
        assert_eq!(out[1], 1.0);
        assert!(out[0].is_finite() && out[1].is_finite());
    }

    #[test]
    fn lone_member_resolves_to_unity() {
        let mut g = AutomixGroup::new();
        // Group has one member (slot 0); slot 1 is present in the engine but not
        // a member.
        g.set(true, 0b01, coeffs());
        let out = converge(&mut g, &[0.1, 0.1]);
        assert!((out[0] - 1.0).abs() < 0.02, "lone member gain = {}", out[0]);
        assert_eq!(out[1], 1.0, "non-member must be untouched");
    }

    #[test]
    fn membership_change_resets_state() {
        let mut g = AutomixGroup::new();
        g.set(true, 0b11, coeffs());
        converge(&mut g, &[0.2, 0.05]); // slot 1 driven down toward the floor
                                        // Re-scope to a single member: state must reset so slot 1 isn't left with
                                        // a stale suppressed gain.
        g.set(true, 0b01, coeffs());
        let out = converge(&mut g, &[0.1, 0.1]);
        assert!((out[0] - 1.0).abs() < 0.02);
        assert_eq!(out[1], 1.0);
    }

    #[test]
    fn disabled_group_is_passthrough() {
        let mut g = AutomixGroup::new();
        g.set(false, 0b11, coeffs());
        let out = converge(&mut g, &[0.2, 0.05]);
        assert_eq!(out, [1.0; MAX_INPUTS]);
    }
}
