//! WASAPI loopback capture — system (whole default render endpoint) and
//! per-process (one application + its child processes), with **shared capture**
//! per (source, rate) so multiple buses don't each open a duplicate WASAPI
//! client (#22).
//!
//! A capture thread opens a WASAPI shared-mode capture client with `autoconvert`
//! (32-bit float, stereo, at the bus rate — sidestepping the cpal rate gate) and
//! fans each block out to every current subscriber's ring. The first subscriber
//! for a (source, rate) key creates the capture; the last to leave stops it.
//!
//! Lock order is one-way: `subscribe`/`unsubscribe` take the manager map lock and
//! then briefly the per-capture `subs` lock; the capture thread only ever takes
//! `subs` (never the map), and joins happen after both locks are released — so
//! there is no inversion. With a single subscriber the fan-out is a one-element
//! loop, i.e. behavior is identical to the original single-client capture.
//!
//! Platform: Windows only. `new_application_loopback_client` needs Win10 2004
//! (build 19041); system loopback needs only Win10 1803. The `wasapi` dep is
//! gated to `cfg(windows)`; non-Windows builds get stubs that return a clear
//! error.

use ringbuf::Consumer;

use crate::audio::mixer::{EngineError, InputSlotShared};

/// Loopback always delivers stereo: WASAPI `autoconvert` downmixes surround and
/// up-mixes mono render endpoints to 2 channels, so the mixer sees a fixed
/// 2-channel input regardless of the underlying device/app format.
pub const LOOPBACK_CHANNELS: u16 = 2;

/// ~85 ms at 48 kHz stereo, matching the mixer's device-input ring.
#[cfg(windows)]
const LOOPBACK_RING_SIZE: usize = 16384;

/// RAII handle for one bus's subscription to a shared capture. Dropping it
/// removes this subscriber; when the last subscriber for a (source, rate) key
/// drops, the underlying WASAPI capture is stopped and released.
pub struct Subscription {
    #[cfg_attr(not(windows), allow(dead_code))]
    key: String,
    #[cfg_attr(not(windows), allow(dead_code))]
    id: u64,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsubscribe(&self.key, self.id);
    }
}

// ── Windows implementation ──────────────────────────────────────────────────

#[cfg(windows)]
mod imp {
    use super::*;
    use std::collections::{HashMap, VecDeque};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{mpsc, Arc, Mutex, OnceLock};
    use std::thread::JoinHandle;

    use ringbuf::{Producer, RingBuffer};

    use crate::audio::mixer::store_max;

    /// One bus attached to a shared capture: its ring producer and the input-
    /// meter slot to update.
    pub(super) struct Subscriber {
        pub id: u64,
        pub producer: Producer<f32>,
        pub peak: Arc<Vec<InputSlotShared>>,
        pub index: usize,
    }

    /// Manager-side record for one live shared capture.
    struct ManagedCapture {
        stop: Arc<AtomicBool>,
        subs: Arc<Mutex<Vec<Subscriber>>>,
        thread: Option<JoinHandle<()>>,
    }

    #[derive(Debug, Clone, Copy)]
    pub(super) enum Mode {
        System,
        Process { pid: u32, include_tree: bool },
    }

    fn manager() -> &'static Mutex<HashMap<String, ManagedCapture>> {
        static M: OnceLock<Mutex<HashMap<String, ManagedCapture>>> = OnceLock::new();
        M.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn next_sub_id() -> u64 {
        static N: AtomicU64 = AtomicU64::new(1);
        N.fetch_add(1, Ordering::Relaxed)
    }

    /// Subscribe to a shared capture, creating it on first use. Blocks until the
    /// capture client is initialized when creating (so a bad PID / OS gate fails
    /// fast). Returns the ring consumer, channel count, and an RAII handle.
    pub(super) fn subscribe(
        mode: Mode,
        key: String,
        expected_rate: u32,
        peak: Arc<Vec<InputSlotShared>>,
        index: usize,
    ) -> Result<(Consumer<f32>, u16, Subscription), EngineError> {
        let id = next_sub_id();
        let ring = RingBuffer::<f32>::new(LOOPBACK_RING_SIZE);
        let (producer, consumer) = ring.split();
        let sub = Subscriber {
            id,
            producer,
            peak,
            index,
        };

        let mut map = manager().lock().unwrap();

        if let Some(mc) = map.get(&key) {
            // Existing capture for this (source, rate): just attach.
            mc.subs.lock().unwrap().push(sub);
            return Ok((consumer, LOOPBACK_CHANNELS, Subscription { key, id }));
        }

        // First subscriber: create the capture thread.
        let stop = Arc::new(AtomicBool::new(false));
        let subs = Arc::new(Mutex::new(vec![sub]));
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), EngineError>>();
        let thread_stop = Arc::clone(&stop);
        let thread_subs = Arc::clone(&subs);

