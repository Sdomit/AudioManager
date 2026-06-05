use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::StreamConfig;
use ringbuf::RingBuffer;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;

use crate::audio::loopback::{self, LoopbackCapture};
use crate::audio::recorder::{ActiveTap, CallbackTapKind, TapCommand, MAX_ACTIVE_TAPS};
use crate::audio::source::InputSourceSpec;

// ~85 ms at 48 kHz stereo.
const RING_SIZE: usize = 16384;

/// Maximum simultaneous inputs the output callback can mix without heap allocation.
/// Enforced as a hard error in `start()` — no inputs are ever silently dropped.
pub const MAX_INPUTS: usize = 8;

/// Upper bound on `TapCommand`s drained per audio callback invocation.
/// Keeps worst-case command work per block deterministic when the IPC layer
/// bursts many `Add`/`Remove` messages. Excess commands stay queued and are
/// processed on subsequent callbacks.
const MAX_CMDS_PER_BLOCK: usize = 8;

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
    pub input_peak: AtomicU32, // f32 bits
}

pub struct MixerInputInfo {
    /// The input's `device_id` (canonical key). For loopback sources this is a
    /// synthetic id (`sys:default`, `proc:<pid>`); for devices it is the name.
    /// Kept named `device_name` so status readers that surface it are untouched.
    pub device_name: String,
    /// Channel count (1 or 2) as configured for the input stream.
    pub channels: u16,
}

/// Descriptor passed to `mixer::start` for each input.
pub struct MixerInput {
    /// Typed capture backend, derived from the `device_id` by the caller.
    pub source: InputSourceSpec,
    pub gain: f32,
    pub muted: bool,
}

struct MixerSharedMeters {
    output_peak: AtomicU32, // f32 bits
    clipped: AtomicBool,
    // Bus-level controls (Phase 8A). Applied post-sum, pre-clip so a hot bus
    // gain registers on the clip indicator. Atomic so the IPC thread can
    // update them without restarting the engine.
    bus_volume: AtomicU32, // f32 bits, default 1.0
    bus_muted: AtomicBool,
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
    meters: Arc<MixerSharedMeters>,
    /// Channel into the output callback. IPC sends `Add`/`Remove` to wire
    /// recording taps in/out without restarting the engine.
    pub tap_command_tx: mpsc::Sender<TapCommand>,
    /// Output channel count (1 or 2) — needed by the recorder so it can
    /// open a WAV file with a matching header.
    pub out_channels: u16,
    /// Engine sample rate. Inputs share this rate (validated at start).
    pub sample_rate: u32,
    stop_tx: mpsc::SyncSender<()>,
    thread: Option<thread::JoinHandle<()>>,
}

/// Info bubbled out of the audio thread on a successful start, so the
/// `MixerEngine` struct can carry stream-derived fields (sample rate,
/// channel counts) without re-querying the device.
struct StartInfo {
    out_channels: u16,
    sample_rate: u32,
    input_channels: Vec<u16>,
}

impl MixerEngine {
    /// True when this engine is running on the given output device.
    /// Used by set_route_gain to guard live atomic updates to the correct output bus.
    pub fn is_output_device(&self, output_id: &str) -> bool {
        self.output_device_name == output_id
    }

