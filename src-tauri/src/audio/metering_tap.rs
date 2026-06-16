//! Per-device metering tap (#feature-idle-meter).
//!
//! A mixer engine only captures an input device while that input is *routed*
//! to a bus (an enabled send, or A1 monitor preview). An input the user has
//! added but not yet routed is never opened, so its level meter sits flat —
//! even though the device is live and the user expects to see signal.
//!
//! A `MeteringTap` is a lightweight capture stream that exists purely to
//! measure a device's peak. It pushes no audio anywhere: the callback computes
//! the block peak, stores it into shared atomics, and discards the samples.
//! `get_system_status` merges (max) every tap's peak into the per-device meter
//! aggregate, so an idle input shows its real level and a *routed* device shows
//! `max(engine peak, tap peak)` — the same value either way.
//!
//! Lifecycle mirrors [`super::passthrough::PassthroughEngine`]: the cpal stream
//! (which is `!Send` on some platforms) lives on a dedicated thread; the handle
//! holds only the stop channel, the join handle, and the shared peak atomics —
//! all `Send` — so `AppInner` can own a map of taps behind its `Mutex` with no
//! `unsafe`. Dropping the handle stops the thread and releases the WASAPI device
//! handle before the lock is returned, exactly as the mixer engine does.
//!
//! Taps are created only for real cpal `Device` inputs. Loopback / process /
//! phone sources use synthetic ids and are captured by other backends; metering
//! them while idle is out of scope here.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::StreamConfig;

use super::mixer::{store_max, EngineError};

/// Peak accumulators shared between the capture thread and the IPC reader.
/// All three hold `f32` bits; written with `store_max` in the callback and
/// drained (swap-to-zero) by the IPC thread so the meter decays when the
/// signal stops.
#[derive(Default)]
struct TapMeters {
    capture: AtomicU32,
    peak_l: AtomicU32,
    peak_r: AtomicU32,
}

/// A single peak sample drained from a tap.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TapMeter {
    pub capture: f32,
    pub peak_l: f32,
    pub peak_r: f32,
    pub channels: u16,
}

/// Live handle to a running metering tap. Drop to stop the capture thread and
/// release the device.
pub struct MeteringTap {
    /// Configured channel count (1 or 2+). Fixed for the tap's lifetime.
    channels: u16,
    meters: Arc<TapMeters>,
    stop_tx: mpsc::SyncSender<()>,
    // Held so Drop can join — the WASAPI device handle must be fully released
    // before a same-device stream is reopened (e.g. the input then gets routed
    // to a bus), otherwise the reopen can race the close and fail (device busy).
    thread: Option<thread::JoinHandle<()>>,
}

