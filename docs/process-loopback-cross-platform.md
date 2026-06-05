# ProcessCapture on macOS and Linux (research) — #23

> Research only. No implementation is planned in the MVP (Windows-first). This
> records the viable approaches and how each maps onto the existing
> `InputSourceSpec` seam, so a future port is a module addition, not a redesign.

## The seam already abstracts this

`audio::source::InputSourceSpec` (`Device` / `SystemLoopback` / `Process { pid,
include_tree }`) and the source-blind mixer ring are platform-neutral. A port
only needs new `#[cfg(target_os = "...")]` arms in `audio::loopback` that fill a
`ringbuf::Producer<f32>` with stereo f32 at the bus rate; `mixer::start`,
routing, metering, and the UI are untouched. Session enumeration
(`audio::session`) needs a parallel per-OS implementation.

## macOS

| Mode | Approach | Availability |
|---|---|---|
| `SystemLoopback` | ScreenCaptureKit audio-only capture (`SCStream` with audio), or a virtual aggregate device | SCK audio: macOS 13+ |
| `Process { pid }` | Core Audio **process taps**: `CATapDescription` + `AudioHardwareCreateProcessTap` feeding an aggregate device | macOS 14.4+ |

Notes:
- Per-process taps are the clean analogue to WASAPI process loopback; the tap is
  created for one (or several) process object ids, mirroring `include_tree`.
- No mature *safe* Rust wrapper exists for process taps yet. Options: `objc2` +
  `objc2-core-audio` bindings, or `cidre`. Expect to write the FFI shim.
- Pre-14.4 fallback is a user-installed virtual device (BlackHole), which is
  just a normal `Device` input — no new code, only docs.
- Capture format is negotiable on the aggregate device; request stereo f32 at
  the bus rate, matching the Windows `autoconvert` strategy.

## Linux

| Mode | Approach |
|---|---|
| `SystemLoopback` | Record a sink **monitor** source (PipeWire or PulseAudio `<sink>.monitor`) |
| `Process { pid }` | PipeWire: capture a stream node **targeted** at the application's output node (link to the app's sink-input) |

Notes:
- PipeWire is the modern path: `pipewire`/`libspa` Rust bindings. Per-app capture
  is first-class — link a capture stream to the target application's node. PID →
  node id resolution replaces the WASAPI session→PID step.
- PulseAudio fallback: monitor sources for system; per-app via recording a
  specific sink-input (`module-loopback`). Less ergonomic than PipeWire.
- Sessions (`audio::session`): enumerate PipeWire nodes of media class
  `Stream/Output/Audio` and map node → process via the node's `application.*`
  / `object.id` properties.

## Recommended shape when porting

1. Keep `LOOPBACK_CHANNELS = 2` and the request-bus-rate-with-conversion model.
2. Add `loopback::start_system_loopback` / `start_process_loopback` arms per OS,
   returning the same `LoopbackCapture` (stop-flag + joined thread) contract.
3. Add a per-OS `session::list_audio_sessions`.
4. Gate deps with `[target.'cfg(target_os = "...")'.dependencies]`, as the
   Windows `wasapi` / `sysinfo` deps are gated today.

No resampler is required if the OS engine can convert to the bus rate (as WASAPI
`autoconvert` does); otherwise reuse the #20 resampler.