    /// Find an input by device name; returns (index, channels) or None.
    pub fn input_index(&self, device_name: &str) -> Option<(usize, u16)> {
        self.inputs
            .iter()
            .enumerate()
            .find(|(_, info)| info.device_name == device_name)
            .map(|(idx, info)| (idx, info.channels))
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

    /// Atomically update bus-level volume and mute. Lock-free; the audio
    /// thread reads these atomics once per output block.
    pub fn update_bus_volume(&self, volume: f32, muted: bool) {
        self.meters.bus_volume.store(volume.to_bits(), Ordering::Relaxed);
        self.meters.bus_muted.store(muted, Ordering::Relaxed);
    }

    /// Read current meters and reset them for the next polling interval.
    pub fn read_and_reset_meters(&self) -> (Vec<f32>, f32, bool) {
        let input_peaks = self
            .shared
            .iter()
            .map(|slot| take_peak(&slot.input_peak))
            .collect();
        let output_peak = take_peak(&self.meters.output_peak);
        let clipped = self.meters.clipped.swap(false, Ordering::Relaxed);
        (input_peaks, output_peak, clipped)
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

pub(crate) fn store_max(target: &AtomicU32, value: f32) {
    if !value.is_finite() || value <= 0.0 {
        return;
    }

    let next_bits = value.to_bits();
    let mut current_bits = target.load(Ordering::Relaxed);
    loop {
        if f32::from_bits(current_bits) >= value {
            return;
        }

        match target.compare_exchange_weak(
            current_bits,
            next_bits,
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            Ok(_) => return,
            Err(observed) => current_bits = observed,
        }
    }
}

fn take_peak(target: &AtomicU32) -> f32 {
    f32::from_bits(target.swap(0.0f32.to_bits(), Ordering::Relaxed))
}

pub fn start(
    output_name: &str,
    inputs: &[MixerInput],
    bus_volume: f32,
    bus_muted: bool,
) -> Result<MixerEngine, EngineError> {
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
    let input_specs: Vec<(InputSourceSpec, f32, bool)> =
        inputs.iter().map(|i| (i.source.clone(), i.gain, i.muted)).collect();

    let shared_slots: Vec<InputSlotShared> = input_specs
        .iter()
        .map(|(_, gain, muted)| InputSlotShared {
            gain: AtomicU32::new(gain.to_bits()),
            muted: AtomicBool::new(*muted),
            input_peak: AtomicU32::new(0.0f32.to_bits()),
        })
        .collect();
    let shared = Arc::new(shared_slots);
    let bus_volume = if bus_volume.is_finite() {
        bus_volume.clamp(0.0, 2.0)
    } else {
        1.0
    };
    let meters = Arc::new(MixerSharedMeters {
        output_peak: AtomicU32::new(0.0f32.to_bits()),
        clipped: AtomicBool::new(false),
        bus_volume: AtomicU32::new(bus_volume.to_bits()),
        bus_muted: AtomicBool::new(bus_muted),
    });

    let (result_tx, result_rx) = mpsc::channel::<Result<StartInfo, EngineError>>();
    let (stop_tx, stop_rx) = mpsc::sync_channel::<()>(1);
    let (tap_command_tx, tap_command_rx) = mpsc::channel::<TapCommand>();

    let shared_for_thread = Arc::clone(&shared);
    let meters_for_thread = Arc::clone(&meters);
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
            // Loopback capture threads (system / per-app). Held on the engine
            // thread so they drop — and join — alongside the cpal streams.
            let mut loopback_caps: Vec<LoopbackCapture> = Vec::new();
            // (Consumer<f32>, in_channels) — at most MAX_INPUTS entries (enforced above).
            let mut consumers: Vec<(ringbuf::Consumer<f32>, usize)> = Vec::new();
            let mut input_channels_meta: Vec<u16> = Vec::new();

            for (i, (source, _, _)) in in_specs.iter().enumerate() {
                match source {
                    InputSourceSpec::Device { name } => {
                        let in_name = name.as_str();
                        let input_device = host
                            .input_devices()?
                            .find(|d| d.name().ok().as_deref() == Some(in_name))
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
                        // Any combination of {1,2} × {1,2} is valid; > 2 is rejected.
                        if in_channels > 2 {
                            return Err(EngineError {
                                message: format!(
                                    "Unsupported channel mapping: input '{in_name}' has \
                                     {in_channels}ch, output '{out_name}' has {out_channels}ch. \
                                     Phase 4 supports mono/stereo only."
                                ),
                            });
                        }

                        let ring = RingBuffer::<f32>::new(RING_SIZE);
                        let (mut producer, consumer) = ring.split();
                        consumers.push((consumer, in_channels));
                        input_channels_meta.push(in_channels as u16);

                        let in_stream_cfg: StreamConfig = in_cfg.into();
                        let input_peak_slots = Arc::clone(&shared_for_thread);
                        let input_stream = input_device
                            .build_input_stream(
                                &in_stream_cfg,
                                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                                    let mut block_peak = 0.0f32;
                                    for &s in data {
                                        let abs = s.abs();
                                        if abs > block_peak {
                                            block_peak = abs;
                                        }
                                        let _ = producer.push(s);
                                    }
                                    store_max(&input_peak_slots[i].input_peak, block_peak);
                                },
                                move |e| eprintln!("[audio] input stream {i} error: {e}"),
                                None,
                            )
                            .map_err(|e| EngineError { message: e.to_string() })?;

                        input_streams.push(input_stream);
                    }

                    // Loopback sources fill the same source-blind ring from a
                    // WASAPI capture thread. `autoconvert` delivers stereo f32 at
                    // the bus rate, so there is no rate gate and no channel check.
                    InputSourceSpec::SystemLoopback => {
                        let ring = RingBuffer::<f32>::new(RING_SIZE);
                        let (producer, consumer) = ring.split();
                        let cap = loopback::start_system_loopback(
                            out_sample_rate.0,
                            producer,
                            Arc::clone(&shared_for_thread),
                            i,
                        )?;
                        consumers.push((consumer, loopback::LOOPBACK_CHANNELS as usize));
                        input_channels_meta.push(loopback::LOOPBACK_CHANNELS);
                        loopback_caps.push(cap);
                    }

                    InputSourceSpec::Process { pid, include_tree } => {
                        let ring = RingBuffer::<f32>::new(RING_SIZE);
                        let (producer, consumer) = ring.split();
                        let cap = loopback::start_process_loopback(
                            *pid,
                            *include_tree,
                            out_sample_rate.0,
                            producer,
                            Arc::clone(&shared_for_thread),
                            i,
                        )?;
                        consumers.push((consumer, loopback::LOOPBACK_CHANNELS as usize));
                        input_channels_meta.push(loopback::LOOPBACK_CHANNELS);
                        loopback_caps.push(cap);
                    }
                }
            }

            let slots = Arc::clone(&shared_for_thread);
            let shared_meters = Arc::clone(&meters_for_thread);

            // Pre-allocate the active-tap vec so the audio thread never
            // grows it during steady state. The capacity ceiling is
            // enforced when applying TapCommand::Add.
            let mut active_taps: Vec<ActiveTap> = Vec::with_capacity(MAX_ACTIVE_TAPS);
            let tap_rx = tap_command_rx;

            let output_stream = output_device
                .build_output_stream(
                    &out_stream_cfg,
                    move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                        // Drain at most MAX_CMDS_PER_BLOCK tap commands per block so
                        // a burst of Add/Remove can never blow the realtime budget.
                        // Leftovers stay queued for the next callback.
                        for _ in 0..MAX_CMDS_PER_BLOCK {
                            match tap_rx.try_recv() {
                                Ok(TapCommand::Add(t)) => {
                                    if active_taps.len() < MAX_ACTIVE_TAPS {
                                        active_taps.push(t);
                                    }
                                    // Silent drop above the cap is acceptable —
                                    // IPC layer should refuse far earlier.
                                }
                                Ok(TapCommand::Remove(id)) => {
                                    // swap_remove is O(1); tap order is irrelevant
                                    // because every per-frame fan-out iterates the
                                    // whole vec anyway.
                                    if let Some(pos) =
                                        active_taps.iter().position(|t| t.id == id)
                                    {
                                        active_taps.swap_remove(pos);
                                    }
                                }
                                Err(_) => break,
                            }
                        }

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

                        // Bus-level controls loaded once per block. Treat mute
                        // as bus_vol == 0 so the per-frame math stays branch-free.
                        let bus_muted_now =
                            shared_meters.bus_muted.load(Ordering::Relaxed);
                        let bus_vol = if bus_muted_now {
                            0.0
                        } else {
                            f32::from_bits(shared_meters.bus_volume.load(Ordering::Relaxed))
                        };

                        let frames =
                            if out_channels > 0 { data.len() / out_channels } else { 0 };
                        let mut block_output_peak = 0.0f32;
                        let mut block_clipped = false;

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

                                // Fan-out: InputPre / InputPost taps for input i.
                                if !active_taps.is_empty() {
                                    for tap in active_taps.iter_mut() {
                                        match tap.kind {
                                            CallbackTapKind::InputPre { input_index, channels }
                                                if input_index == i =>
                                            {
                                                tap.push(s0);
                                                if channels == 2 {
                                                    tap.push(s1);
                                                }
                                            }
                                            CallbackTapKind::InputPost { input_index, channels }
                                                if input_index == i =>
                                            {
                                                tap.push(s0 * g);
                                                if channels == 2 {
                                                    tap.push(s1 * g);
                                                }
                                            }
                                            _ => {}
                                        }
                                    }
                                }

                                match (in_ch, out_channels) {
                                    (1, 1) => mix[0] += s0 * g,
                                    (1, 2) => { mix[0] += s0 * g; mix[1] += s0 * g; }
                                    (2, 1) => mix[0] += (s0 + s1) * 0.5 * g,
                                    (2, 2) => { mix[0] += s0 * g; mix[1] += s1 * g; }
                                    _ => {} // unreachable — validated above
                                }
                            }

                            // Apply bus gain post-sum, pre-clip, fan-out BusOut taps.
                            let mut clamped_frame = [0.0f32; 2];
                            for ch in 0..out_channels {
                                let raw = mix[ch] * bus_vol;
                                if raw < -1.0 || raw > 1.0 {
                                    block_clipped = true;
                                }
                                let clamped = raw.clamp(-1.0, 1.0);
                                let abs = clamped.abs();
                                if abs > block_output_peak {
                                    block_output_peak = abs;
                                }
                                data[f * out_channels + ch] = clamped;
                                clamped_frame[ch] = clamped;
                            }

                            if !active_taps.is_empty() {
                                for tap in active_taps.iter_mut() {
                                    if matches!(tap.kind, CallbackTapKind::BusOut) {
                                        for ch in 0..out_channels {
                                            tap.push(clamped_frame[ch]);
                                        }
                                    }
                                }
                            }
                        }

                        store_max(&shared_meters.output_peak, block_output_peak);
                        if block_clipped {
                            shared_meters.clipped.store(true, Ordering::Relaxed);
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

            Ok((
                input_streams,
                loopback_caps,
                output_stream,
                StartInfo {
                    out_channels: out_channels as u16,
                    sample_rate: out_sample_rate.0,
                    input_channels: input_channels_meta,
                },
            ))
        })();

