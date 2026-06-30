//! Multi-tap audio recording.
//!
//! A *tap* is a point in the audio graph where samples can be siphoned off
//! to a WAV file without touching the realtime mix. Three tap kinds are
//! supported today, all sourced from inside the per-bus output callback:
//!
//!   * `InputPre  { device_id }`            — raw device samples, pre input gain
//!   * `InputPost { device_id, bus_id }`    — samples after input.gain × send.volume
//!   * `BusOut    { bus_id }`               — final post-clamp bus output
//!
//! A logical "master" recording is delivered as a fan-out of `BusOut` taps,
//! one per running bus, written to a session sub-folder.
//!
//! Realtime safety: the audio thread never allocates, locks, or blocks on
//! disk. Each tap owns an SPSC `ringbuf` shared with a writer thread that
//! drains it to `hound::WavWriter`. The audio callback drains a small
//! `mpsc::Receiver<TapCommand>` once per block to pick up newly-started
//! recordings; ring overflow increments a `dropped_samples` counter and
//! silently discards the sample.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ringbuf::{Consumer, Producer, RingBuffer};
use serde::{Deserialize, Serialize};

use crate::audio::bus::BusId;
use crate::audio::mixer::EngineError;

/// WAV bit depth / sample format for new recordings.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RecordFormat {
    #[default]
    Float32,
    Int24,
    Int16,
}

impl RecordFormat {
    pub fn bits_per_sample(self) -> u16 {
        match self {
            Self::Float32 => 32,
            Self::Int24 => 24,
            Self::Int16 => 16,
        }
    }

    pub fn hound_format(self) -> hound::SampleFormat {
        match self {
            Self::Float32 => hound::SampleFormat::Float,
            Self::Int24 | Self::Int16 => hound::SampleFormat::Int,
        }
    }

    pub fn bytes_per_sample(self) -> u64 {
        match self {
            Self::Float32 => 4,
            Self::Int24 => 3,
            Self::Int16 => 2,
        }
    }
}

/// ~1 second at 48 kHz stereo. Sized to ride out writer-thread jitter on a
/// healthy disk; sustained overflow is reported through `dropped_samples`.
const RECORDER_RING_FRAMES: usize = 96_000;

/// Hard ceiling on simultaneously active taps across all engines. The audio
/// callback walks this list per frame; keep it bounded.
pub const MAX_ACTIVE_TAPS: usize = 32;

/// Writer-thread poll cadence when the ring is empty.
const WRITER_IDLE_SLEEP: Duration = Duration::from_millis(10);

/// What the user asked to record.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TapSpec {
    InputPre { device_id: String },
    InputPost { device_id: String, bus_id: BusId },
    BusOut { bus_id: BusId },
}

impl TapSpec {
    /// Bus this tap lives inside (for `start_recording` engine lookup).
    #[allow(dead_code)] // tap→bus lookup helper, retained for engine routing
    pub fn bus(&self) -> Option<BusId> {
        match self {
            TapSpec::InputPre { .. } => None,
            TapSpec::InputPost { bus_id, .. } => Some(*bus_id),
            TapSpec::BusOut { bus_id } => Some(*bus_id),
        }
    }

    /// Short slug for use in filenames.
    pub fn slug(&self) -> String {
        match self {
            TapSpec::InputPre { device_id } => format!("in-pre-{}", safe_slug(device_id)),
            TapSpec::InputPost { device_id, bus_id } => {
                format!("in-post-{}-{}", safe_slug(device_id), bus_short(*bus_id))
            }
            TapSpec::BusOut { bus_id } => format!("bus-{}", bus_short(*bus_id)),
        }
    }

    /// Human description (used for ARIA / errors).
    #[allow(dead_code)] // human-readable tap label for ARIA/error surfaces
    pub fn label(&self) -> String {
        match self {
            TapSpec::InputPre { device_id } => format!("Input '{device_id}' (pre)"),
            TapSpec::InputPost { device_id, bus_id } => {
                format!("Input '{device_id}' → {} (post)", bus_short(*bus_id))
            }
            TapSpec::BusOut { bus_id } => format!("Bus {}", bus_short(*bus_id)),
        }
    }
}