        let label = match mode {
            Mode::System => "loopback-system".to_string(),
            Mode::Process { pid, .. } => format!("loopback-proc-{pid}"),
        };
        let handle = std::thread::Builder::new()
            .name(label)
            .spawn(move || match setup_capture(mode, expected_rate) {
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                }
                Ok(session) => {
                    if ready_tx.send(Ok(())).is_err() {
                        let _ = session.client.stop_stream();
                        return;
                    }
                    run_capture_loop(session, &thread_subs, &thread_stop);
                }
            })
            .map_err(|e| EngineError {
                message: format!("Failed to spawn loopback capture thread: {e}"),
            })?;

        match ready_rx.recv() {
            Ok(Ok(())) => {
                map.insert(
                    key.clone(),
                    ManagedCapture {
                        stop,
                        subs,
                        thread: Some(handle),
                    },
                );
                Ok((consumer, LOOPBACK_CHANNELS, Subscription { key, id }))
            }
            Ok(Err(e)) => {
                let _ = handle.join();
                Err(e)
            }
            Err(_) => {
                let _ = handle.join();
                Err(EngineError {
                    message: "Loopback capture thread exited before initializing.".to_string(),
                })
            }
        }
    }

    pub(super) fn unsubscribe(key: &str, id: u64) {
        let mut map = manager().lock().unwrap();
        let empty = if let Some(mc) = map.get(key) {
            let mut subs = mc.subs.lock().unwrap();
            subs.retain(|s| s.id != id);
            let empty = subs.is_empty();
            if empty {
                mc.stop.store(true, Ordering::Release);
            }
            empty
        } else {
            false
        };
        if empty {
            if let Some(mut mc) = map.remove(key) {
                // Release the map lock before joining so the capture thread —
                // which may be mid-block holding the subs lock — can finish and
                // observe the stop flag without contending on the map.
                drop(map);
                if let Some(h) = mc.thread.take() {
                    let _ = h.join();
                }
            }
        }
    }

    /// Owns the live WASAPI objects for one capture thread. Created and used on
    /// the capture thread only — the COM interfaces are not `Send`.
    struct CaptureSession {
        client: wasapi::AudioClient,
        capture: wasapi::AudioCaptureClient,
        event: wasapi::Handle,
        blockalign: usize,
        channels: u16,
    }

    fn setup_capture(mode: Mode, expected_rate: u32) -> Result<CaptureSession, EngineError> {
        use wasapi::{initialize_mta, AudioClient, Direction, SampleType, StreamMode, WaveFormat};

        // COM MTA for this capture thread. Harmless if already initialized.
        let _ = initialize_mta();

        let desired = WaveFormat::new(
            32,
            32,
            &SampleType::Float,
            expected_rate as usize,
            LOOPBACK_CHANNELS as usize,
            None,
        );
        let blockalign = desired.get_blockalign() as usize;

        // System loopback reads the default render endpoint's period; process
        // loopback has no device period (mix format is E_NOTIMPL), so we pass
        // buffer_duration_hns = 0 and let the engine pick a default.
        let (mut client, buffer_duration_hns) = match mode {
            Mode::System => {
                let enumerator = wasapi::DeviceEnumerator::new()?;
                let device = enumerator.get_default_device(&Direction::Render)?;
                let client = device.get_iaudioclient()?;
                let (_default_period, min_period) = client.get_device_period()?;
                (client, min_period)
            }
            Mode::Process { pid, include_tree } => {
                let client = AudioClient::new_application_loopback_client(pid, include_tree)?;
                (client, 0i64)
            }
        };

        let stream_mode = StreamMode::EventsShared {
            autoconvert: true,
            buffer_duration_hns,
        };
        client.initialize_client(&desired, &Direction::Capture, &stream_mode)?;

        let event = client.set_get_eventhandle()?;
        let capture = client.get_audiocaptureclient()?;
        client.start_stream()?;

        Ok(CaptureSession {
            client,
            capture,
            event,
            blockalign,
            channels: LOOPBACK_CHANNELS,
        })
    }

    fn run_capture_loop(
        session: CaptureSession,
        subs: &Arc<Mutex<Vec<Subscriber>>>,
        stop: &AtomicBool,
    ) {
        let CaptureSession {
            client,
            capture,
            event,
            blockalign,
            channels,
        } = session;
        let frame_bytes = blockalign.max(channels as usize * 4);
        let mut bytes: VecDeque<u8> = VecDeque::new();
        // Converted samples for the current wake, reused across iterations to
        // avoid per-block allocation; fanned out to every subscriber.
        let mut scratch: Vec<f32> = Vec::new();

        loop {
            if stop.load(Ordering::Acquire) {
                break;
            }
            // Event timeout is NOT an error for loopback — when nothing plays no
            // event arrives; the rings drain to silence and we re-check stop.
            if event.wait_for_event(100).is_err() {
                continue;
            }

            scratch.clear();
            let mut block_peak = 0.0f32;
            loop {
                let frames = capture.get_next_packet_size().ok().flatten().unwrap_or(0);
                if frames == 0 {
                    break;
                }
                if capture.read_from_device_to_deque(&mut bytes).is_err() {
                    eprintln!("[audio] loopback read failed; stopping capture");
                    let _ = client.stop_stream();
                    return;
                }
                let avail_frames = bytes.len() / frame_bytes;
                if avail_frames > 0 {
                    let consume = avail_frames * frame_bytes;
                    // Drain whole frames in one contiguous pass: chunks_exact(4)
                    // over a slice instead of 4× pop_front per sample. Leftover
                    // partial-frame bytes stay queued for the next read.
                    let block = bytes.make_contiguous();
                    for chunk in block[..consume].chunks_exact(4) {
                        let sample = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                        let sample = if sample.is_finite() { sample } else { 0.0 };
                        let abs = sample.abs();
                        if abs > block_peak {
                            block_peak = abs;
                        }
                        scratch.push(sample);
                    }
                    bytes.drain(..consume);
                }
            }

            if scratch.is_empty() {
                continue;
            }
            // Fan out to every current subscriber. One lock per wake (not the
            // realtime output path), so contention with (un)subscribe is brief.
            let mut guard = subs.lock().unwrap();
            for sub in guard.iter_mut() {
                let mut over = 0u32;
                for &x in scratch.iter() {
                    if sub.producer.push(x).is_err() {
                        over += 1;
                    }
                }
                store_max(&sub.peak[sub.index].input_peak, block_peak);
                // Overrun: this subscriber's ring was full, so `over` samples
                // were dropped before the mixer could read them.
                if over > 0 {
                    sub.peak[sub.index]
                        .overrun
                        .fetch_add(over, std::sync::atomic::Ordering::Relaxed);
                }
            }
        }

        let _ = client.stop_stream();
    }
}

