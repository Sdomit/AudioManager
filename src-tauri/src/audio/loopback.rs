//! WASAPI loopback capture — system (whole default render endpoint) and
//! per-process (one application + its child processes).
//!
//! Both modes feed the same source-blind mixer ring: a dedicated capture
//! thread opens a WASAPI shared-mode capture client with `autoconvert`, so the
//! engine converts whatever the endpoint/app is playing into the exact format
//! we request — 32-bit float, stereo, at the bus sample rate. That sidesteps
//! the cpal rate gate entirely: the captured stream is already at the bus rate,
//! so no resampler is needed for loopback inputs.
//!
//! Teardown mirrors the cpal `Stream` contract the mixer relies on: dropping
//! the returned [`LoopbackCapture`] signals the capture thread to stop and
//! joins it, so the WASAPI client is released on the thread that created it.
//!
//! Platform: Windows only. `new_application_loopback_client` needs Win10 2004
//! (build 19041); system loopback needs only Win10 1803. The `wasapi` dep is
//! gated to `cfg(windows)` in Cargo.toml; non-Windows builds get stubs that
//! return a clear error.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::thread::JoinHandle;

use ringbuf::Producer;

use crate::audio::mixer::{EngineError, InputSlotShared};

/// Loopback always delivers stereo: WASAPI `autoconvert` downmixes surround and
/// up-mixes mono render endpoints to 2 channels, so the mixer sees a fixed
/// 2-channel input regardless of the underlying device/app format.
pub const LOOPBACK_CHANNELS: u16 = 2;

/// Live handle to a running loopback capture thread. Drop to stop + join.
pub struct LoopbackCapture {
    stop_flag: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for LoopbackCapture {
    fn drop(&mut self) {
        self.stop_flag
            .store(true, std::sync::atomic::Ordering::Release);
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

/// Which endpoint a capture thread targets.
#[cfg(windows)]
#[derive(Debug, Clone, Copy)]
enum Mode {
    /// Whole default render endpoint (system sound).
    System,
    /// One application by PID. `include_tree` captures child processes too.
    Process { pid: u32, include_tree: bool },
}

/// Start capturing the whole default render endpoint into `producer`.
/// Blocks until the capture client is initialized (so a setup failure surfaces
/// synchronously) and returns a handle whose drop tears the capture down.
#[cfg(windows)]
pub fn start_system_loopback(
    expected_rate: u32,
    producer: Producer<f32>,
    peak_slots: Arc<Vec<InputSlotShared>>,
    slot_index: usize,
) -> Result<LoopbackCapture, EngineError> {
    start(Mode::System, expected_rate, producer, peak_slots, slot_index)
}

/// Start capturing one application (by PID) into `producer`. See
/// [`start_system_loopback`] for the blocking/teardown contract.
#[cfg(windows)]
pub fn start_process_loopback(
    pid: u32,
    include_tree: bool,
    expected_rate: u32,
    producer: Producer<f32>,
    peak_slots: Arc<Vec<InputSlotShared>>,
    slot_index: usize,
) -> Result<LoopbackCapture, EngineError> {
    start(
        Mode::Process { pid, include_tree },
        expected_rate,
        producer,
        peak_slots,
        slot_index,
    )
}

#[cfg(windows)]
fn start(
    mode: Mode,
    expected_rate: u32,
    producer: Producer<f32>,
    peak_slots: Arc<Vec<InputSlotShared>>,
    slot_index: usize,
) -> Result<LoopbackCapture, EngineError> {
    use std::sync::mpsc;

    let stop_flag = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop_flag);
    // Setup result channel: the thread reports init success/failure before it
    // enters the capture loop, so the caller fails fast on a bad PID / OS gate.
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), EngineError>>();

    let label = match mode {
        Mode::System => "loopback-system".to_string(),
        Mode::Process { pid, .. } => format!("loopback-proc-{pid}"),
    };

    let handle = std::thread::Builder::new()
        .name(label)
        .spawn(move || {
            match setup_capture(mode, expected_rate) {
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                }
                Ok(session) => {
                    if ready_tx.send(Ok(())).is_err() {
                        // Caller gave up between spawn and recv; release now.
                        let _ = session.client.stop_stream();
                        return;
                    }
                    run_capture_loop(session, producer, &peak_slots, slot_index, &thread_stop);
                }
            }
        })
        .map_err(|e| EngineError {
            message: format!("Failed to spawn loopback capture thread: {e}"),
        })?;

