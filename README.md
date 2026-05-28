# AudioManager

Windows desktop audio mixer/router for creators and streamers.

AudioManager lets you route multiple audio inputs to independent output buses with per-input and per-send gain/mute control, real-time metering, and preset management. Perfect for streaming, podcasting, or complex audio routing workflows.

## Features

- **4 Fixed Output Buses**: A1, A2, B1 (Stream Output), B2
- **Multi-Input Routing Matrix**: Route any input to any combination of buses
- **Per-Input Controls**: Master gain and mute for each input device
- **Per-Send Controls**: Per-bus volume, mute, and enable for each input→bus connection
- **Per-Bus Output Assignment**: Assign each bus to any output device
- **Per-Bus Controls**: Volume, mute, enable/disable, real-time metering
- **Clipping Detection**: Visual indicator when bus output clips
- **Preset Management**: Save and load routing configurations (V2 format with V1 migration)
- **B1 Stream Output**: Built-in guidance for routing audio to external virtual cable devices for OBS/Discord/Zoom

## Architecture

- **Frontend**: React + TypeScript + Vite
- **Desktop Framework**: Tauri 2
- **Backend**: Rust with CPAL and WASAPI for low-latency audio
- **Storage**: JSON presets stored locally

For detailed architecture, see [ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Getting Started

### Prerequisites

- Windows 10 or later
- Node.js 18+ and pnpm
- Rust 1.70+

### Installation

```bash
# Install dependencies
pnpm install

# Dev mode (live reload)
pnpm tauri dev

# Build for release
pnpm build tauri

# Run tests
cargo test --manifest-path src-tauri/Cargo.toml
```

For detailed setup instructions, see [SETUP.md](docs/SETUP.md).

## Virtual Stream Output

Use **B1** (Stream Output) with a virtual audio cable to stream audio to OBS, Discord, Zoom, or other applications.

1. Install a virtual audio cable ([VB-Cable](https://vb-audio.com/Cable/) or [Virtual Audio Cable](https://virtualaudiocable.org/))
2. Assign B1 to the cable's playback device (usually **CABLE Input**)
3. In your streaming app (OBS, Discord), select the matching recording device (usually **CABLE Output**)
4. Route audio to B1 in the input matrix
5. Start streaming

Note: Naming can be confusing. The AudioManager playback side (CABLE Input) is the recording side in OBS/Discord.

For detailed setup and troubleshooting, see [STREAMING_SETUP.md](docs/STREAMING_SETUP.md).

## Smoke Test Checklist

After running the app:

- [ ] App opens without errors
- [ ] A1, A2, B1, B2 buses are visible
- [ ] Assign A1 and B1 to output devices
- [ ] Add a microphone input
- [ ] Enable microphone → A1 send
- [ ] Enable microphone → B1 send
- [ ] A1 and B1 show "running" status
- [ ] Microphone meter moves when speaking
- [ ] Bus meter updates
- [ ] Send volume sliders work
- [ ] Bus mute button works
- [ ] Clip indicator appears when loud
- [ ] Preset save/load/delete works
- [ ] No console errors

## Safety Notes

⚠️ **Always use headphones during testing to prevent feedback loops.**

- Set input volume below 50% when testing with microphone near speakers
- B1 stream output does not start audio playback on your computer; it routes to the virtual cable only
- Audio is routed exactly as you configure in the matrix—if you route input→B1 and assign B1 to speakers, you will hear feedback

## Known Limitations

- No custom virtual audio driver (uses external virtual cable devices)
- No ASIO support (uses WASAPI)
- No sample-rate conversion (must match device sample rates)
- Windows first (macOS/Linux untested)
- No built-in compressor, noise gate, or EQ (future versions may add these)

## Documentation

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — Technical design and audio pipeline
- [SETUP.md](docs/SETUP.md) — Installation and development
- [STREAMING_SETUP.md](docs/STREAMING_SETUP.md) — Virtual cable workflow
- [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — Common issues and solutions
- [ROADMAP.md](docs/ROADMAP.md) — Planned features and phases
- [DEVELOPMENT.md](docs/DEVELOPMENT.md) — Dev environment setup
- [CHANGELOG.md](CHANGELOG.md) — Release history

## License

(License to be determined)

## Contributing

This is an early-stage project. Please report issues and suggestions via GitHub Issues.

---

Built with Tauri, React, TypeScript, Rust, and CPAL.
