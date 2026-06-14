// Kept as reference implementation. Not called in Phase 4+.
#![allow(dead_code)]

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::StreamConfig;
use ringbuf::RingBuffer;
use serde::Serialize;
use std::sync::mpsc;
use std::thread;

// ~85 ms at 48 kHz stereo. Absorbs WASAPI shared-mode jitter between
// independent input/output device clocks.
const RING_SIZE: usize = 16384;

#[derive(Debug, Serialize, Clone)]
pub struct EngineError {
    pub message: String,
}

// Blanket From<Display> works because EngineError itself does not implement
// Display, so From<EngineError> for EngineError never conflicts with From<T> for T.
impl<E: std::fmt::Display> From<E> for EngineError {
    fn from(e: E) -> Self {
        Self {
            message: e.to_string(),
        }
    }
}

// The engine thread owns the cpal::Stream handles (which are !Send on some
// platforms). PassthroughEngine only holds the stop channel, join handle,
// and metadata — all Send — so no unsafe is needed.
//
// JoinHandle<()>: Send but !Sync. AppState wraps this in Mutex<Option<...>>,
// and Mutex<T>: Sync only requires T: Send, so AppState: Send + Sync. ✓
pub struct PassthroughEngine {
    pub input_device_name: String,
    pub output_device_name: String,
    stop_tx: mpsc::SyncSender<()>,
    // Held so Drop can join — ensures WASAPI device handles are fully released
    // before the Mutex lock is dropped. Without joining, a rapid stop→start on
    // the same device races with the old stream close and can produce
    // BuildStreamError (device busy).
    thread: Option<thread::JoinHandle<()>>,
}

impl Drop for PassthroughEngine {
    fn drop(&mut self) {
        // Signal the engine thread to stop.
        let _ = self.stop_tx.send(());
        // Block until the thread exits and releases device handles.
        // Panics in the engine thread are silently discarded (no recovery possible here).
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

pub fn start(input_name: &str, output_name: &str) -> Result<PassthroughEngine, EngineError> {
    let input_name = input_name.to_string();
    let output_name = output_name.to_string();

    // result_tx: engine thread reports success or startup error once.
    let (result_tx, result_rx) = mpsc::channel::<Result<(), EngineError>>();
    // stop channel: bounded 1 so the send never blocks.
    let (stop_tx, stop_rx) = mpsc::sync_channel::<()>(1);

    let in_name = input_name.clone();
    let out_name = output_name.clone();

    let thread_handle = thread::spawn(move || {
        // All stream creation and destruction happens on this thread.
        let outcome: Result<_, EngineError> = (|| {
            let host = cpal::default_host();

            let input_device = host
                .input_devices()
                .map_err(|e| EngineError {
                    message: e.to_string(),
                })?
                .find(|d| d.name().ok().as_deref() == Some(in_name.as_str()))
                .ok_or_else(|| EngineError {
                    message: format!("Input device not found: {in_name}"),
                })?;

            let output_device = host
                .output_devices()
                .map_err(|e| EngineError {
                    message: e.to_string(),
                })?
                .find(|d| d.name().ok().as_deref() == Some(out_name.as_str()))
                .ok_or_else(|| EngineError {
                    message: format!("Output device not found: {out_name}"),
                })?;

            let in_cfg = input_device
                .default_input_config()
                .map_err(|e| EngineError {
                    message: e.to_string(),
                })?;
            let out_cfg = output_device
                .default_output_config()
                .map_err(|e| EngineError {
                    message: e.to_string(),
                })?;

            // v0.1: hard-fail on sample rate mismatch. User must set both devices
            // to the same rate (e.g. 48 kHz) in Windows Sound settings.
            if in_cfg.sample_rate() != out_cfg.sample_rate() {
                return Err(EngineError {
                    message: format!(
                        "Sample rate mismatch: input {} Hz vs output {} Hz. \
                         Set both devices to the same rate in Windows Sound settings.",
                        in_cfg.sample_rate().0,
                        out_cfg.sample_rate().0,
                    ),
                });
            }

            let in_channels = in_cfg.channels() as usize;
            let out_channels = out_cfg.channels() as usize;

            // Supported channel mappings: equal counts, or mono input → stereo output.
            let mono_to_stereo = in_channels == 1 && out_channels == 2;
            if !mono_to_stereo && in_channels != out_channels {
                return Err(EngineError {
                    message: format!(
                        "Unsupported channel mapping: {in_channels}ch → {out_channels}ch. \
                         Supported in v0.1: matching counts, or mono input to stereo output.",
                    ),
                });
            }

            let in_stream_cfg: StreamConfig = in_cfg.into();
            let out_stream_cfg: StreamConfig = out_cfg.into();

            let ring = RingBuffer::<f32>::new(RING_SIZE);
            let (mut producer, mut consumer) = ring.split();

            let input_stream = input_device
                .build_input_stream(
                    &in_stream_cfg,
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        for &s in data {
                            // Drop samples silently when the ring is full.
                            let _ = producer.push(s);
                        }
                    },
                    |e| eprintln!("[audio] input stream error: {e}"),
                    None,
                )
                .map_err(|e| EngineError {
                    message: e.to_string(),
                })?;

            let output_stream = output_device
                .build_output_stream(
                    &out_stream_cfg,
                    move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                        if mono_to_stereo {
                            // Duplicate each mono sample to L and R channels.
                            let mut i = 0;
                            while i + 1 < data.len() {
                                let s = consumer.pop().unwrap_or(0.0);
                                data[i] = s;
                                data[i + 1] = s;
                                i += 2;
                            }
                        } else {
                            for s in data.iter_mut() {
                                // Output silence on ring underrun rather than
                                // leaving the buffer uninitialised.
                                *s = consumer.pop().unwrap_or(0.0);
                            }
                        }
                    },
                    |e| eprintln!("[audio] output stream error: {e}"),
                    None,
                )
                .map_err(|e| EngineError {
                    message: e.to_string(),
                })?;

            input_stream.play().map_err(|e| EngineError {
                message: e.to_string(),
            })?;
            output_stream.play().map_err(|e| EngineError {
                message: e.to_string(),
            })?;

            Ok((input_stream, output_stream))
        })();

        match outcome {
            Ok((input_stream, output_stream)) => {
                let _ = result_tx.send(Ok(()));
                drop(result_tx); // close result channel promptly
                let _ = stop_rx.recv(); // block until stop signal
                drop(input_stream); // streams dropped on this thread
                drop(output_stream);
            }
            Err(e) => {
                let _ = result_tx.send(Err(e));
            }
        }
    });

    match result_rx.recv() {
        Ok(Ok(())) => Ok(PassthroughEngine {
            input_device_name: input_name,
            output_device_name: output_name,
            stop_tx,
            thread: Some(thread_handle),
        }),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(EngineError {
            message: "Audio engine thread exited unexpectedly during startup".to_string(),
        }),
    }
}