/// Lightweight enum the audio callback inspects per tap, per frame.
/// Stored alongside the producer so the realtime side never re-parses a
/// `TapSpec` string.
#[derive(Debug, Clone, Copy)]
pub enum CallbackTapKind {
    /// Raw pre-gain samples for `consumers[input_index]`.
    InputPre { input_index: usize, channels: usize },
    /// Post-gain samples for `consumers[input_index]` mixed with `gain[i]`.
    InputPost { input_index: usize, channels: usize },
    /// Final bus output (already clamped) — one frame at a time, `out_channels` wide.
    BusOut,
}

/// One active tap held inside the output callback closure.
pub struct ActiveTap {
    pub id: u64,
    pub kind: CallbackTapKind,
    pub producer: Producer<f32>,
    pub dropped: Arc<AtomicU64>,
    pub samples_written: Arc<AtomicU64>,
}

impl ActiveTap {
    /// Push one sample. Sanitizes the value before enqueue so WAV files
    /// never contain NaN/Inf:
    ///   * NaN          → 0.0
    ///   * +Inf         → 1.0
    ///   * -Inf         → -1.0
    ///   * finite |s|>1 → clamped to [-1.0, 1.0]
    /// On ring-full, increment the drop counter.
    #[inline]
    pub fn push(&mut self, s: f32) {
        // NaN must be handled before clamp: `f32::clamp` returns NaN unchanged
        // because all NaN comparisons are false, so the inner `<`/`>` checks
        // never replace it with the bounds.
        let s = if s.is_nan() { 0.0 } else { s.clamp(-1.0, 1.0) };
        if self.producer.push(s).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        } else {
            self.samples_written.fetch_add(1, Ordering::Relaxed);
        }
    }
}

/// Message sent from the IPC thread to the audio callback.
pub enum TapCommand {
    Add(ActiveTap),
    Remove(u64),
}

/// IPC-side handle to one running recording.
pub struct RecorderHandle {
    pub id: String,
    pub spec: TapSpec,
    pub file_path: PathBuf,
    pub channels: u16,
    pub sample_rate: u32,
    pub format: RecordFormat,
    pub started_at: SystemTime,
    pub tap_id: u64,
    pub engine_bus: BusId,
    pub samples_written: Arc<AtomicU64>,
    pub dropped: Arc<AtomicU64>,
    pub bytes_written: Arc<AtomicU64>,
    pub error: Arc<Mutex<Option<String>>>,
    /// Set true to ask the writer thread to drain and exit.
    pub stop_flag: Arc<AtomicBool>,
    pub writer_handle: Option<JoinHandle<()>>,
    /// Cloned `tap_command_tx` of the engine this tap is attached to. Held
    /// so `stop()` can send `Remove` even if the engine has restarted; in
    /// that case the channel is closed and the send is a harmless no-op.
    pub engine_tap_tx: mpsc::Sender<TapCommand>,
}

impl RecorderHandle {
    pub fn info(&self) -> RecordingInfo {
        let started_at_unix_ms = self
            .started_at
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let dropped_samples = self.dropped.load(Ordering::Relaxed);
        let write_error = self.error.lock().ok().and_then(|g| g.clone());
        RecordingInfo {
            id: self.id.clone(),
            spec: self.spec.clone(),
            file_path: self.file_path.display().to_string(),
            channels: self.channels,
            sample_rate: self.sample_rate,
            format: self.format,
            started_at_unix_ms,
            samples_written: self.samples_written.load(Ordering::Relaxed),
            bytes_written: self.bytes_written.load(Ordering::Relaxed),
            dropped_samples,
            engine_bus: self.engine_bus,
            error: recording_status_error(write_error, dropped_samples),
        }
    }

    /// Stop the recording and finalize the WAV header.
    ///
    /// Sends `Remove` to the engine, signals the writer thread to drain
    /// + exit, joins it, and returns the final info snapshot. If the
    /// `Remove` send fails the engine was already torn down out-of-band
    /// (invariant violation in IPC layer) — record it as the first error
    /// so the surfaced `RecordingInfo.error` makes it visible instead of
    /// silently swallowing the diagnostic.
    pub fn stop(mut self) -> RecordingInfo {
        if self
            .engine_tap_tx
            .send(TapCommand::Remove(self.tap_id))
            .is_err()
        {
            set_first_error(
                &self.error,
                "Recorder stop: engine was already gone before Remove sent".to_string(),
            );
        }
        self.stop_flag.store(true, Ordering::Release);
        if let Some(handle) = self.writer_handle.take() {
            let _ = handle.join();
        }
        self.info()
    }
}

