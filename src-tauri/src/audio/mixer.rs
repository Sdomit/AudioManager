use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::StreamConfig;
use ringbuf::RingBuffer;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;

// ~85 ms at 48 kHz stereo.
const RING_SIZE: usize = 16384;

// Maximum simultaneous inputs handled in the audio callback without heap alloc.
const MAX_INPUTS: usize = 8;

#[derive(Debug, Serialize, Clone)]
pub struct EngineError {
    pub message: String,
}

impl<E: std::fmt::Display> From<E> for EngineError {
    fn from(e: E) -> Self {
        Self { message: e.to_string() }
    }
}

/// Per-input gain and mute, shared between the IPC thread and audio callbacks.
/// Atomics are read with Relaxed ordering inside callbacks — the slight race
/// on gain transitions is inaudible and preferable to a lock.
pub struct InputSlotShared {
    pub gain: AtomicU32,  // f32 bits
    pub muted: AtomicBool,
}

pub struct MixerInputInfo {
    pub device_name: String,
}

/// Descriptor passed to `mixer::start` for each input.
pub struct MixerInput {
    pub device_name: String,
    pub gain: f32,
    pub muted: bool,
}

/// Live handle to a running mixer engine.
///
/// Dropping this value signals the engine thread to stop and joins it,
/// ensuring WASAPI device handles are fully released before the lock is
/// returned to the caller.
pub struct MixerEngine {
    pub output_device_name: String,
    /// Ordered list of active inputs (same order as `shared` slots).
    pub inputs: Vec<MixerInputInfo>,
    /// Shared atomics; index i corresponds to `inputs[i]`.
    pub shared: Arc<Vec<InputSlotShared>>,
    stop_tx: mpsc::SyncSender<()>,
    thread: Option<thread::JoinHandle<()>>,
}

impl MixerEngine {
    /// Update gain/mute for one input without restarting the engine.
    /// No-op if the device is not in this engine's input list.
    pub fn update_gain(&self, device_name: &str, volume: f32, muted: bool) {
        if let Some(idx) = self.inputs.iter().position(|i| i.device_name == device_name) {
            if let Some(slot) = self.shared.get(idx) {
                slot.gain.store(volume.to_bits(), Ordering::Relaxed);
                slot.muted.store(muted, Ordering::Relaxed);
            }
        }
    }
}

