# Architecture

AudioManager is a Tauri desktop application with a React frontend and Rust backend using CPAL/WASAPI for low-latency audio processing.

## Technology Stack

- **Frontend**: React 19 + TypeScript + Vite
- **Desktop Framework**: Tauri 2 (window management, IPC, bundling)
- **Backend**: Rust (audio processing, device enumeration, routing)
- **Audio I/O**: CPAL (Cross-Platform Audio Library) with WASAPI backend on Windows
- **Storage**: JSON files (presets stored locally)

## Audio Pipeline

### Core Concepts

**Fixed Output Buses**: AudioManager provides 4 fixed output buses:
- **A1, A2**: General purpose stereo buses
- **B1**: Stream Output (routed through virtual cable devices)
- **B2**: General purpose stereo bus

Each bus can be:
- Assigned to any audio output device
- Enabled/disabled independently
- Muted
- Volume-controlled (0–200%)
- Monitored with meters and clip detection

**Input Matrix**: Users configure which inputs route to which buses via a matrix interface:
- Each input can send to any/all buses
- Each send is independently:
  - Enabled/disabled
  - Volume-controlled (0–200%)
  - Muted

### MixerEngine

The **MixerEngine** (Rust, CPAL) handles:
- WASAPI device enumeration
- Real-time mixing for each bus
- Per-input and per-send gain/mute
- Metering and peak detection
- Clipping detection (notify frontend when peak exceeds 1.0)
- Safe state updates (no locks in audio callback)

### No Locks in Audio Callback

The audio callback uses lock-free techniques:
- Atomic state updates for enable/disable and mute flags
- Read-only access to gain values (updated atomically)
- Minimal synchronization with the main thread
- Audio callback never blocks or allocates memory

### Routing Architecture

- **Route**: input device ID → bus ID with enable/volume/mute state
- Routes are stored in **SystemState** (main thread)
- Routes are copied to **AudioGraph** (audio thread) at config time
- Audio callback reads from AudioGraph without acquiring locks

## Frontend–Backend Communication (IPC)

### Commands

React calls Rust via Tauri IPC:

- `listInputDevices()` → `[DeviceInfo]`
- `listOutputDevices()` → `[DeviceInfo]`
- `getSystemStatus()` → SystemStatus (buses, inputs, input peaks, error)
- `setBusDevice(busId, outputDeviceId)` → assign bus to output
- `setBusEnabled(busId, enabled)` → start/stop bus
- `setBusVolume(busId, volume, muted)` → set bus volume and mute
- `addInput(deviceId)` → add input device
- `removeInput(deviceId)` → remove input
- `setInputGain(deviceId, gain, muted)` → set input master gain
- `setSend(deviceId, busId, enabled)` → enable/disable send
- `setSendGain(deviceId, busId, volume, muted)` → set send volume
- `savePreset(name)` → save current routing as preset
- `loadPreset(name)` → load preset (does NOT auto-start audio)
- `deletePreset(name)` → delete preset
- `listPresets()` → `[PresetSummary]`

### Polling

Frontend polls `getSystemStatus()` every 200ms to update:
- Input meters
- Bus meters
- Clipping state
- Bus running state
- System errors

## Preset Format

**Preset V2**:
- Stores per-bus output device assignment
- Stores per-input gain/mute
- Stores per-route (input→bus) enable/volume/mute
- Includes schema version for migrations
- Does NOT store bus enabled state (does NOT auto-start audio)

**V1 Migration**: When loading a V1 preset, the system warns about format and migrates the routes.

## Virtual Stream Output

**B1 Stream Output** is intended for streaming workflows:

1. User installs external virtual cable (VB-Cable, Virtual Audio Cable, etc.)
2. User assigns B1 to the cable's playback device (e.g., "CABLE Input")
3. In OBS/Discord/Zoom, user selects matching recording device (e.g., "CABLE Output")
4. User routes audio inputs to B1 in the matrix
5. Audio flows from input → B1 → virtual cable → streaming app

AudioManager does NOT:
- Install or manage virtual drivers
- Provide custom loopback device
- Handle sample-rate conversion
- Create virtual cables

AudioManager DOES:
- Detect common virtual cable device names
- Guide users through setup
- Explain naming confusion (playback ≠ recording)

## Device Management

**Device Enumeration**:
- WASAPI lists all audio devices via CPAL
- Frontend filters and displays them in dropdowns
- Frontend detects likely virtual cable devices by name pattern matching

**Device Selection**:
- User selects output device for each bus
- User selects input devices to add to matrix

**Hotplug (Phase 11)**:
- Background watcher thread polls device lists every 2 s and diffs snapshots (`audio/device_watch.rs`)
- On change, emits a `devices-changed` Tauri event; frontend refreshes device caches and any open picker
- Output unplugged: bound bus engines tear down cleanly, config kept, reconnect-pending error shown
- Output replugged: enabled buses bound to it restart automatically
- Input unplugged: affected buses rebuild with the remaining inputs (filtered rebuild)
- Input replugged: buses with an enabled send from it rebuild to include it again

## Error Handling

- Per-bus errors stored in `BusStatus.last_error`
- System-wide errors stored in `SystemStatus.last_error`
- Frontend displays errors in message panel
- No exceptions crash the app; errors are caught and reported

## Data Flow

```
User Input (React UI)
    ↓
IPC Command (Tauri)
    ↓
Command Handler (Rust)
    ↓
SystemState Update (main thread)
    ↓
AudioGraph Copy (if routing changed)
    ↓
Audio Callback (real-time, reads AudioGraph)
    ↓
Device Output (WASAPI)

Parallel:
    ↓
SystemStatus Query (polling from React)
    ↓
Frontend Update (meters, state, errors)
```

## Performance Considerations

- Audio callback must not allocate, lock, or block
- Metering uses circular buffers (no allocations during callback)
- State updates use atomic types for minimal synchronization
- Frontend polling at 200ms provides responsive UI without overload
- CPAL buffer sizes tuned for low latency (~512 samples @ 48 kHz ≈ 10ms)

## Future Improvements

- Custom virtual driver (research phase)
- Per-bus DSP (compressor, noise gate, limiter, high-pass)
- Sample-rate conversion
- Recording bus output to disk
- Custom keyboard shortcuts
- Improved metering (RMS, LUFS)
- Session recording (routing history)