/// Snapshot returned across IPC. Mirrors RecorderHandle minus realtime bits.
#[derive(Debug, Clone, Serialize)]
pub struct RecordingInfo {
    pub id: String,
    pub spec: TapSpec,
    pub file_path: String,
    pub channels: u16,
    pub sample_rate: u32,
    pub format: RecordFormat,
    pub started_at_unix_ms: u64,
    pub samples_written: u64,
    pub bytes_written: u64,
    pub dropped_samples: u64,
    pub engine_bus: BusId,
    pub error: Option<String>,
}

/// A WAV file on disk in the recordings dir.
#[derive(Debug, Clone, Serialize)]
pub struct RecordingFile {
    pub name: String,
    pub file_path: String,
    pub size_bytes: u64,
    pub modified_unix_ms: u64,
}

/// Arguments needed to actually open the WAV writer and start streaming.
pub struct StartRecorderRequest<'a> {
    pub spec: TapSpec,
    pub kind: CallbackTapKind,
    pub channels: u16,
    pub sample_rate: u32,
    pub format: RecordFormat,
    pub engine_bus: BusId,
    pub engine_tap_tx: &'a mpsc::Sender<TapCommand>,
    pub recordings_dir: &'a Path,
    /// Optional sub-folder under `recordings_dir` (used for master-record sessions).
    pub session_subdir: Option<&'a str>,
}

/// Start a new recorder. Creates the WAV file, spawns the writer thread,
/// and sends `Add` to the engine. Caller stores the returned handle in the
/// `AppInner.recorders` map.
pub fn start_recorder(req: StartRecorderRequest<'_>) -> Result<RecorderHandle, EngineError> {
    let StartRecorderRequest {
        spec,
        kind,
        channels,
        sample_rate,
        format,
        engine_bus,
        engine_tap_tx,
        recordings_dir,
        session_subdir,
    } = req;

    if channels == 0 {
        return Err(EngineError {
            message: "Recorder channels must be > 0".to_string(),
        });
    }
    if sample_rate == 0 {
        return Err(EngineError {
            message: "Recorder sample rate must be > 0".to_string(),
        });
    }

    let dir = match session_subdir {
        Some(sub) => recordings_dir.join(sub),
        None => recordings_dir.to_path_buf(),
    };
    fs::create_dir_all(&dir).map_err(|e| EngineError {
        message: format!(
            "Failed to create recordings directory '{}': {e}",
            dir.display()
        ),
    })?;

    let now = SystemTime::now();
    let ts = format_timestamp(now);
    let id = uuid::Uuid::new_v4().to_string();
    let short_id = &id[..8];
    let filename = format!("{ts}_{}_{short_id}.wav", spec.slug());
    let path = dir.join(filename);

    let wav_spec = hound::WavSpec {
        channels,
        sample_rate,
        bits_per_sample: format.bits_per_sample(),
        sample_format: format.hound_format(),
    };
    let writer = hound::WavWriter::create(&path, wav_spec).map_err(|e| EngineError {
        message: format!("Failed to create WAV file '{}': {e}", path.display()),
    })?;

    let ring = RingBuffer::<f32>::new(RECORDER_RING_FRAMES * channels as usize);
    let (producer, consumer) = ring.split();

    let samples_written = Arc::new(AtomicU64::new(0));
    let dropped = Arc::new(AtomicU64::new(0));
    let bytes_written = Arc::new(AtomicU64::new(0));
    let error = Arc::new(Mutex::new(None));
    let stop_flag = Arc::new(AtomicBool::new(false));

    let tap_id = next_tap_id();

    // Spawn the writer thread BEFORE publishing the tap. If the spawn
    // fails we still own `producer`, so it drops here and never lands in
    // the audio engine — no leaked tap, no orphan callback work.
    let writer_stop = Arc::clone(&stop_flag);
    let writer_error = Arc::clone(&error);
    let writer_bytes = Arc::clone(&bytes_written);
    let path_for_thread = path.clone();
    let writer_handle = thread::Builder::new()
        .name(format!("rec-writer-{short_id}"))
        .spawn(move || {
            run_writer(
                writer,
                format,
                consumer,
                writer_stop,
                writer_error,
                writer_bytes,
                path_for_thread,
            );
        })
        .map_err(|e| {
            // Writer spawn failed: drop the WAV file we just opened so it
            // doesn't linger as a 0-byte orphan in the recordings folder.
            let _ = fs::remove_file(&path);
            EngineError {
                message: format!("Failed to spawn recorder writer thread: {e}"),
            }
        })?;

    // Writer thread is alive. Publishing the tap to the engine is now
    // the last fallible step. If the send fails we tear the writer down
    // cleanly and delete the empty WAV before returning.
    let active = ActiveTap {
        id: tap_id,
        kind,
        producer,
        dropped: Arc::clone(&dropped),
        samples_written: Arc::clone(&samples_written),
    };
    if let Err(_send_err) = engine_tap_tx.send(TapCommand::Add(active)) {
        // _send_err carries the ActiveTap back; dropping it releases the
        // ring producer so the writer's consumer sees no further data.
        drop(_send_err);
        stop_flag.store(true, Ordering::Release);
        let _ = writer_handle.join();
        let _ = fs::remove_file(&path);
        return Err(EngineError {
            message: "Audio engine is not running on the target bus".to_string(),
        });
    }

    Ok(RecorderHandle {
        id,
        spec,
        file_path: path,
        channels,
        sample_rate,
        format,
        started_at: now,
        tap_id,
        engine_bus,
        samples_written,
        dropped,
        bytes_written,
        error,
        stop_flag,
        writer_handle: Some(writer_handle),
        engine_tap_tx: engine_tap_tx.clone(),
    })
}