impl Drop for MixerEngine {
    fn drop(&mut self) {
        let _ = self.stop_tx.send(());
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

pub fn start(output_name: &str, inputs: &[MixerInput]) -> Result<MixerEngine, EngineError> {
    if inputs.is_empty() {
        return Err(EngineError { message: "No inputs provided to mixer".to_string() });
    }

    let output_name = output_name.to_string();
    // (device_name, initial_gain, initial_muted)
    let input_specs: Vec<(String, f32, bool)> =
        inputs.iter().map(|i| (i.device_name.clone(), i.gain, i.muted)).collect();

    // Build shared atomic slots with initial values.
    let shared_slots: Vec<InputSlotShared> = input_specs
        .iter()
        .map(|(_, gain, muted)| InputSlotShared {
            gain: AtomicU32::new(gain.to_bits()),
            muted: AtomicBool::new(*muted),
        })
        .collect();
    let shared = Arc::new(shared_slots);

    let (result_tx, result_rx) = mpsc::channel::<Result<(), EngineError>>();
    let (stop_tx, stop_rx) = mpsc::sync_channel::<()>(1);

    let shared_for_thread = Arc::clone(&shared);
    let out_name = output_name.clone();
    let in_specs = input_specs.clone();

    let thread_handle = thread::spawn(move || {
        let outcome: Result<_, EngineError> = (|| {
            let host = cpal::default_host();

            let output_device = host
                .output_devices()?
                .find(|d| d.name().ok().as_deref() == Some(out_name.as_str()))
                .ok_or_else(|| EngineError {
                    message: format!("Output device not found: {out_name}"),
                })?;

            let out_cfg = output_device.default_output_config()?;
            let out_sample_rate = out_cfg.sample_rate();
            let out_channels = out_cfg.channels() as usize;
            let out_stream_cfg: StreamConfig = out_cfg.into();

            // One ring + one input stream per input device.
            let mut input_streams = Vec::new();
            // (Consumer<f32>, in_channels)
            let mut consumers: Vec<(ringbuf::Consumer<f32>, usize)> = Vec::new();

            for (i, (in_name, _, _)) in in_specs.iter().enumerate() {
                let input_device = host
                    .input_devices()?
                    .find(|d| d.name().ok().as_deref() == Some(in_name.as_str()))
                    .ok_or_else(|| EngineError {
                        message: format!("Input device not found: {in_name}"),
                    })?;

                let in_cfg = input_device.default_input_config()?;

                if in_cfg.sample_rate() != out_sample_rate {
                    return Err(EngineError {
                        message: format!(
                            "Sample rate mismatch: input '{in_name}' @ {} Hz vs output \
                             '{out_name}' @ {} Hz. Set both devices to the same rate in \
                             Windows Sound settings.",
                            in_cfg.sample_rate().0,
                            out_sample_rate.0
                        ),
                    });
                }

                let in_channels = in_cfg.channels() as usize;
                let mono_to_stereo = in_channels == 1 && out_channels == 2;
                let stereo_to_mono = in_channels == 2 && out_channels == 1;
                let equal_channels = in_channels == out_channels;

                if !mono_to_stereo && !stereo_to_mono && !equal_channels {
                    return Err(EngineError {
                        message: format!(
                            "Unsupported channel mapping for input '{in_name}': \
                             {in_channels}ch → {out_channels}ch. Supported: matching \
                             counts, mono→stereo, stereo→mono.",
                        ),
                    });
                }

                let ring = RingBuffer::<f32>::new(RING_SIZE);
                let (mut producer, consumer) = ring.split();
                consumers.push((consumer, in_channels));

                let in_stream_cfg: StreamConfig = in_cfg.into();
                let input_stream = input_device
                    .build_input_stream(
                        &in_stream_cfg,
                        move |data: &[f32], _: &cpal::InputCallbackInfo| {
                            for &s in data {
                                let _ = producer.push(s);
                            }
                        },
                        move |e| eprintln!("[audio] input stream {i} error: {e}"),
                        None,
                    )
                    .map_err(|e| EngineError { message: e.to_string() })?;

                input_streams.push(input_stream);
            }

            let slots = Arc::clone(&shared_for_thread);

            let output_stream = output_device
                .build_output_stream(
                    &out_stream_cfg,
                    move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                        // Load atomics once per block, not per sample.
                        // Slot count capped at MAX_INPUTS; excess inputs are silently ignored
                        // (unenforced at Phase 4 — start() rejects > MAX_INPUTS inputs upstream
                        // if needed, but we don't today since 8 is plenty).
                        let n = slots.len().min(MAX_INPUTS);
                        let mut gains = [0.0f32; MAX_INPUTS];
                        let mut muted = [false; MAX_INPUTS];
                        for i in 0..n {
                            gains[i] =
                                f32::from_bits(slots[i].gain.load(Ordering::Relaxed));
                            muted[i] = slots[i].muted.load(Ordering::Relaxed);
                        }

                        let frames = if out_channels > 0 { data.len() / out_channels } else { 0 };

                        for f in 0..frames {
                            // Stack-allocated mix accumulator (up to 8 channels).
                            let mut mix = [0.0f32; MAX_INPUTS];

                            for i in 0..n {
                                // When muted, gain is 0 — ring still drains normally.
                                let g = if muted[i] { 0.0 } else { gains[i] };
                                let in_ch = consumers[i].1;

                                // Read one full input frame from ring.
                                let mut in_frame = [0.0f32; MAX_INPUTS];
                                for ch in 0..in_ch.min(MAX_INPUTS) {
                                    in_frame[ch] = consumers[i].0.pop().unwrap_or(0.0);
                                }

                                // Accumulate into output channels.
                                for out_ch in 0..out_channels.min(MAX_INPUTS) {
                                    let s = if in_ch == 1 {
                                        // mono → all output channels
                                        in_frame[0]
                                    } else if out_channels == 1 && in_ch == 2 {
                                        // stereo → mono downmix
                                        (in_frame[0] + in_frame[1]) * 0.5
                                    } else {
                                        // equal or >= 3 ch equal: direct channel mapping
                                        in_frame[out_ch]
                                    };
                                    mix[out_ch] += s * g;
                                }
                            }

                            for ch in 0..out_channels.min(MAX_INPUTS) {
                                data[f * out_channels + ch] = mix[ch].clamp(-1.0, 1.0);
                            }
                        }
                    },
                    |e| eprintln!("[audio] output stream error: {e}"),
                    None,
                )
                .map_err(|e| EngineError { message: e.to_string() })?;

            for stream in &input_streams {
                stream.play().map_err(|e| EngineError { message: e.to_string() })?;
            }
            output_stream.play().map_err(|e| EngineError { message: e.to_string() })?;

            Ok((input_streams, output_stream))
        })();

        match outcome {
            Ok((input_streams, output_stream)) => {
                let _ = result_tx.send(Ok(()));
                drop(result_tx);
                let _ = stop_rx.recv();
                // Streams dropped on this thread — WASAPI handles released here.
                drop(input_streams);
                drop(output_stream);
            }
            Err(e) => {
                let _ = result_tx.send(Err(e));
            }
        }
    });

    match result_rx.recv() {
        Ok(Ok(())) => Ok(MixerEngine {
            output_device_name: output_name,
            inputs: input_specs
                .into_iter()
                .map(|(name, _, _)| MixerInputInfo { device_name: name })
                .collect(),
            shared,
            stop_tx,
            thread: Some(thread_handle),
        }),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(EngineError {
            message: "Audio engine thread exited unexpectedly during startup".to_string(),
        }),
    }
}
