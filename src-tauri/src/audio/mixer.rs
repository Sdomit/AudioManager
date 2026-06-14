use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::StreamConfig;
use ringbuf::RingBuffer;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;

use crate::audio::dsp::{
    live::{enable_flush_denormals, BusDspShared, BusDspSlots, InputDspShared, InputDspSlots},
    BusDspConfig, DspConfig,
};
use crate::audio::loopback::{self, Subscription};
use crate::audio::meters::{verdict_for, LoudnessSnapshot, StreamAnalyzer, SILENCE_FLOOR_DB};
use crate::audio::recorder::{ActiveTap, CallbackTapKind, TapCommand, MAX_ACTIVE_TAPS};
use crate::audio::remote::{self, RemoteSubscription};
use crate::audio::source::InputSourceSpec;

// ~85 ms at 48 kHz stereo.
const RING_SIZE: usize = 16384;

/// Target input-ring backlog (ms, per channel) the mixer trims toward when it
/// must resync a drifted ring. A healthy buffer against jitter while keeping
/// latency low.
const TARGET_LATENCY_MS: f32 = 30.0;

/// High-water backlog (ms, per channel). Only when an input's post-read backlog
/// would exceed this does the mixer discard samples to catch up — so steady-
/// state playback is never trimmed and only sustained drift triggers a resync.
const MAX_LATENCY_MS: f32 = 80.0;

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
        Self {
            message: e.to_string(),
        }
    }
}

/// Per-input gain and mute, shared between the IPC thread and audio callbacks.
/// Atomics are read with Relaxed ordering inside callbacks — the slight race
/// on gain transitions is inaudible and preferable to a lock.
pub struct InputSlotShared {
    pub gain: AtomicU32, // f32 bits
    pub muted: AtomicBool,
    pub input_peak: AtomicU32, // f32 bits
    /// Dropout telemetry. `overrun` counts samples lost on the producer side —
    /// either the ring was full when the capture/input callback tried to push,
    /// or the mixer trimmed a drifted ring to bound latency (resync). `underrun`
    /// counts samples zero-filled when the ring was empty at the consumer (mixer
    /// outran capture). Both accumulate as plain sample counts and reset to 0 on
    /// each meter poll (`read_and_reset_xruns`).
    pub overrun: AtomicU32,
    pub underrun: AtomicU32,
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
    /// Initial DSP config seeded into `InputDspShared` when the engine starts.
    /// Defaults to a fully-bypassed chain when omitted (preset/test callers).
    pub dsp: DspConfig,
}