fn write_sample(
    writer: &mut hound::WavWriter<std::io::BufWriter<std::fs::File>>,
    format: RecordFormat,
    s: f32,
) -> hound::Result<()> {
    match format {
        RecordFormat::Float32 => writer.write_sample(s),
        RecordFormat::Int24 => writer.write_sample((s.clamp(-1.0, 1.0) * 8_388_607.0) as i32),
        RecordFormat::Int16 => writer.write_sample((s.clamp(-1.0, 1.0) * 32_767.0) as i16),
    }
}

fn run_writer(
    mut writer: hound::WavWriter<std::io::BufWriter<std::fs::File>>,
    format: RecordFormat,
    mut consumer: Consumer<f32>,
    stop_flag: Arc<AtomicBool>,
    error: Arc<Mutex<Option<String>>>,
    bytes_written: Arc<AtomicU64>,
    path: PathBuf,
) {
    // Reserve a small batch counter so a relentlessly-full ring doesn't
    // monopolize the thread without yielding.
    const BATCH: usize = 4096;

    loop {
        let mut written_this_batch = 0usize;
        let mut write_failed = false;
        while written_this_batch < BATCH {
            match consumer.pop() {
                Some(sample) => {
                    if let Err(e) = write_sample(&mut writer, format, sample) {
                        set_first_error(&error, format!("WAV write failed: {e}"));
                        write_failed = true;
                        break;
                    }
                    written_this_batch += 1;
                }
                None => break,
            }
        }
        // Update byte counter once per batch from successful writes only.
        add_written_bytes(&bytes_written, written_this_batch, format);

        if write_failed {
            finalize_writer(writer, &path, &bytes_written, &error);
            return;
        }

        if stop_flag.load(Ordering::Acquire) {
            break;
        }
        if written_this_batch == 0 {
            thread::sleep(WRITER_IDLE_SLEEP);
        }
    }

    // Final drain — the engine may have pushed a few extra samples between
    // when we noticed stop_flag and when Remove arrived in the callback.
    let mut tail = 0;
    while let Some(sample) = consumer.pop() {
        if let Err(e) = write_sample(&mut writer, format, sample) {
            set_first_error(&error, format!("WAV write failed during drain: {e}"));
            break;
        }
        tail += 1;
    }
    add_written_bytes(&bytes_written, tail, format);

    finalize_writer(writer, &path, &bytes_written, &error);
}

