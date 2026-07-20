//! Per-bus spectrum analyzer.
//!
//! The RT callback pushes mono-mixed output samples into a lock-free SPSC
//! ring. A background thread consumes them, runs a windowed FFT every
//! HOP_SIZE samples, smooths the magnitude spectrum with a fast-attack/
//! slow-decay IIR, and stores N_BINS f32 dB values in an atomic array.
//! The IPC thread reads the array without blocking.

use std::sync::{
    atomic::{AtomicU32, Ordering},
    Arc,
};
use std::thread;
use std::time::Duration;

use ringbuf::RingBuffer;
use rustfft::{num_complex::Complex, FftPlanner};

/// Number of positive-frequency bins exposed to the frontend (FFT_SIZE / 2).
pub const N_BINS: usize = 1024;

const FFT_SIZE: usize = 2048;
const HOP_SIZE: usize = 512; // 75 % overlap → ~4 updates per window at 48 kHz
const RING_CAPACITY: usize = FFT_SIZE * 8;
const SILENCE_DB: f32 = -90.0;

/// Atomic bin store shared between the analysis thread (writer) and the IPC
/// thread (reader). All accesses are `Relaxed` — spectral display tolerates
/// torn reads without consequence.
pub struct SpectrumBins {
    pub bins: Vec<AtomicU32>,
}

impl SpectrumBins {
    pub fn new() -> Self {
        Self {
            bins: (0..N_BINS)
                .map(|_| AtomicU32::new(SILENCE_DB.to_bits()))
                .collect(),
        }
    }

    /// Read all bins as dBFS. Called from the IPC thread.
    pub fn read(&self) -> Vec<f32> {
        self.bins
            .iter()
            .map(|a| f32::from_bits(a.load(Ordering::Relaxed)))
            .collect()
    }
}

impl Default for SpectrumBins {
    fn default() -> Self {
        Self::new()
    }
}

/// RT-safe sample sink. Push mono-mixed frames from the output callback.
/// Drops silently when the ring is full (acceptable for a display feature).
pub struct SpectrumTap {
    producer: ringbuf::Producer<f32>,
}

impl SpectrumTap {
    #[inline]
    pub fn push(&mut self, sample: f32) {
        let _ = self.producer.push(sample);
    }
}

/// Spawn the background FFT thread. The tap goes into the RT callback closure;
/// `bins` is shared with `MixerSharedMeters` so the IPC thread can read it.
pub fn spawn_thread(bins: Arc<SpectrumBins>, _sample_rate: u32) -> SpectrumTap {
    let ring = RingBuffer::<f32>::new(RING_CAPACITY);
    let (producer, consumer) = ring.split();
    thread::Builder::new()
        .name("spectrum-fft".into())
        .spawn(move || analysis_loop(consumer, bins))
        .expect("spawn spectrum-fft thread");
    SpectrumTap { producer }
}

fn analysis_loop(mut consumer: ringbuf::Consumer<f32>, bins: Arc<SpectrumBins>) {
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);

    // Precomputed Hann window.
    let hann: Vec<f32> = (0..FFT_SIZE)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / FFT_SIZE as f32).cos())
        .collect();

    // Circular sample buffer; write_pos advances mod FFT_SIZE.
    let mut buf = vec![0.0f32; FFT_SIZE];
    let mut write_pos: usize = 0;
    // Total samples consumed — fires FFT every HOP_SIZE samples once primed.
    let mut total: usize = 0;
    // Per-bin IIR smoothing state (dBFS).
    let mut smooth = vec![SILENCE_DB; N_BINS];

    loop {
        let mut consumed: usize = 0;

        while let Some(s) = consumer.pop() {
            buf[write_pos] = s;
            write_pos = (write_pos + 1) % FFT_SIZE;
            total = total.wrapping_add(1);
            consumed += 1;

            if total >= FFT_SIZE && total % HOP_SIZE == 0 {
                // Oldest sample sits at write_pos; walk forward to get time order.
                let mut fft_buf: Vec<Complex<f32>> = (0..FFT_SIZE)
                    .map(|i| {
                        let idx = (write_pos + i) % FFT_SIZE;
                        Complex {
                            re: buf[idx] * hann[i],
                            im: 0.0,
                        }
                    })
                    .collect();

                fft.process(&mut fft_buf);

                let scale = 1.0 / FFT_SIZE as f32;
                for i in 0..N_BINS {
                    let mag = fft_buf[i].norm() * scale;
                    let db = if mag > 1e-10 {
                        (20.0 * mag.log10()).max(SILENCE_DB)
                    } else {
                        SILENCE_DB
                    };
                    // Fast attack so loud transients appear immediately;
                    // slow decay so the display doesn't flicker.
                    let alpha = if db > smooth[i] { 0.7 } else { 0.15 };
                    smooth[i] = alpha * db + (1.0 - alpha) * smooth[i];
                    bins.bins[i].store(smooth[i].to_bits(), Ordering::Relaxed);
                }
            }
        }

        if consumed == 0 {
            thread::sleep(Duration::from_millis(5));
        }
    }
}
