use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::StreamConfig;
use ringbuf::RingBuffer;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;

// ~85 ms at 48 kHz stereo.
const RING_SIZE: usize = 16384;

/// Maximum simultaneous inputs the output callback can mix without heap allocation.
/// Enforced as a hard error in `start()` — no inputs are ever silently dropped.
pub const MAX_INPUTS: usize = 8;

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
    pub gain: AtomicU32, // f32 bits
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
    /// True when this engine is running on the given output device.
    /// Used by set_route_gain to guard live atomic updates to the correct output bus.
    pub fn is_output_device(&self, output_id: &str) -> bool {
        self.output_device_name == output_id
    }

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

    // Enforce the limit before creating any streams — never silently drop inputs.
    if inputs.len() > MAX_INPUTS {
        return Err(EngineError {
            message: format!(
                "Phase 4 supports up to {MAX_INPUTS} active inputs. \
                 Disable another input before enabling this route."
            ),
        });
    }

    let output_name = output_name.to_string();
    let input_specs: Vec<(String, f32, bool)> =
        inputs.iter().map(|i| (i.device_name.clone(), i.gain, i.muted)).collect();

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

            // Phase 4 supports mono (1ch) and stereo (2ch) output only.
            if out_channels > 2 {
                return Err(EngineError {
                    message: format!(
                        "Unsupported output channel count: '{out_name}' has {out_channels}ch. \
                         Phase 4 supports mono/stereo only."
                    ),
                });
            }

            let out_stream_cfg: StreamConfig = out_cfg.into();

            let mut input_streams = Vec::new();
            // (Consumer<f32>, in_channels) — at most MAX_INPUTS entries (enforced above).
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

                // Phase 4 supports only mono (1ch) and stereo (2ch) inputs.
                // Any combination of {1,2} × {1,2} is valid; anything > 2 is rejected.
                if in_channels > 2 {
                    return Err(EngineError {
                        message: format!(
                            "Unsupported channel mapping: input '{in_name}' has {in_channels}ch, \
                             output '{out_name}' has {out_channels}ch. \
                             Phase 4 supports mono/stereo only."
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
                        // n == slots.len() <= MAX_INPUTS (enforced at start).
                        let n = slots.len();
                        let mut gains = [0.0f32; MAX_INPUTS];
                        let mut muted = [false; MAX_INPUTS];
                        for i in 0..n {
                            gains[i] =
                                f32::from_bits(slots[i].gain.load(Ordering::Relaxed));
                            muted[i] = slots[i].muted.load(Ordering::Relaxed);
                        }

                        let frames =
                            if out_channels > 0 { data.len() / out_channels } else { 0 };

                        for f in 0..frames {
                            // Stack-allocated accumulator. out_channels is 1 or 2
                            // (validated before stream creation).
                            let mut mix = [0.0f32; 2];

                            for i in 0..n {
                                // When muted, gain is 0 — ring still drains to prevent overflow.
                                let g = if muted[i] { 0.0 } else { gains[i] };
                                let in_ch = consumers[i].1; // 1 or 2 (validated)

                                // Read one input frame. in_ch is 1 or 2.
                                let s0 = consumers[i].0.pop().unwrap_or(0.0);
                                let s1 =
                                    if in_ch == 2 { consumers[i].0.pop().unwrap_or(0.0) } else { s0 };

                                match (in_ch, out_channels) {
                                    (1, 1) => mix[0] += s0 * g,
                                    (1, 2) => { mix[0] += s0 * g; mix[1] += s0 * g; }
                                    (2, 1) => mix[0] += (s0 + s1) * 0.5 * g,
                                    (2, 2) => { mix[0] += s0 * g; mix[1] += s1 * g; }
                                    _ => {} // unreachable — validated above
                                }
                            }

                            for ch in 0..out_channels {
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

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_inputs(n: usize) -> Vec<MixerInput> {
        (0..n)
            .map(|i| MixerInput {
                device_name: format!("fake_device_{i}"),
                gain: 1.0,
                muted: false,
            })
            .collect()
    }

    #[test]
    fn start_rejects_empty_inputs() {
        let result = start("fake_output", &[]);
        assert!(result.is_err());
        assert!(result.err().unwrap().message.contains("No inputs"));
    }

    #[test]
    fn start_rejects_more_than_max_inputs() {
        // MAX_INPUTS + 1 inputs — must fail before any CPAL call.
        let inputs = fake_inputs(MAX_INPUTS + 1);
        let result = start("fake_output", &inputs);
        assert!(result.is_err());
        let msg = result.err().unwrap().message;
        assert!(
            msg.contains(&MAX_INPUTS.to_string()),
            "Error should mention the limit ({MAX_INPUTS}): {msg}"
        );
    }

    #[test]
    fn start_exactly_max_inputs_reaches_cpal_not_limit_error() {
        // MAX_INPUTS inputs must pass the limit check and fail on the CPAL
        // device lookup ("fake_output" not found), not on the limit guard.
        let inputs = fake_inputs(MAX_INPUTS);
        let result = start("fake_output", &inputs);
        assert!(result.is_err());
        let msg = result.err().unwrap().message;
        // Must NOT be the limit error — should be a device-not-found error.
        assert!(
            !msg.contains("active inputs"),
            "Should have passed the limit check but failed on device lookup: {msg}"
        );
    }

    #[test]
    fn is_output_device_matches_correctly() {
        // Build a minimal MixerEngine struct manually — no CPAL involved.
        let (stop_tx, _stop_rx) = mpsc::sync_channel::<()>(1);
        let engine = MixerEngine {
            output_device_name: "Speakers (Realtek)".to_string(),
            inputs: vec![],
            shared: Arc::new(vec![]),
            stop_tx,
            thread: None,
        };
        assert!(engine.is_output_device("Speakers (Realtek)"));
        assert!(!engine.is_output_device("Headphones (USB)"));
    }
}