fn finalize_writer(
    writer: hound::WavWriter<std::io::BufWriter<std::fs::File>>,
    path: &Path,
    bytes_written: &Arc<AtomicU64>,
    error: &Arc<Mutex<Option<String>>>,
) {
    if let Err(e) = writer.finalize() {
        // Preserve root cause if a write error already happened.
        set_first_error(error, format!("WAV finalize failed: {e}"));
        return;
    }
    // Replace the running-sum approximation with the actual file size.
    if let Ok(meta) = fs::metadata(path) {
        bytes_written.store(meta.len(), Ordering::Relaxed);
    }
}

fn next_tap_id() -> u64 {
    use std::sync::atomic::AtomicU64;
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

fn format_timestamp(t: SystemTime) -> String {
    let dt: chrono::DateTime<chrono::Local> = t.into();
    dt.format("%Y-%m-%d_%H%M%S").to_string()
}

/// `[a-z0-9_-]+`, max 40 chars, never empty. Used inside filenames so the
/// caller can lean on a stable, OS-safe slug.
fn safe_slug(input: &str) -> String {
    let mut out = String::with_capacity(input.len().min(40));
    let mut last_dash = false;
    for ch in input.chars() {
        let mapped = if ch.is_ascii_alphanumeric() || ch == '_' {
            ch.to_ascii_lowercase()
        } else {
            '-'
        };
        if mapped == '-' {
            if last_dash {
                continue;
            }
            last_dash = true;
        } else {
            last_dash = false;
        }
        out.push(mapped);
        if out.len() >= 40 {
            break;
        }
    }
    let trimmed = out.trim_matches(|c: char| c == '-' || c == '.').to_string();
    if trimmed.is_empty() {
        "tap".to_string()
    } else {
        trimmed
    }
}

fn set_first_error(error: &Arc<Mutex<Option<String>>>, message: String) {
    if let Ok(mut guard) = error.lock() {
        if guard.is_none() {
            *guard = Some(message);
        }
    }
}

fn recording_status_error(error: Option<String>, dropped_samples: u64) -> Option<String> {
    if error.is_some() {
        return error;
    }
    if dropped_samples > 0 {
        return Some(format!(
            "Recording is lossy: dropped {dropped_samples} samples because the writer could not keep up."
        ));
    }
    None
}

#[inline]
fn add_written_bytes(bytes_written: &Arc<AtomicU64>, successful_samples: usize, format: RecordFormat) {
    if successful_samples > 0 {
        bytes_written.fetch_add(successful_samples as u64 * format.bytes_per_sample(), Ordering::Relaxed);
    }
}

fn bus_short(id: BusId) -> &'static str {
    match id {
        BusId::A1 => "A1",
        BusId::A2 => "A2",
        BusId::B1 => "B1",
        BusId::B2 => "B2",
    }
}

/// Configuration persisted to disk so recording settings survive restarts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecorderSettings {
    pub recordings_dir: PathBuf,
    #[serde(default)]
    pub format: RecordFormat,
}

impl RecorderSettings {
    pub fn settings_file(app_data_dir: &Path) -> PathBuf {
        app_data_dir.join("recorder_settings.json")
    }

    pub fn default_in(app_data_dir: &Path) -> Self {
        Self {
            recordings_dir: app_data_dir.join("recordings"),
            format: RecordFormat::Float32,
        }
    }

    pub fn load_or_default(app_data_dir: &Path) -> Self {
        let path = Self::settings_file(app_data_dir);
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Ok(settings) = serde_json::from_str::<RecorderSettings>(&raw) {
                return settings;
            }
        }
        Self::default_in(app_data_dir)
    }

    pub fn save(&self, app_data_dir: &Path) -> Result<(), EngineError> {
        let path = Self::settings_file(app_data_dir);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| EngineError {
                message: format!("Failed to create settings dir '{}': {e}", parent.display()),
            })?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| EngineError {
            message: format!("Failed to serialize recorder settings: {e}"),
        })?;
        fs::write(&path, json).map_err(|e| EngineError {
            message: format!(
                "Failed to write recorder settings '{}': {e}",
                path.display()
            ),
        })?;
        Ok(())
    }
}

