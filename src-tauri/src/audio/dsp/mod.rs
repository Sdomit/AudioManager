pub mod automix;
pub mod binaural;
pub mod config;
pub mod denoise;
pub mod dynamics;
pub mod filter;
pub mod gate;
pub mod live;

pub use automix::{AutomixGroupUpdate, MAX_AUTOMIX_GROUPS};
pub use config::{AutomixConfig, BusDspConfig, DspConfig};
// `BandKind`/`DspStage` are referenced by tests via the `dsp::` path; internal
// production code imports the rest straight from `config::` / the effect modules.
#[cfg(test)]
pub use config::{BandKind, DspStage};

/// One DSP unit. Processes a stereo frame in-place, sample-by-sample.
///
/// `channels` is 1 or 2. Implementations MUST NOT advance ch1 state when
/// `channels == 1` — that channel's value is undefined for mono inputs.
pub trait DspEffect: Send {
    fn process(&mut self, buf: &mut [f32; 2], channels: usize);
    fn reset(&mut self) {}
    fn is_enabled(&self) -> bool {
        true
    }
}