struct MixerSharedMeters {
    output_peak: AtomicU32, // f32 bits
    clipped: AtomicBool,
    // Bus-level controls (Phase 8A). Applied post-sum, pre-clip so a hot bus
    // gain registers on the clip indicator. Atomic so the IPC thread can
    // update them without restarting the engine.
    bus_volume: AtomicU32, // f32 bits, default 1.0
    bus_muted: AtomicBool,
    // Streaming loudness meters (#38). Published once per output block by the
    // analyzer in the callback; read+formatted by the IPC thread. rms/lufs are
    // dBFS/LUFS (f32 bits); true_peak is the linear inter-sample max over the
    // analyzer's 400 ms window (plain store/load — multi-reader safe).
    rms_db: AtomicU32,         // f32 bits, dBFS
    lufs_momentary: AtomicU32, // f32 bits, LUFS
    lufs_short: AtomicU32,     // f32 bits, LUFS
    true_peak: AtomicU32,      // f32 bits, linear
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
    /// Per-input DSP seqlock blocks. IPC calls `publish()` on these to update
    /// parameters live; the audio callback calls `reload_if_changed()`.
    pub dsp_shared: Vec<Arc<InputDspShared>>,
    /// Bus DSP seqlock block (final limiter). Live-updatable, same as inputs.
    pub bus_dsp_shared: Arc<BusDspShared>,
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
    /// IPC-writable DSP shared blocks, one per input, seeded at engine start.
    /// Sent back to the main thread so `MixerEngine::update_input_dsp` can
    /// publish live parameter changes without restarting the engine.
    dsp_shared: Vec<Arc<InputDspShared>>,
    /// IPC-writable bus DSP shared block (limiter). Live-updatable like inputs.
    bus_dsp_shared: Arc<BusDspShared>,
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
        if let Some(idx) = self
            .inputs
            .iter()
            .position(|i| i.device_name == device_name)
        {
            if let Some(slot) = self.shared.get(idx) {
                slot.gain.store(volume.to_bits(), Ordering::Relaxed);
                slot.muted.store(muted, Ordering::Relaxed);
            }
        }
    }

    /// Atomically update bus-level volume and mute. Lock-free; the audio
    /// thread reads these atomics once per output block.
    pub fn update_bus_volume(&self, volume: f32, muted: bool) {
        self.meters
            .bus_volume
            .store(volume.to_bits(), Ordering::Relaxed);
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

    /// Read the streaming loudness snapshot (#38). Pure loads — all four
    /// values are windowed maxima/means republished by the callback, so any
    /// number of pollers can read concurrently. (An earlier drain-on-read
    /// true peak raced the meter poll against the state poll: one reader
    /// stole the accumulator and the other displayed -inf mid-signal.)
    pub fn read_loudness(&self) -> LoudnessSnapshot {
        let rms_db = f32::from_bits(self.meters.rms_db.load(Ordering::Relaxed));
        let lufs_momentary = f32::from_bits(self.meters.lufs_momentary.load(Ordering::Relaxed));
        let lufs_short = f32::from_bits(self.meters.lufs_short.load(Ordering::Relaxed));
        let tp_lin = f32::from_bits(self.meters.true_peak.load(Ordering::Relaxed));
        let true_peak_db = if tp_lin <= 1e-9 {
            SILENCE_FLOOR_DB
        } else {
            (20.0 * tp_lin.log10()).max(SILENCE_FLOOR_DB)
        };
        LoudnessSnapshot {
            rms_db,
            lufs_momentary,
            lufs_short,
            true_peak_db,
            verdict: verdict_for(lufs_short, true_peak_db),
        }
    }

    /// Publish new DSP parameters for input at `index`. Lock-free: the audio
    /// callback picks up the change on its next block via `reload_if_changed`.
    /// No-op if `index` is out of range (engine may have fewer inputs).
    pub fn update_input_dsp(&self, index: usize, cfg: &DspConfig) {
        if let Some(shared) = self.dsp_shared.get(index) {
            shared.publish(cfg, self.sample_rate as f32);
        }
    }

    /// Publish new bus DSP (limiter) parameters. Lock-free; applied on the
    /// audio callback's next block via `reload_if_changed`.
    pub fn update_bus_dsp(&self, cfg: &BusDspConfig) {
        self.bus_dsp_shared.publish(cfg, self.sample_rate as f32);
    }

    /// Read and reset the dropout counters, aggregated across all inputs.
    /// Returns `(underrun_samples, overrun_samples)` since the last poll.
    /// Sustained nonzero values mean the buffer is too small or the input and
    /// output clocks are drifting (see #35/#36).
    pub fn read_and_reset_xruns(&self) -> (u64, u64) {
        let mut underrun = 0u64;
        let mut overrun = 0u64;
        for slot in self.shared.iter() {
            underrun += slot.underrun.swap(0, Ordering::Relaxed) as u64;
            overrun += slot.overrun.swap(0, Ordering::Relaxed) as u64;
        }
        (underrun, overrun)
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

/// Decide how many samples to discard from an input ring before reading this
/// block, to bound latency. `fill` is the ring's current sample count, `need`
/// is what this block will pop. Returns 0 unless the post-read backlog would
/// exceed `max_backlog`, in which case it trims toward `target_backlog` (both in
/// samples). Pure so the resync policy is unit-tested without running streams.
#[inline]
fn resync_drop(fill: usize, need: usize, target_backlog: usize, max_backlog: usize) -> usize {
    let post_read = fill.saturating_sub(need);
    if post_read > max_backlog {
        post_read - target_backlog
    } else {
        0
    }
}

/// Read one interleaved frame from a pre-drained input scratch buffer, returning
/// `(left, right)` (right mirrors left for mono). `avail_frames` is how many
/// whole frames were actually drained into `scratch` this block; index `f` at or
/// beyond it returns silence `(0.0, 0.0)` — the same degradation as a ring
/// underrun. This bounds the read so an output block larger than the scratch /
/// ring capacity (a driver-chosen period on the `None` buffer path can exceed
/// `RING_SIZE`) can never index past `scratch` and panic the audio thread. Pure
/// so the bound is unit-tested without running a stream.
#[inline]
fn read_scratch_frame(scratch: &[f32], f: usize, in_ch: usize, avail_frames: usize) -> (f32, f32) {
    if f < avail_frames {
        let base = f * in_ch;
        let s0 = scratch[base];
        let s1 = if in_ch == 2 { scratch[base + 1] } else { s0 };
        (s0, s1)
    } else {
        (0.0, 0.0)
    }
}

/// Per-input ring capacity (in f32 samples) for the given output rate and
/// callback buffer. Sized to hold the maximum backlog the resync trim allows
/// (`MAX_LATENCY_MS`) plus a few callback blocks of jitter headroom, ×2 for
/// stereo. Floored at `RING_SIZE` so the default (driver-chosen buffer) path is
/// byte-for-byte unchanged; grows for large fixed buffers so one big device
/// block can never overrun the ring (and thus stays within `pop_slice` scratch).
fn ring_size_for(out_rate: u32, buffer_frames: Option<u32>) -> usize {
    let max_backlog_frames = (MAX_LATENCY_MS / 1000.0 * out_rate as f32) as usize;
    let block_frames = buffer_frames.map(|f| f as usize).unwrap_or(1024);
    let frames = max_backlog_frames + block_frames.max(512) * 3;
    (frames * 2).max(RING_SIZE)
}

/// Optional fixed output-buffer size in frames. `None` lets the driver
/// choose (CPAL `BufferSize::Default`). A fixed size such as 128 or 256
/// sets a lower, more deterministic callback period at the cost of higher
/// CPU overhead and potential glitching on slow machines (#35).
pub fn start(
    output_name: &str,
    inputs: &[MixerInput],
    bus_volume: f32,
    bus_muted: bool,
    bus_dsp: BusDspConfig,
    buffer_size_frames: Option<u32>,
) -> Result<MixerEngine, EngineError> {
    if inputs.is_empty() {
        return Err(EngineError {
            message: "No inputs provided to mixer".to_string(),
        });
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
    let input_specs: Vec<(InputSourceSpec, f32, bool, DspConfig)> = inputs
        .iter()
        .map(|i| (i.source.clone(), i.gain, i.muted, i.dsp.clone()))
        .collect();

    let shared_slots: Vec<InputSlotShared> = input_specs
        .iter()
        .map(|(_, gain, muted, _)| InputSlotShared {
            gain: AtomicU32::new(gain.to_bits()),
            muted: AtomicBool::new(*muted),
            input_peak: AtomicU32::new(0.0f32.to_bits()),
            overrun: AtomicU32::new(0),
            underrun: AtomicU32::new(0),
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
        rms_db: AtomicU32::new(SILENCE_FLOOR_DB.to_bits()),
        lufs_momentary: AtomicU32::new(SILENCE_FLOOR_DB.to_bits()),
        lufs_short: AtomicU32::new(SILENCE_FLOOR_DB.to_bits()),
        true_peak: AtomicU32::new(0.0f32.to_bits()),
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

            let mut out_stream_cfg: StreamConfig = out_cfg.into();
            if let Some(frames) = buffer_size_frames {
                out_stream_cfg.buffer_size = cpal::BufferSize::Fixed(frames);
            }

            // Per-input ring capacity scales with the callback buffer so a large
            // fixed block can't overrun a fixed-size ring (#35). Default path
            // keeps the historical RING_SIZE.
            let ring_size = ring_size_for(out_sample_rate.0, buffer_size_frames);

            let mut input_streams = Vec::new();
            // Loopback subscriptions (system / per-app). Held on the engine
            // thread; dropping them on teardown detaches from the shared capture
            // and stops it when this was the last subscriber.
            let mut subscriptions: Vec<Subscription> = Vec::new();
            // Phone (WebRTC) feed subscriptions; same RAII contract as loopback —
            // dropped on teardown, which frees the feed when this was the last bus.
            let mut remote_subscriptions: Vec<RemoteSubscription> = Vec::new();
            // (Consumer<f32>, in_channels) — at most MAX_INPUTS entries (enforced above).
            let mut consumers: Vec<(ringbuf::Consumer<f32>, usize)> = Vec::new();
            let mut input_channels_meta: Vec<u16> = Vec::new();
            // Per-input fill snapshot for drift-aware SRC. Set only for
            // rate-mismatched device inputs; None for matched-rate and loopback.
            // Output callback writes consumer.len() here before each drain so the
            // input callback can call nudge_ratio without accessing the consumer
            // from the wrong thread.
            let mut fill_snapshots: Vec<Option<Arc<AtomicUsize>>> = Vec::new();

            for (i, (source, _, _, _)) in in_specs.iter().enumerate() {
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
                        let in_rate = in_cfg.sample_rate().0;
                        let out_rate = out_sample_rate.0;
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

                        let ring = RingBuffer::<f32>::new(ring_size);
                        let (producer, consumer) = ring.split();
                        consumers.push((consumer, in_channels));
                        input_channels_meta.push(in_channels as u16);

                        let mut in_stream_cfg: StreamConfig = in_cfg.into();
                        // Match the output's fixed buffer size on the input stream
                        // too, so device-callback latency is bounded on both ends
                        // (#35). Loopback captures are unaffected (WASAPI shared).
                        if let Some(frames) = buffer_size_frames {
                            in_stream_cfg.buffer_size = cpal::BufferSize::Fixed(frames);
                        }
                        let err_cb = move |e| eprintln!("[audio] input stream {i} error: {e}");
                        let mut fill_snap: Option<Arc<AtomicUsize>> = None;
                        let input_stream = if in_rate == out_rate {
                            // Matched rate: push raw samples straight to the ring.
                            let mut producer = producer;
                            let peak = Arc::clone(&shared_for_thread);
                            input_device.build_input_stream(
                                &in_stream_cfg,
                                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                                    let mut block_peak = 0.0f32;
                                    let mut over = 0u32;
                                    for &s in data {
                                        let abs = s.abs();
                                        if abs > block_peak {
                                            block_peak = abs;
                                        }
                                        if producer.push(s).is_err() {
                                            over += 1;
                                        }
                                    }
                                    store_max(&peak[i].input_peak, block_peak);
                                    if over > 0 {
                                        peak[i].overrun.fetch_add(over, Ordering::Relaxed);
                                    }
                                },
                                err_cb,
                                None,
                            )
                        } else {
                            // Rate mismatch: cubic-resample to the bus rate (#20, #36).
                            // Share a fill-snapshot atomic with the output callback so
                            // nudge_ratio can steer the ring backlog toward target
                            // without glitching (drift-aware SRC, #36).
                            let fill_atom = Arc::new(AtomicUsize::new(0));
                            fill_snap = Some(Arc::clone(&fill_atom));
                            let target_for_nudge =
                                (TARGET_LATENCY_MS / 1000.0 * out_rate as f32) as usize
                                    * in_channels;
                            let mut producer = producer;
                            let peak = Arc::clone(&shared_for_thread);
                            let mut resampler = crate::audio::resampler::Resampler::new(
                                in_rate,
                                out_rate,
                                in_channels,
                                crate::audio::resampler::ResampleQuality::Quality,
                            );
                            input_device.build_input_stream(
                                &in_stream_cfg,
                                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                                    // Nudge the ratio once per input block using the
                                    // fill snapshot the output callback published last
                                    // block. Corrects gradual clock drift glitch-free.
                                    resampler.nudge_ratio(
                                        fill_atom.load(Ordering::Relaxed),
                                        target_for_nudge,
                                    );
                                    let mut block_peak = 0.0f32;
                                    let mut over = 0u32;
                                    let frames = data.len() / in_channels;
                                    for fi in 0..frames {
                                        let frame =
                                            &data[fi * in_channels..fi * in_channels + in_channels];
                                        for &s in frame {
                                            let abs = s.abs();
                                            if abs > block_peak {
                                                block_peak = abs;
                                            }
                                        }
                                        resampler.process_frame(frame, |out| {
                                            for &s in &out[..in_channels] {
                                                if producer.push(s).is_err() {
                                                    over += 1;
                                                }
                                            }
                                        });
                                    }
                                    store_max(&peak[i].input_peak, block_peak);
                                    if over > 0 {
                                        peak[i].overrun.fetch_add(over, Ordering::Relaxed);
                                    }
                                },
                                err_cb,
                                None,
                            )
                        }
                        .map_err(|e| EngineError {
                            message: e.to_string(),
                        })?;

                        input_streams.push(input_stream);
                        fill_snapshots.push(fill_snap);
                    }

                    // Loopback sources fill the same source-blind ring from a
                    // WASAPI capture thread. `autoconvert` delivers stereo f32 at
                    // the bus rate, so there is no rate gate and no channel check.
                    InputSourceSpec::SystemLoopback => {
                        let (consumer, ch, sub) = loopback::subscribe_system(
                            out_sample_rate.0,
                            Arc::clone(&shared_for_thread),
                            i,
                        )?;
                        consumers.push((consumer, ch as usize));
                        input_channels_meta.push(ch);
                        subscriptions.push(sub);
                        fill_snapshots.push(None);
                    }

                    InputSourceSpec::Process { pid, include_tree } => {
                        let (consumer, ch, sub) = loopback::subscribe_process(
                            *pid,
                            *include_tree,
                            out_sample_rate.0,
                            Arc::clone(&shared_for_thread),
                            i,
                        )?;
                        consumers.push((consumer, ch as usize));
                        input_channels_meta.push(ch);
                        subscriptions.push(sub);
                        fill_snapshots.push(None);
                    }

                    // Stable app id: resolve the image name to a live PID now,
                    // then subscribe exactly like the Process arm.
                    InputSourceSpec::ProcessByName {
                        image_name,
                        include_tree,
                    } => {
                        let pid = crate::audio::session::resolve_pid_for_image(image_name)?
                            .ok_or_else(|| EngineError {
                                message: format!(
                                    "App '{image_name}' is not currently playing audio. \
                                     Start playback in the app, then enable this input."
                                ),
                            })?;
                        let (consumer, ch, sub) = loopback::subscribe_process(
                            pid,
                            *include_tree,
                            out_sample_rate.0,
                            Arc::clone(&shared_for_thread),
                            i,
                        )?;
                        consumers.push((consumer, ch as usize));
                        input_channels_meta.push(ch);
                        subscriptions.push(sub);
                        fill_snapshots.push(None);
                    }

                    // Phone over WebRTC: a push-fed ring at the bus rate. Subscribe
                    // never fails — an unconnected phone is silent until audio
                    // arrives (net::webrtc_peer -> remote::push_decoded_48k).
                    InputSourceSpec::RemotePhone { session_id } => {
                        let (consumer, ch, sub) = remote::subscribe_phone(
                            session_id,
                            out_sample_rate.0,
                            Arc::clone(&shared_for_thread),
                            i,
                        )?;
                        consumers.push((consumer, ch as usize));
                        input_channels_meta.push(ch);
                        remote_subscriptions.push(sub);
                        fill_snapshots.push(None);
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

            // Per-input DSP: shared blocks (IPC side) + local slots (audio side).
            // Shared blocks are seeded from the initial DspConfig and sent back
            // to the engine handle so IPC can call publish() live. Slots stay in
            // the closure and call reload_if_changed + process_block each block.
            let sr = out_sample_rate.0 as f32;
            let dsp_shared_arcs: Vec<Arc<InputDspShared>> = in_specs
                .iter()
                .map(|(_, _, _, dsp)| Arc::new(InputDspShared::new(dsp, sr)))
                .collect();
            let mut dsp_slots: Vec<InputDspSlots> = in_specs
                .iter()
                .map(|_| InputDspSlots::new(sr))
                .collect();
            let dsp_shared_cb: Vec<Arc<InputDspShared>> =
                dsp_shared_arcs.iter().map(Arc::clone).collect();

            // Bus DSP (final limiter): one shared block seeded from bus_dsp, one
            // local slot in the closure. Same live-update pattern as inputs.
            let bus_dsp_shared_arc = Arc::new(BusDspShared::new(&bus_dsp, sr));
            let bus_dsp_shared_cb = Arc::clone(&bus_dsp_shared_arc);
            let mut bus_dsp_slots = BusDspSlots::new(sr);

            // Streaming loudness analyzer (#38). Owned by the output callback,
            // fed the final post-clamp frame; publishes to shared atomics once
            // per output block. Constructed at the output stream's rate.
            let mut analyzer = StreamAnalyzer::new(out_sample_rate.0, out_channels);

            // Per-input scratch for bulk ring reads: one `pop_slice` per input per
            // block instead of one atomic `pop()` per sample. Sized to the ring
            // capacity so a block can never exceed it; reused across callbacks so
            // the realtime thread never allocates.
            let mut input_scratch: Vec<Vec<f32>> =
                consumers.iter().map(|_| vec![0.0f32; ring_size]).collect();

            // Latency-bounding backlog targets, in frames per channel. The output
            // callback trims an input ring only when its backlog drifts past
            // `max_backlog_frames`, bringing it toward `target_backlog_frames`.
            let out_rate_hz = out_sample_rate.0 as f32;
            let target_backlog_frames = (TARGET_LATENCY_MS / 1000.0 * out_rate_hz) as usize;
            let max_backlog_frames = (MAX_LATENCY_MS / 1000.0 * out_rate_hz) as usize;

            let output_stream = output_device
                .build_output_stream(
                    &out_stream_cfg,
                    move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                        // Flush denormals (FTZ/DAZ) once up front so the bus limiter
                        // and the loudness analyzer never FPU-stall on a near-silent
                        // block, independent of whether any input ran per-block DSP.
                        enable_flush_denormals();
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
                                    if let Some(pos) = active_taps.iter().position(|t| t.id == id) {
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
                        // Whole frames actually drained per input this block; bounds
                        // the per-frame scratch read so an oversized output block
                        // can't index past the scratch (see read_scratch_frame).
                        let mut avail_frames = [0usize; MAX_INPUTS];
                        for i in 0..n {
                            gains[i] = f32::from_bits(slots[i].gain.load(Ordering::Relaxed));
                            muted[i] = slots[i].muted.load(Ordering::Relaxed);
                        }

                        // Bus-level controls loaded once per block. Treat mute
                        // as bus_vol == 0 so the per-frame math stays branch-free.
                        let bus_muted_now = shared_meters.bus_muted.load(Ordering::Relaxed);
                        let bus_vol = if bus_muted_now {
                            0.0
                        } else {
                            f32::from_bits(shared_meters.bus_volume.load(Ordering::Relaxed))
                        };

                        let frames = if out_channels > 0 {
                            data.len() / out_channels
                        } else {
                            0
                        };
                        let mut block_output_peak = 0.0f32;
                        let mut block_clipped = false;

                        // Bulk-drain each input ring once per block. pop_slice is a
                        // single head-index update vs one atomic per sample; the tail
                        // beyond what was available is zero-filled (underrun = silence).
                        // Muted inputs are drained too, preserving overflow protection.
                        for i in 0..n {
                            let in_ch = consumers[i].1;
                            let need = (frames * in_ch).min(input_scratch[i].len());
                            // Whole frames available to the mix loop. When the
                            // output block exceeds scratch capacity, this is < frames
                            // and the tail mixes as silence rather than reading OOB.
                            avail_frames[i] = need / in_ch;

                            // Publish current fill so the resampler's nudge_ratio can
                            // steer the ring toward target between output blocks (#36).
                            if let Some(snap) = &fill_snapshots[i] {
                                snap.store(consumers[i].0.len(), Ordering::Relaxed);
                            }

                            // Latency bound: when the backlog has drifted far above
                            // target (producer outrunning the mixer), trim the ring
                            // toward target before reading. Fires only on sustained
                            // drift — steady state never trims. Discarded samples are
                            // counted as overruns (lost audio, same as a full ring).
                            let mut drop_n = resync_drop(
                                consumers[i].0.len(),
                                need,
                                target_backlog_frames * in_ch,
                                max_backlog_frames * in_ch,
                            );
                            // Round down to a whole frame so an odd discard from a
                            // stereo interleaved ring can't swap L/R until next resync.
                            drop_n -= drop_n % in_ch;
                            if drop_n > 0 {
                                let dropped = consumers[i].0.discard(drop_n);
                                slots[i].overrun.fetch_add(dropped as u32, Ordering::Relaxed);
                            }

                            let got = consumers[i].0.pop_slice(&mut input_scratch[i][..need]);
                            for s in input_scratch[i][got..need].iter_mut() {
                                *s = 0.0;
                            }
                            // Underrun: the ring ran dry, so `need - got` samples
                            // were zero-filled. Record it for dropout telemetry.
                            if got < need {
                                slots[i]
                                    .underrun
                                    .fetch_add((need - got) as u32, Ordering::Relaxed);
                            }

                            // Reload DSP params if IPC published a new config, then
                            // process the whole drained block in one pass. Each effect's
                            // is_enabled check is hoisted; inner loop has no dispatch.
                            dsp_shared_cb[i].reload_if_changed(&mut dsp_slots[i]);
                            if need > 0 {
                                dsp_slots[i].process_block(
                                    &mut input_scratch[i][..need],
                                    in_ch,
                                );
                            }
                        }

                        // Reload bus DSP (limiter) once per block; applied per
                        // frame post-sum below. Cheap no-op when unchanged.
                        bus_dsp_shared_cb.reload_if_changed(&mut bus_dsp_slots);

                        for f in 0..frames {
                            // Stack-allocated accumulator. out_channels is 1 or 2
                            // (validated before stream creation).
                            let mut mix = [0.0f32; 2];

                            for i in 0..n {
                                // When muted, gain is 0; the ring was already drained
                                // in bulk above, so overflow protection is preserved.
                                let g = if muted[i] { 0.0 } else { gains[i] };
                                let in_ch = consumers[i].1; // 1 or 2 (validated)

                                // Read one input frame from the pre-drained scratch,
                                // bounded by the frames actually drained so an
                                // oversized output block can never index past it.
                                let (s0, s1) =
                                    read_scratch_frame(&input_scratch[i], f, in_ch, avail_frames[i]);

                                // DSP already applied block-wide above (process_block).
                                // s0/s1 read from the processed scratch buffer.

                                // Fan-out: InputPre / InputPost taps for input i.
                                if !active_taps.is_empty() {
                                    for tap in active_taps.iter_mut() {
                                        match tap.kind {
                                            CallbackTapKind::InputPre {
                                                input_index,
                                                channels,
                                            } if input_index == i => {
                                                tap.push(s0);
                                                if channels == 2 {
                                                    tap.push(s1);
                                                }
                                            }
                                            CallbackTapKind::InputPost {
                                                input_index,
                                                channels,
                                            } if input_index == i => {
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
                                    (1, 2) => {
                                        mix[0] += s0 * g;
                                        mix[1] += s0 * g;
                                    }
                                    (2, 1) => mix[0] += (s0 + s1) * 0.5 * g,
                                    (2, 2) => {
                                        mix[0] += s0 * g;
                                        mix[1] += s1 * g;
                                    }
                                    _ => {} // unreachable — validated above
                                }
                            }

                            // Bus gain post-sum, then bus DSP (limiter) pre-clip.
                            let mut bus_frame = [0.0f32; 2];
                            for ch in 0..out_channels {
                                bus_frame[ch] = mix[ch] * bus_vol;
                            }
                            bus_dsp_slots.process(&mut bus_frame, out_channels);

                            // Clip detect on the limited signal, hard-clamp, write,
                            // track peak, fan-out BusOut taps.
                            let mut clamped_frame = [0.0f32; 2];
                            for ch in 0..out_channels {
                                let raw = bus_frame[ch];
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

                            // Streaming meters (#38): feed the final post-clamp
                            // frame. Mono output duplicates ch0 into both legs.
                            let meter_r = if out_channels > 1 {
                                clamped_frame[1]
                            } else {
                                clamped_frame[0]
                            };
                            analyzer.process_frame(clamped_frame[0], meter_r);

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

                        // Publish loudness (#38). All four are plain stores of
                        // windowed values — true peak is the analyzer's 400 ms
                        // block max, so concurrent status readers never drain
                        // each other.
                        shared_meters
                            .rms_db
                            .store(analyzer.rms_db().to_bits(), Ordering::Relaxed);
                        shared_meters
                            .lufs_momentary
                            .store(analyzer.lufs_momentary().to_bits(), Ordering::Relaxed);
                        shared_meters
                            .lufs_short
                            .store(analyzer.lufs_short().to_bits(), Ordering::Relaxed);
                        shared_meters
                            .true_peak
                            .store(analyzer.true_peak_lin().to_bits(), Ordering::Relaxed);
                    },
                    |e| eprintln!("[audio] output stream error: {e}"),
                    None,
                )
                .map_err(|e| EngineError {
                    message: e.to_string(),
                })?;

            for stream in &input_streams {
                stream.play().map_err(|e| EngineError {
                    message: e.to_string(),
                })?;
            }
            output_stream.play().map_err(|e| EngineError {
                message: e.to_string(),
            })?;

            Ok((
                input_streams,
                subscriptions,
                remote_subscriptions,
                output_stream,
                StartInfo {
                    out_channels: out_channels as u16,
                    sample_rate: out_sample_rate.0,
                    input_channels: input_channels_meta,
                    dsp_shared: dsp_shared_arcs,
                    bus_dsp_shared: bus_dsp_shared_arc,
                },
            ))
        })();

        match outcome {
            Ok((input_streams, subscriptions, remote_subscriptions, output_stream, info)) => {
                let _ = result_tx.send(Ok(info));
                drop(result_tx);
                let _ = stop_rx.recv();
                // Stop the realtime callback first, then drop the producers:
                // cpal streams release their WASAPI handles here; dropping each
                // loopback Subscription detaches it and stops the shared capture
                // when it was the last subscriber; dropping each phone
                // RemoteSubscription frees its mixer feed.
                drop(output_stream);
                drop(input_streams);
                drop(subscriptions);
                drop(remote_subscriptions);
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
                .map(|((source, _, _, _), channels)| MixerInputInfo {
                    device_name: source.to_id(),
                    channels,
                })
                .collect(),
            shared,
            meters,
            dsp_shared: info.dsp_shared,
            bus_dsp_shared: info.bus_dsp_shared,
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
                source: InputSourceSpec::Device {
                    name: format!("fake_device_{i}"),
                },
                gain: 1.0,
                muted: false,
                dsp: DspConfig::default(),
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
                overrun: AtomicU32::new(0),
                underrun: AtomicU32::new(0),
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
                rms_db: AtomicU32::new(SILENCE_FLOOR_DB.to_bits()),
                lufs_momentary: AtomicU32::new(SILENCE_FLOOR_DB.to_bits()),
                lufs_short: AtomicU32::new(SILENCE_FLOOR_DB.to_bits()),
                true_peak: AtomicU32::new(0.0f32.to_bits()),
            }),
            dsp_shared: vec![],
            bus_dsp_shared: Arc::new(BusDspShared::new(&BusDspConfig::default(), 48_000.0)),
            tap_command_tx: tap_tx,
            out_channels: 2,
            sample_rate: 48000,
            stop_tx,
            thread: None,
        }
    }

    #[test]
    fn start_rejects_empty_inputs() {
        let result = start("fake_output", &[], 1.0, false, BusDspConfig::default(), None);
        assert!(result.is_err());
        assert!(result.err().unwrap().message.contains("No inputs"));
    }

    #[test]
    fn start_rejects_more_than_max_inputs() {
        // MAX_INPUTS + 1 inputs — must fail before any CPAL call.
        let inputs = fake_inputs(MAX_INPUTS + 1);
        let result = start("fake_output", &inputs, 1.0, false, BusDspConfig::default(), None);
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
        let result = start("fake_output", &inputs, 1.0, false, BusDspConfig::default(), None);
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
        let stored_vol = f32::from_bits(engine.meters.bus_volume.load(Ordering::Relaxed));
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

    #[test]
    fn resync_drop_zero_when_backlog_healthy() {
        // post_read = 1000 - 200 = 800, below max 2000 → no trim.
        assert_eq!(resync_drop(1000, 200, 600, 2000), 0);
    }

    #[test]
    fn ring_size_default_path_is_historical_floor() {
        // No fixed buffer → driver-chosen; ring stays at the historical RING_SIZE.
        assert_eq!(ring_size_for(48_000, None), RING_SIZE);
        // A small fixed buffer is still dominated by the 80ms backlog floor.
        assert_eq!(ring_size_for(48_000, Some(128)), RING_SIZE);
    }

    #[test]
    fn ring_size_grows_for_large_fixed_buffer() {
        // 8192-frame block: ring must exceed one block's worth (8192*2 samples)
        // so a single device callback can't overrun the ring.
        let rs = ring_size_for(48_000, Some(8192));
        assert!(rs > RING_SIZE, "expected growth, got {rs}");
        assert!(
            rs >= 8192 * 2,
            "ring {rs} must hold at least one stereo block (16384)"
        );
    }

    #[test]
    fn ring_size_always_holds_one_block_of_scratch() {
        // The output drain needs `frames * in_ch` <= ring_size for every buffer.
        for buf in [64u32, 128, 256, 480, 1024, 2048, 4096, 8192] {
            let rs = ring_size_for(48_000, Some(buf));
            let max_need = buf as usize * 2; // stereo
            assert!(
                rs >= max_need,
                "buffer {buf}: ring {rs} < one stereo block {max_need}"
            );
        }
    }

    #[test]
    fn resync_drop_at_exactly_max_does_not_trim() {
        // post_read == max is not "exceeds" → no trim (only > max fires).
        assert_eq!(resync_drop(2200, 200, 600, 2000), 0);
    }

    #[test]
    fn read_scratch_frame_silences_beyond_available_no_oob() {
        // Default `None` path: scratch is RING_SIZE, so a stereo block larger than
        // RING_SIZE/2 frames drains only `avail` whole frames. The mix loop still
        // iterates 0..frames; frames at/beyond `avail` must return silence and
        // never index past the scratch (the pre-fix inline read panicked here).
        let scratch = vec![0.5f32; RING_SIZE];
        let in_ch = 2;
        let avail = RING_SIZE / in_ch; // = need / in_ch when block exceeds scratch
        assert_eq!(read_scratch_frame(&scratch, 0, in_ch, avail), (0.5, 0.5));
        assert_eq!(read_scratch_frame(&scratch, avail - 1, in_ch, avail), (0.5, 0.5));
        // f == avail and beyond: silence, no panic even far past the buffer.
        assert_eq!(read_scratch_frame(&scratch, avail, in_ch, avail), (0.0, 0.0));
        assert_eq!(read_scratch_frame(&scratch, avail + 5_000, in_ch, avail), (0.0, 0.0));
        // Mono mirrors left into right.
        let mono = vec![0.3f32; RING_SIZE];
        assert_eq!(read_scratch_frame(&mono, 10, 1, RING_SIZE), (0.3, 0.3));
        assert_eq!(read_scratch_frame(&mono, RING_SIZE, 1, RING_SIZE), (0.0, 0.0));
    }

    #[test]
    fn resync_drop_trims_to_target_when_above_max() {
        // post_read = 5000 - 200 = 4800 > max 2000 → trim toward target 600.
        // dropped = 4800 - 600 = 4200, leaving target backlog after the read.
        assert_eq!(resync_drop(5000, 200, 600, 2000), 4200);
    }

    #[test]
    fn resync_drop_saturates_when_need_exceeds_fill() {
        // fill < need → post_read saturates to 0 → no trim, no underflow.
        assert_eq!(resync_drop(100, 480, 600, 2000), 0);
    }

    #[test]
    fn read_and_reset_xruns_aggregates_across_inputs_and_resets() {
        let engine = test_engine(&[0.0, 0.0, 0.0], 0.0, false);
        engine.shared[0].underrun.store(10, Ordering::Relaxed);
        engine.shared[1].underrun.store(5, Ordering::Relaxed);
        engine.shared[2].overrun.store(7, Ordering::Relaxed);

        let (under, over) = engine.read_and_reset_xruns();
        assert_eq!(under, 15);
        assert_eq!(over, 7);

        // Second read returns zero — counters reset on read.
        let (under2, over2) = engine.read_and_reset_xruns();
        assert_eq!(under2, 0);
        assert_eq!(over2, 0);
    }
}