        match outcome {
            Ok((input_streams, loopback_caps, output_stream, info)) => {
                let _ = result_tx.send(Ok(info));
                drop(result_tx);
                let _ = stop_rx.recv();
                // Stop the realtime callback first, then drop the producers:
                // cpal streams and loopback capture threads release their
                // WASAPI handles on this thread (loopback joins its threads).
                drop(output_stream);
                drop(input_streams);
                drop(loopback_caps);
            }
            Err(e) => {
                let _ = result_tx.send(Err(e));
            }
        }
    });

    match result_rx.recv() {
        Ok(Ok(info)) => Ok(MixerEngine {
            output_device_name: output_name,
            inputs: input_specs
                .into_iter()
                .zip(info.input_channels.iter().copied())
                .map(|((source, _, _), channels)| MixerInputInfo {
                    device_name: source.to_id(),
                    channels,
                })
                .collect(),
            shared,
            meters,
            tap_command_tx,
            out_channels: info.out_channels,
            sample_rate: info.sample_rate,
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
                source: InputSourceSpec::Device { name: format!("fake_device_{i}") },
                gain: 1.0,
                muted: false,
            })
            .collect()
    }

    fn test_engine(input_peaks: &[f32], output_peak: f32, clipped: bool) -> MixerEngine {
        let (stop_tx, _stop_rx) = mpsc::sync_channel::<()>(1);
        let (tap_tx, _tap_rx) = mpsc::channel::<TapCommand>();
        let shared = input_peaks
            .iter()
            .map(|peak| InputSlotShared {
                gain: AtomicU32::new(1.0f32.to_bits()),
                muted: AtomicBool::new(false),
                input_peak: AtomicU32::new(peak.to_bits()),
            })
            .collect();
        MixerEngine {
            output_device_name: "Speakers (Realtek)".to_string(),
            inputs: input_peaks
                .iter()
                .enumerate()
                .map(|(i, _)| MixerInputInfo {
                    device_name: format!("fake_device_{i}"),
                    channels: 2,
                })
                .collect(),
            shared: Arc::new(shared),
            meters: Arc::new(MixerSharedMeters {
                output_peak: AtomicU32::new(output_peak.to_bits()),
                clipped: AtomicBool::new(clipped),
                bus_volume: AtomicU32::new(1.0f32.to_bits()),
                bus_muted: AtomicBool::new(false),
            }),
            tap_command_tx: tap_tx,
            out_channels: 2,
            sample_rate: 48000,
            stop_tx,
            thread: None,
        }
    }

    #[test]
    fn start_rejects_empty_inputs() {
        let result = start("fake_output", &[], 1.0, false);
        assert!(result.is_err());
        assert!(result.err().unwrap().message.contains("No inputs"));
    }

    #[test]
    fn start_rejects_more_than_max_inputs() {
        // MAX_INPUTS + 1 inputs — must fail before any CPAL call.
        let inputs = fake_inputs(MAX_INPUTS + 1);
        let result = start("fake_output", &inputs, 1.0, false);
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
        let result = start("fake_output", &inputs, 1.0, false);
        assert!(result.is_err());
        let msg = result.err().unwrap().message;
        // Must NOT be the limit error — should be a device-not-found error.
        assert!(
            !msg.contains("active inputs"),
            "Should have passed the limit check but failed on device lookup: {msg}"
        );
    }

    #[test]
    fn update_bus_volume_stores_atomically() {
        let engine = test_engine(&[0.1], 0.0, false);
        engine.update_bus_volume(0.25, true);
        let stored_vol =
            f32::from_bits(engine.meters.bus_volume.load(Ordering::Relaxed));
        let stored_muted = engine.meters.bus_muted.load(Ordering::Relaxed);
        assert!((stored_vol - 0.25).abs() < f32::EPSILON);
        assert!(stored_muted);
    }

    #[test]
    fn is_output_device_matches_correctly() {
        let engine = test_engine(&[], 0.0, false);
        assert!(engine.is_output_device("Speakers (Realtek)"));
        assert!(!engine.is_output_device("Headphones (USB)"));
    }

    #[test]
    fn input_index_finds_by_name() {
        let engine = test_engine(&[0.1, 0.2], 0.0, false);
        let (idx, channels) = engine.input_index("fake_device_1").unwrap();
        assert_eq!(idx, 1);
        assert_eq!(channels, 2);
        assert!(engine.input_index("missing").is_none());
    }

    #[test]
    fn store_max_keeps_highest_value() {
        let peak = AtomicU32::new(0.0f32.to_bits());
        store_max(&peak, 0.25);
        store_max(&peak, 0.8);
        store_max(&peak, 0.5);
        assert!((f32::from_bits(peak.load(Ordering::Relaxed)) - 0.8).abs() < f32::EPSILON);
    }

    #[test]
    fn read_and_reset_meters_returns_zero_after_second_read() {
        let engine = test_engine(&[0.35, 0.7], 0.9, true);

        let (input_peaks, output_peak, clipped) = engine.read_and_reset_meters();
        assert_eq!(input_peaks.len(), 2);
        assert!((input_peaks[0] - 0.35).abs() < f32::EPSILON);
        assert!((input_peaks[1] - 0.7).abs() < f32::EPSILON);
        assert!((output_peak - 0.9).abs() < f32::EPSILON);
        assert!(clipped);

        let (input_peaks2, output_peak2, clipped2) = engine.read_and_reset_meters();
        assert_eq!(input_peaks2, vec![0.0, 0.0]);
        assert_eq!(output_peak2, 0.0);
        assert!(!clipped2);
    }
}