impl Drop for MeteringTap {
    fn drop(&mut self) {
        let _ = self.stop_tx.send(());
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

impl MeteringTap {
    /// Read the current peak and reset it for the next polling interval.
    pub fn read_and_reset(&self) -> TapMeter {
        TapMeter {
            capture: take_peak(&self.meters.capture),
            peak_l: take_peak(&self.meters.peak_l),
            peak_r: take_peak(&self.meters.peak_r),
            channels: self.channels,
        }
    }
}

fn take_peak(target: &AtomicU32) -> f32 {
    f32::from_bits(target.swap(0.0f32.to_bits(), Ordering::Relaxed))
}

/// Peak magnitudes for one interleaved capture block: `(mono, left, right)`.
/// `mono` is the max abs across every sample; `left`/`right` are the max abs of
/// the first two channels of each frame. A mono stream (`chans == 1`) mirrors
/// its single channel to both legs; extra channels (>2) feed only the mono
/// peak. Pure so the meter math is unit-tested without opening a device.
fn block_peaks(data: &[f32], chans: usize) -> (f32, f32, f32) {
    if chans == 0 {
        return (0.0, 0.0, 0.0);
    }
    let mut mono = 0.0f32;
    let mut l = 0.0f32;
    let mut r = 0.0f32;
    for (i, &s) in data.iter().enumerate() {
        let a = s.abs();
        if a > mono {
            mono = a;
        }
        match i % chans {
            0 if a > l => l = a,
            1 if a > r => r = a,
            _ => {}
        }
    }
    if chans == 1 {
        r = l;
    }
    (mono, l, r)
}

/// Open a metering tap on the named cpal input device.
///
/// Returns once the stream is running, or an [`EngineError`] if the device is
/// missing, busy, or delivers a non-f32 format. Callers treat a failure as
/// non-fatal: the input simply has no idle meter until it is routed.
pub fn start(device_name: &str) -> Result<MeteringTap, EngineError> {
    let meters = Arc::new(TapMeters::default());

    // Startup handshake: the thread reports the configured channel count or the
    // build error exactly once, so this function can surface failures inline.
    let (result_tx, result_rx) = mpsc::channel::<Result<u16, EngineError>>();
    // Bounded(1) so the stop send never blocks the dropping thread.
    let (stop_tx, stop_rx) = mpsc::sync_channel::<()>(1);

    let meters_for_thread = Arc::clone(&meters);
    let name_for_thread = device_name.to_string();

    let thread_handle = thread::spawn(move || {
        // All stream creation and destruction happens on this thread.
        let outcome: Result<(cpal::Stream, u16), EngineError> = (|| {
            let host = cpal::default_host();
            let device = host
                .input_devices()
                .map_err(|e| EngineError {
                    message: e.to_string(),
                })?
                .find(|d| d.name().ok().as_deref() == Some(name_for_thread.as_str()))
                .ok_or_else(|| EngineError {
                    message: format!("Input device not found: {name_for_thread}"),
                })?;

            let cfg = device.default_input_config().map_err(|e| EngineError {
                message: e.to_string(),
            })?;
            let channels = cfg.channels();
            let stream_cfg: StreamConfig = cfg.into();
            let meters = Arc::clone(&meters_for_thread);
            let chans = channels as usize;

            let stream = device
                .build_input_stream(
                    &stream_cfg,
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        let (block, l, r) = block_peaks(data, chans);
                        store_max(&meters.capture, block);
                        store_max(&meters.peak_l, l);
                        store_max(&meters.peak_r, r);
                    },
                    |e| eprintln!("[audio] metering tap stream error: {e}"),
                    None,
                )
                .map_err(|e| EngineError {
                    message: e.to_string(),
                })?;
            stream.play().map_err(|e| EngineError {
                message: e.to_string(),
            })?;
            Ok((stream, channels))
        })();

        match outcome {
            Ok((stream, channels)) => {
                let _ = result_tx.send(Ok(channels));
                drop(result_tx);
                let _ = stop_rx.recv(); // park until dropped
                drop(stream); // released on this thread
            }
            Err(e) => {
                let _ = result_tx.send(Err(e));
            }
        }
    });

    match result_rx.recv() {
        Ok(Ok(channels)) => Ok(MeteringTap {
            channels,
            meters,
            stop_tx,
            thread: Some(thread_handle),
        }),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(EngineError {
            message: "Metering tap thread exited unexpectedly during startup".to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::block_peaks;

    #[test]
    fn mono_mirrors_peak_to_both_legs() {
        let (m, l, r) = block_peaks(&[0.1, -0.5, 0.3], 1);
        assert_eq!((m, l, r), (0.5, 0.5, 0.5));
    }

    #[test]
    fn stereo_tracks_each_channel_independently() {
        // Interleaved L,R: L = {0.2, 0.4}, R = {-0.9, 0.1}.
        let (m, l, r) = block_peaks(&[0.2, -0.9, 0.4, 0.1], 2);
        assert_eq!((m, l, r), (0.9, 0.4, 0.9));
    }

    #[test]
    fn extra_channels_feed_mono_only() {
        // One 3ch frame [L, R, C] = [0.1, 0.2, 0.8]: centre lifts mono, not L/R.
        let (m, l, r) = block_peaks(&[0.1, 0.2, 0.8], 3);
        assert_eq!((m, l, r), (0.8, 0.1, 0.2));
    }

    #[test]
    fn silence_and_empty_are_zero() {
        assert_eq!(block_peaks(&[0.0, 0.0, 0.0, 0.0], 2), (0.0, 0.0, 0.0));
        assert_eq!(block_peaks(&[], 2), (0.0, 0.0, 0.0));
        // Degenerate channel count never divides by zero.
        assert_eq!(block_peaks(&[0.5], 0), (0.0, 0.0, 0.0));
    }
}
