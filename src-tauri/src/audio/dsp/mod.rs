pub mod config;
pub mod denoise;
pub mod dynamics;
pub mod filter;
pub mod gate;
pub mod live;

pub use config::{
    BandKind, BusDspConfig, CompressorConfig, DenoiseBackend, DenoiseConfig, DspConfig, EqBand,
    EqConfig, GateConfig, HpfConfig, LimiterConfig, MAX_EQ_BANDS,
};
pub use denoise::Denoiser;
pub use dynamics::{Compressor, Limiter};
pub use filter::BiquadFilter;
pub use gate::NoiseGate;

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

/// Ordered chain of effects applied per input bus.
/// Empty chain costs ~3 instructions per sample (branch predicted, no iterations).
pub struct DspChain {
    effects: Vec<Box<dyn DspEffect>>,
}

impl DspChain {
    pub fn new() -> Self {
        Self {
            effects: Vec::new(),
        }
    }

    pub fn push(&mut self, effect: impl DspEffect + 'static) {
        self.effects.push(Box::new(effect));
    }

    #[inline(always)]
    pub fn process(&mut self, buf: &mut [f32; 2], channels: usize) {
        for effect in &mut self.effects {
            if effect.is_enabled() {
                effect.process(buf, channels);
            }
        }
    }

    pub fn is_empty(&self) -> bool {
        self.effects.is_empty()
    }
}