/// Per-recording overrides supplied by a Record node. Each `None` field falls
/// back to the global `RecorderSettings` default at start time.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct RecordConfig {
    #[serde(default)]
    pub dir: Option<PathBuf>,
    #[serde(default)]
    pub format: Option<RecordFormat>,
}

impl RecordConfig {
    /// Effective `(dir, format)` for a recording: any override wins over the
    /// global default; an empty dir override is ignored.
    pub fn resolve(
        config: Option<&RecordConfig>,
        global_dir: PathBuf,
        global_format: RecordFormat,
    ) -> (PathBuf, RecordFormat) {
        let dir = config
            .and_then(|c| c.dir.as_ref())
            .filter(|p| !p.as_os_str().is_empty())
            .cloned()
            .unwrap_or(global_dir);
        let format = config.and_then(|c| c.format).unwrap_or(global_format);
        (dir, format)
    }
}

/// List all `.wav` files in `dir`. Returns oldest-first by mtime.
pub fn list_recording_files(dir: &Path) -> Result<Vec<RecordingFile>, EngineError> {
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    walk_wav_files(dir, &mut out)?;
    out.sort_by(|a, b| b.modified_unix_ms.cmp(&a.modified_unix_ms));
    Ok(out)
}

fn walk_wav_files(dir: &Path, out: &mut Vec<RecordingFile>) -> Result<(), EngineError> {
    let entries = fs::read_dir(dir).map_err(|e| EngineError {
        message: format!("Failed to read recordings dir '{}': {e}", dir.display()),
    })?;
    for entry in entries {
        let entry = entry.map_err(|e| EngineError {
            message: format!("Failed to read recordings entry: {e}"),
        })?;
        let path = entry.path();
        if path.is_dir() {
            walk_wav_files(&path, out)?;
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some("wav") {
            continue;
        }
        let meta = match fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified_unix_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown.wav")
            .to_string();
        out.push(RecordingFile {
            name,
            file_path: path.display().to_string(),
            size_bytes: meta.len(),
            modified_unix_ms,
        });
    }
    Ok(())
}

pub fn delete_recording_file(path: &Path) -> Result<(), EngineError> {
    if !path.exists() {
        return Err(EngineError {
            message: format!("Recording file '{}' does not exist", path.display()),
        });
    }
    fs::remove_file(path).map_err(|e| EngineError {
        message: format!("Failed to delete recording '{}': {e}", path.display()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_slug_strips_unsafe_chars() {
        assert_eq!(safe_slug("My Mic 7!"), "my-mic-7");
        assert_eq!(safe_slug("MICRO/SOFT"), "micro-soft");
        assert_eq!(safe_slug(""), "tap");
        assert_eq!(safe_slug("////"), "tap");
    }

    #[test]
    fn tap_spec_slug_includes_kind() {
        let s = TapSpec::BusOut { bus_id: BusId::B2 }.slug();
        assert_eq!(s, "bus-B2");
        let s = TapSpec::InputPre {
            device_id: "Mic".into(),
        }
        .slug();
        assert_eq!(s, "in-pre-mic");
        let s = TapSpec::InputPost {
            device_id: "Mic".into(),
            bus_id: BusId::A1,
        }
        .slug();
        assert_eq!(s, "in-post-mic-A1");
    }

    #[test]
    fn tap_spec_bus_resolves() {
        assert_eq!(TapSpec::BusOut { bus_id: BusId::A1 }.bus(), Some(BusId::A1));
        assert_eq!(
            TapSpec::InputPost {
                device_id: "x".into(),
                bus_id: BusId::B1
            }
            .bus(),
            Some(BusId::B1)
        );
        assert_eq!(
            TapSpec::InputPre {
                device_id: "x".into()
            }
            .bus(),
            None
        );
    }

    fn make_tap(ring_capacity: usize) -> (ActiveTap, Consumer<f32>) {
        let ring = RingBuffer::<f32>::new(ring_capacity);
        let (producer, consumer) = ring.split();
        let tap = ActiveTap {
            id: 1,
            kind: CallbackTapKind::BusOut,
            producer,
            dropped: Arc::new(AtomicU64::new(0)),
            samples_written: Arc::new(AtomicU64::new(0)),
        };
        (tap, consumer)
    }

    #[test]
    fn active_tap_push_replaces_nan_with_zero() {
        let (mut tap, mut consumer) = make_tap(16);
        tap.push(f32::NAN);
        assert_eq!(consumer.pop(), Some(0.0));
        assert_eq!(tap.samples_written.load(Ordering::Relaxed), 1);
        assert_eq!(tap.dropped.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn active_tap_push_clamps_infinities_to_unit() {
        let (mut tap, mut consumer) = make_tap(16);
        tap.push(f32::INFINITY);
        tap.push(f32::NEG_INFINITY);
        assert_eq!(consumer.pop(), Some(1.0));
        assert_eq!(consumer.pop(), Some(-1.0));
        assert_eq!(tap.samples_written.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn active_tap_push_clamps_out_of_range_finite_samples() {
        let (mut tap, mut consumer) = make_tap(16);
        tap.push(2.5);
        tap.push(-3.0);
        tap.push(0.5);
        tap.push(-0.25);
        tap.push(1.0);
        tap.push(-1.0);
        assert_eq!(consumer.pop(), Some(1.0));
        assert_eq!(consumer.pop(), Some(-1.0));
        assert_eq!(consumer.pop(), Some(0.5));
        assert_eq!(consumer.pop(), Some(-0.25));
        assert_eq!(consumer.pop(), Some(1.0));
        assert_eq!(consumer.pop(), Some(-1.0));
    }

    #[test]
    fn active_tap_push_preserves_finite_in_range_samples() {
        let (mut tap, mut consumer) = make_tap(16);
        for s in [0.0_f32, 0.1, -0.1, 0.999, -0.999] {
            tap.push(s);
        }
        for s in [0.0_f32, 0.1, -0.1, 0.999, -0.999] {
            assert_eq!(consumer.pop(), Some(s));
        }
    }

    #[test]
    fn active_tap_push_increments_dropped_counter_when_ring_is_full() {
        let (mut tap, _consumer) = make_tap(1);
        tap.push(0.25);
        tap.push(0.5);
        assert_eq!(tap.samples_written.load(Ordering::Relaxed), 1);
        assert_eq!(tap.dropped.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn recording_status_error_prefers_existing_error() {
        let msg = recording_status_error(Some("WAV write failed: boom".to_string()), 42);
        assert_eq!(msg, Some("WAV write failed: boom".to_string()));
    }

    #[test]
    fn recording_status_error_reports_lossy_when_dropped() {
        let msg = recording_status_error(None, 7);
        assert_eq!(
            msg,
            Some(
                "Recording is lossy: dropped 7 samples because the writer could not keep up."
                    .to_string()
            )
        );
    }

    #[test]
    fn set_first_error_preserves_root_error_message() {
        let err = Arc::new(Mutex::new(None));
        set_first_error(&err, "first".to_string());
        set_first_error(&err, "second".to_string());
        assert_eq!(err.lock().unwrap().clone(), Some("first".to_string()));
    }

    #[test]
    fn add_written_bytes_counts_successful_samples_once() {
        let bytes = Arc::new(AtomicU64::new(0));
        add_written_bytes(&bytes, 4096, RecordFormat::Float32);
        add_written_bytes(&bytes, 1024, RecordFormat::Float32);
        assert_eq!(bytes.load(Ordering::Relaxed), (4096_u64 + 1024_u64) * 4);
    }

    #[test]
    fn add_written_bytes_ignores_zero_successes() {
        let bytes = Arc::new(AtomicU64::new(1234));
        add_written_bytes(&bytes, 0, RecordFormat::Float32);
        assert_eq!(bytes.load(Ordering::Relaxed), 1234);
    }

    #[test]
    fn add_written_bytes_int16_uses_2_bytes() {
        let bytes = Arc::new(AtomicU64::new(0));
        add_written_bytes(&bytes, 100, RecordFormat::Int16);
        assert_eq!(bytes.load(Ordering::Relaxed), 200);
    }

    #[test]
    fn add_written_bytes_int24_uses_3_bytes() {
        let bytes = Arc::new(AtomicU64::new(0));
        add_written_bytes(&bytes, 100, RecordFormat::Int24);
        assert_eq!(bytes.load(Ordering::Relaxed), 300);
    }

    #[test]
    fn start_recorder_aborts_cleanly_when_engine_send_fails() {
        // P1 regression: with the receiver dropped, send(Add) fails. The
        // writer thread must be torn down and the just-created WAV file
        // must be removed — no leaked tap, no orphan file on disk.
        let tmp = std::env::temp_dir().join(format!("am-rec-fail-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();

        let (tx, rx) = mpsc::channel::<TapCommand>();
        drop(rx);

        let result = start_recorder(StartRecorderRequest {
            spec: TapSpec::BusOut { bus_id: BusId::A1 },
            kind: CallbackTapKind::BusOut,
            channels: 2,
            sample_rate: 48_000,
            format: RecordFormat::Float32,
            engine_bus: BusId::A1,
            engine_tap_tx: &tx,
            recordings_dir: &tmp,
            session_subdir: None,
        });

        assert!(
            result.is_err(),
            "expected error when engine receiver is gone"
        );

        let leftover: Vec<_> = fs::read_dir(&tmp)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name())
            .collect();
        assert!(
            leftover.is_empty(),
            "expected empty recordings dir after failed start, found {:?}",
            leftover
        );

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn stop_records_error_when_engine_send_fails() {
        // P3a: a stale RecorderHandle whose engine was torn down out-of-band
        // (invariant violation upstream) must surface a real error string
        // through RecordingInfo.error, not silently swallow the diagnostic.
        let (tx, rx) = mpsc::channel::<TapCommand>();
        drop(rx);

        let writer_handle = thread::spawn(|| {}); // no-op, immediately joinable

        let handle = RecorderHandle {
            id: "test-stop-err".to_string(),
            spec: TapSpec::BusOut { bus_id: BusId::A1 },
            file_path: PathBuf::from("ignored.wav"),
            channels: 2,
            sample_rate: 48_000,
            format: RecordFormat::Float32,
            started_at: SystemTime::now(),
            tap_id: 42,
            engine_bus: BusId::A1,
            samples_written: Arc::new(AtomicU64::new(0)),
            dropped: Arc::new(AtomicU64::new(0)),
            bytes_written: Arc::new(AtomicU64::new(0)),
            error: Arc::new(Mutex::new(None)),
            stop_flag: Arc::new(AtomicBool::new(false)),
            writer_handle: Some(writer_handle),
            engine_tap_tx: tx,
        };

        let info = handle.stop();
        let surfaced = info.error.unwrap_or_default();
        assert!(
            surfaced.contains("engine was already gone"),
            "expected stop() to record an engine-gone error, got: {surfaced:?}"
        );
    }

    #[test]
    fn settings_default_path_is_inside_app_data() {
        let app = PathBuf::from("/tmp/AudioManagerTest");
        let s = RecorderSettings::default_in(&app);
        assert_eq!(s.recordings_dir, app.join("recordings"));
    }

    #[test]
    fn settings_roundtrip() {
        let dir = std::env::temp_dir().join(format!("am-rec-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let s = RecorderSettings {
            recordings_dir: dir.join("custom"),
            format: RecordFormat::Int24,
        };
        s.save(&dir).unwrap();
        let loaded = RecorderSettings::load_or_default(&dir);
        assert_eq!(loaded.recordings_dir, s.recordings_dir);
        assert_eq!(loaded.format, s.format);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn record_config_resolve_override_and_fallback() {
        let g = PathBuf::from("/global");
        // No config → global.
        let (d, f) = RecordConfig::resolve(None, g.clone(), RecordFormat::Float32);
        assert_eq!(d, g);
        assert_eq!(f, RecordFormat::Float32);
        // Both overridden.
        let c = RecordConfig {
            dir: Some(PathBuf::from("/custom")),
            format: Some(RecordFormat::Int16),
        };
        let (d, f) = RecordConfig::resolve(Some(&c), g.clone(), RecordFormat::Float32);
        assert_eq!(d, PathBuf::from("/custom"));
        assert_eq!(f, RecordFormat::Int16);
        // Empty dir override ignored; format override still applies.
        let c = RecordConfig {
            dir: Some(PathBuf::new()),
            format: Some(RecordFormat::Int24),
        };
        let (d, f) = RecordConfig::resolve(Some(&c), g.clone(), RecordFormat::Float32);
        assert_eq!(d, g);
        assert_eq!(f, RecordFormat::Int24);
    }
}