    match ready_rx.recv() {
        Ok(Ok(())) => Ok(LoopbackCapture { stop_flag, thread: Some(handle) }),
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

/// Owns the live WASAPI objects for one capture thread. Created and used on the
/// capture thread only — the COM interfaces are not `Send`, so they never cross
/// a thread boundary.
#[cfg(windows)]
struct CaptureSession {
    client: wasapi::AudioClient,
    capture: wasapi::AudioCaptureClient,
    event: wasapi::Handle,
    /// Bytes per frame (channels * 4 for f32).
    blockalign: usize,
    channels: u16,
}

#[cfg(windows)]
fn setup_capture(mode: Mode, expected_rate: u32) -> Result<CaptureSession, EngineError> {
    use wasapi::{
        initialize_mta, AudioClient, Direction, SampleType, StreamMode, WaveFormat,
    };

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
    // loopback has no device period (the mix format is E_NOTIMPL), so we pass
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

#[cfg(windows)]
fn run_capture_loop(
    session: CaptureSession,
    mut producer: Producer<f32>,
    peak_slots: &Arc<Vec<InputSlotShared>>,
    slot_index: usize,
    stop_flag: &AtomicBool,
) {
    use std::collections::VecDeque;
    use std::sync::atomic::Ordering;

    let CaptureSession { client, capture, event, blockalign, channels } = session;
    let frame_bytes = blockalign.max(channels as usize * 4);
    let mut bytes: VecDeque<u8> = VecDeque::new();

    loop {
        if stop_flag.load(Ordering::Acquire) {
            break;
        }

        // Event-driven: the handle fires when a packet is ready. A timeout is
        // NOT an error for loopback — when nothing plays no event arrives, the
        // ring drains to silence, and we loop to re-check the stop flag.
        if event.wait_for_event(100).is_err() {
            continue;
        }

        // Drain every packet currently queued, not just one.
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
            push_frames(&mut bytes, frame_bytes, &mut producer, &peak_slots[slot_index]);
        }
    }

    let _ = client.stop_stream();
}

/// Convert whole interleaved f32 frames from `bytes` and push them to the ring,
/// tracking the pre-gain block peak for the input meter. Sanitizes non-finite
/// samples to 0.0 — the WASAPI engine should never emit them, but the mixer's
/// realtime path assumes finite input.
#[cfg(windows)]
fn push_frames(
    bytes: &mut std::collections::VecDeque<u8>,
    frame_bytes: usize,
    producer: &mut Producer<f32>,
    slot: &InputSlotShared,
) {
    use crate::audio::mixer::store_max;

    let mut block_peak = 0.0f32;
    while bytes.len() >= frame_bytes {
        let mut s = 0;
        while s + 4 <= frame_bytes {
            let b0 = bytes.pop_front().unwrap();
            let b1 = bytes.pop_front().unwrap();
            let b2 = bytes.pop_front().unwrap();
            let b3 = bytes.pop_front().unwrap();
            let sample = f32::from_le_bytes([b0, b1, b2, b3]);
            let sample = if sample.is_finite() { sample } else { 0.0 };
            let abs = sample.abs();
            if abs > block_peak {
                block_peak = abs;
            }
            let _ = producer.push(sample);
            s += 4;
        }
    }
    store_max(&slot.input_peak, block_peak);
}

// ── Non-Windows stubs ───────────────────────────────────────────────────────
// The project targets Windows; these keep `cargo check` honest on other hosts.

#[cfg(not(windows))]
pub fn start_system_loopback(
    _expected_rate: u32,
    _producer: Producer<f32>,
    _peak_slots: Arc<Vec<InputSlotShared>>,
    _slot_index: usize,
) -> Result<LoopbackCapture, EngineError> {
    Err(EngineError {
        message: "System loopback capture is only supported on Windows.".to_string(),
    })
}

#[cfg(not(windows))]
pub fn start_process_loopback(
    _pid: u32,
    _include_tree: bool,
    _expected_rate: u32,
    _producer: Producer<f32>,
    _peak_slots: Arc<Vec<InputSlotShared>>,
    _slot_index: usize,
) -> Result<LoopbackCapture, EngineError> {
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
    fn non_windows_system_loopback_errors_clearly() {
        let ring = ringbuf::RingBuffer::<f32>::new(16);
        let (producer, _consumer) = ring.split();
        let slots = Arc::new(vec![InputSlotShared {
            gain: std::sync::atomic::AtomicU32::new(1.0f32.to_bits()),
            muted: std::sync::atomic::AtomicBool::new(false),
            input_peak: std::sync::atomic::AtomicU32::new(0),
        }]);
        let err = start_system_loopback(48_000, producer, slots, 0).unwrap_err();
        assert!(err.message.contains("Windows"));
    }
}
