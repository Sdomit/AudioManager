use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::{
    atomic::{AtomicBool, AtomicU32, Ordering},
    mpsc, Arc,
};
use std::thread;

use crate::audio::loopback::{self, Subscription};
use crate::audio::mixer::InputSlotShared;
use crate::audio::source::InputSourceSpec;

/// Sample rate requested from loopback subscriptions (WASAPI autoconverts).
const LOOPBACK_MONITOR_RATE: u32 = 48_000;

/// Lightweight input capture that measures peak level with no output.
/// Works for both real CPAL devices and loopback sources (system / process)
/// so inputs show live levels even before a bus engine is built.
///
/// Both paths write into `slots[0].input_peak`; `take_peak` reads it and
/// resets to 0 (same semantics as `MixerEngine::read_and_reset_meters`).
pub struct InputMonitor {
    slots: Arc<Vec<InputSlotShared>>,
    _kind: MonitorKind,
}

enum MonitorKind {
    /// CPAL input device — background thread holds the `cpal::Stream` and
    /// drops it when `stop_tx` fires.
    Device { stop_tx: mpsc::SyncSender<()> },
    /// Loopback subscription. Holds the RAII handle plus a drain thread that
    /// empties the consumer ring (prevents producer overrun spam).
    Loopback {
        _subscription: Subscription,
        stop: Arc<AtomicBool>,
        drain: Option<thread::JoinHandle<()>>,
    },
}

impl Drop for MonitorKind {
    fn drop(&mut self) {
        match self {
            MonitorKind::Device { stop_tx } => {
                let _ = stop_tx.try_send(());
            }
            MonitorKind::Loopback { stop, drain, .. } => {
                stop.store(true, Ordering::Release);
                if let Some(h) = drain.take() {
                    let _ = h.join();
                }
            }
        }
    }
}

impl InputMonitor {
    /// Start a monitor for any input source.
    /// Non-fatal: returns `Err` with a message if the source cannot be opened.
    pub fn start(device_id: &str) -> Result<Self, String> {
        match InputSourceSpec::parse(device_id) {
            InputSourceSpec::Device { name } => Self::start_device(&name),
            InputSourceSpec::SystemLoopback => Self::start_loopback_system(),
            InputSourceSpec::Process { pid, include_tree } => {
                Self::start_loopback_process(pid, include_tree)
            }
            InputSourceSpec::ProcessByName {
                image_name,
                include_tree,
            } => {
                let pid = crate::audio::session::resolve_pid_for_image(&image_name)
                    .map_err(|e| e.message)?
                    .ok_or_else(|| {
                        format!("App '{image_name}' is not currently playing audio.")
                    })?;
                Self::start_loopback_process(pid, include_tree)
            }
        }
    }

    /// Read the peak since the last call and reset to 0.0 (matches mixer semantics).
    pub fn take_peak(&self) -> f32 {
        f32::from_bits(self.slots[0].input_peak.swap(0, Ordering::Relaxed))
    }

    // ── Device monitor (CPAL) ────────────────────────────────────────────

    fn start_device(device_name: &str) -> Result<Self, String> {
        let host = cpal::default_host();
        let device = host
            .input_devices()
            .map_err(|e| e.to_string())?
            .find(|d| d.name().ok().as_deref() == Some(device_name))
            .ok_or_else(|| format!("monitor: device not found: {device_name}"))?;
        let config = device
            .default_input_config()
            .map_err(|e| e.to_string())?;

        let slots = Arc::new(vec![empty_slot()]);
        let slots_cb = Arc::clone(&slots);

        let (result_tx, result_rx) = mpsc::channel::<Result<(), String>>();
        let (stop_tx, stop_rx) = mpsc::sync_channel::<()>(1);

        thread::spawn(move || {
            let stream_cfg: cpal::StreamConfig = config.into();
            let stream = match device.build_input_stream(
                &stream_cfg,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    let max = data.iter().map(|s| s.abs()).fold(0.0_f32, f32::max);
                    cas_max(&slots_cb[0].input_peak, max);
                },
                |e| eprintln!("[monitor] device stream error: {e}"),
                None,
            ) {
                Ok(s) => s,
                Err(e) => {
                    let _ = result_tx.send(Err(e.to_string()));
                    return;
                }
            };
            if let Err(e) = stream.play() {
                let _ = result_tx.send(Err(e.to_string()));
                return;
            }
            let _ = result_tx.send(Ok(()));
            let _stream = stream;
            let _ = stop_rx.recv();
        });

        result_rx
            .recv()
            .map_err(|_| "monitor thread died unexpectedly".to_string())??;

        Ok(Self {
            slots,
            _kind: MonitorKind::Device { stop_tx },
        })
    }

    // ── Loopback monitor (system / process) ──────────────────────────────

    fn start_loopback_system() -> Result<Self, String> {
        let slots = Arc::new(vec![empty_slot()]);
        let (mut consumer, _ch, subscription) =
            loopback::subscribe_system(LOOPBACK_MONITOR_RATE, Arc::clone(&slots), 0)
                .map_err(|e| e.message)?;
        let stop = Arc::new(AtomicBool::new(false));
        let drain = spawn_drain(Arc::clone(&stop), move || {
            while consumer.pop().is_some() {}
        });
        Ok(Self {
            slots,
            _kind: MonitorKind::Loopback {
                _subscription: subscription,
                stop,
                drain: Some(drain),
            },
        })
    }

    fn start_loopback_process(pid: u32, include_tree: bool) -> Result<Self, String> {
        let slots = Arc::new(vec![empty_slot()]);
        let (mut consumer, _ch, subscription) = loopback::subscribe_process(
            pid,
            include_tree,
            LOOPBACK_MONITOR_RATE,
            Arc::clone(&slots),
            0,
        )
        .map_err(|e| e.message)?;
        let stop = Arc::new(AtomicBool::new(false));
        let drain = spawn_drain(Arc::clone(&stop), move || {
            while consumer.pop().is_some() {}
        });
        Ok(Self {
            slots,
            _kind: MonitorKind::Loopback {
                _subscription: subscription,
                stop,
                drain: Some(drain),
            },
        })
    }
}

/// Spawn a thread that periodically calls `drain` until `stop` is set.
fn spawn_drain<F>(stop: Arc<AtomicBool>, mut drain: F) -> thread::JoinHandle<()>
where
    F: FnMut() + Send + 'static,
{
    thread::spawn(move || {
        while !stop.load(Ordering::Acquire) {
            drain();
            thread::sleep(std::time::Duration::from_millis(20));
        }
        drain();
    })
}

fn empty_slot() -> InputSlotShared {
    InputSlotShared {
        gain: AtomicU32::new(1.0_f32.to_bits()),
        muted: AtomicBool::new(false),
        input_peak: AtomicU32::new(0),
        overrun: AtomicU32::new(0),
        underrun: AtomicU32::new(0),
    }
}

/// CAS loop: store `new` only if it exceeds the current value.
fn cas_max(peak: &AtomicU32, new: f32) {
    let mut old = peak.load(Ordering::Relaxed);
    loop {
        if new <= f32::from_bits(old) {
            break;
        }
        match peak.compare_exchange_weak(old, new.to_bits(), Ordering::Relaxed, Ordering::Relaxed)
        {
            Ok(_) => break,
            Err(x) => old = x,
        }
    }
}