// ── Public API ──────────────────────────────────────────────────────────────

/// Subscribe to system loopback (default render endpoint) at the bus rate.
#[cfg(windows)]
pub fn subscribe_system(
    expected_rate: u32,
    peak_slots: std::sync::Arc<Vec<InputSlotShared>>,
    slot_index: usize,
) -> Result<(Consumer<f32>, u16, Subscription), EngineError> {
    imp::subscribe(
        imp::Mode::System,
        format!("sys:default@{expected_rate}"),
        expected_rate,
        peak_slots,
        slot_index,
    )
}

/// Subscribe to per-process loopback for `pid` (and its tree) at the bus rate.
#[cfg(windows)]
pub fn subscribe_process(
    pid: u32,
    include_tree: bool,
    expected_rate: u32,
    peak_slots: std::sync::Arc<Vec<InputSlotShared>>,
    slot_index: usize,
) -> Result<(Consumer<f32>, u16, Subscription), EngineError> {
    imp::subscribe(
        imp::Mode::Process { pid, include_tree },
        format!("proc:{pid}@{expected_rate}"),
        expected_rate,
        peak_slots,
        slot_index,
    )
}

#[cfg(windows)]
fn unsubscribe(key: &str, id: u64) {
    imp::unsubscribe(key, id);
}

// ── Non-Windows stubs ─────────────────────────────────────────────────────────

#[cfg(not(windows))]
pub fn subscribe_system(
    _expected_rate: u32,
    _peak_slots: std::sync::Arc<Vec<InputSlotShared>>,
    _slot_index: usize,
) -> Result<(Consumer<f32>, u16, Subscription), EngineError> {
    Err(EngineError {
        message: "System loopback capture is only supported on Windows.".to_string(),
    })
}

#[cfg(not(windows))]
pub fn subscribe_process(
    _pid: u32,
    _include_tree: bool,
    _expected_rate: u32,
    _peak_slots: std::sync::Arc<Vec<InputSlotShared>>,
    _slot_index: usize,
) -> Result<(Consumer<f32>, u16, Subscription), EngineError> {
    Err(EngineError {
        message: "Process loopback capture is only supported on Windows.".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_is_stereo() {
        assert_eq!(LOOPBACK_CHANNELS, 2);
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_subscribe_errors_clearly() {
        let slots = std::sync::Arc::new(vec![InputSlotShared {
            gain: std::sync::atomic::AtomicU32::new(1.0f32.to_bits()),
            muted: std::sync::atomic::AtomicBool::new(false),
            input_peak: std::sync::atomic::AtomicU32::new(0),
            overrun: std::sync::atomic::AtomicU32::new(0),
            underrun: std::sync::atomic::AtomicU32::new(0),
        }]);
        let err = subscribe_system(48_000, slots, 0).unwrap_err();
        assert!(err.message.contains("Windows"));
    }
}
