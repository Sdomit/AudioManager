# Roadmap

AudioManager is an early-stage project with a clear path toward professional audio routing and streaming capabilities. Below are the planned phases and features.

## Current Phase (Phase 9)

**Pro UI Cleanup & Virtual Output Workflow**

- ✅ Bus matrix visual refinement (professional card-based layout)
- ✅ Virtual audio cable detection and B1 Stream Output guidance
- ✅ In-app setup guide for OBS/Discord/Zoom streaming
- ✅ Enhanced error messages and user guidance

## Phase 10: Windows Packaging & Distribution

**Deliverables**:
- Code signing with Windows certificate (if available)
- .MSI installer with automatic updates
- Digital signature verification in app
- Installer branding and license agreement
- Uninstaller cleanup

**Constraints**:
- No backend changes
- Focus on distribution mechanics only

## Phase 11: Virtual Cable Improvements

**Deliverables**:
- ✅ Hotplug device detection (auto-refresh when device connected/disconnected)
- ✅ Virtual cable creation wizard (detect and suggest installation — CableNotice + CablePanel install/repair flow)
- ✅ Multi-cable routing (per-endpoint bus assignment map, shared-endpoint warnings, auto-route preset)
- ✅ Cable reconnection recovery (auto-reconnect on unplug/replug)

**Constraints**:
- Still rely on external drivers (VB-Cable, Virtual Audio Cable)
- No custom kernel driver (future phase)

## Phase 12: Streaming DSP Features

**Deliverables**:
- Per-bus soft limiter (prevent clipping on hot inputs)
- Per-bus high-pass filter (remove rumble and DC offset)
- Per-bus compressor (dynamic range control)
- Per-bus noise gate (suppress background noise)
- Per-bus ducking (auto-reduce music when speech detected)
- Presets for common streaming scenarios (podcast, gaming, music)

**Constraints**:
- Lock-free implementation (no blocking in audio callback)
- Minimal CPU overhead
- No ASIO or custom drivers

## Phase 13: Advanced Metering & Analysis

**Deliverables**:
- RMS (Root Mean Square) metering alongside peak
- LUFS (Loudness Units relative to Full Scale) for streaming targets
- Spectrum analyzer (frequency content visualization)
- Session history (routing changes over time)
- Loudness normalization recommendations

**Constraints**:
- Metering only; no modification of audio data
- Real-time computation without blocking

## Phase 14: Console UI & Control Surface

**Deliverables**:
- Fader layout (vertical sliders for bus/input gains)
- Meter bridge (column view of all meters at once)
- Quick mute buttons (per-input and per-bus)
- Solo button (isolate single input for monitoring)
- Customizable layout (save/restore UI state)
- Keyboard shortcuts (custom configurable shortcuts)

**Constraints**:
- UI only; no audio logic changes
- Persist layout preferences in presets or separate config

## Phase 15: Recording Bus & File Output

**Deliverables**:
- New bus type: **B3** (Recording Output)
- Record to WAV/FLAC/MP3 (configurable codec)
- Scheduled recording (start/stop times)
- Multi-track export (separate files per input)
- Session recording (capture entire routing session)

**Constraints**:
- No custom codecs; use existing libraries
- Recording does not affect real-time playback
- File I/O happens on background thread (never blocks audio)

## Phase 16: Advanced Device Handling

**Deliverables**:
- Device profile templates (e.g., "Streaming + Podcast", "Gaming + Chat")
- Sample-rate auto-detection and conversion (if needed)
- ASIO support (Windows pro audio devices)
- Dante/AES67 network audio (future research)
- Device grouping (stereo pairs, surround speakers)

**Constraints**:
- Sample-rate conversion adds latency; use only when necessary
- ASIO support optional (WASAPI remains primary)
- Network audio research phase only; implementation deferred

## Phase 17: Pro Features & Monetization

**Deliverables**:
- Licensing model (free tier vs. pro)
- Pro features: unlimited DSP instances, advanced presets, cloud sync
- Telemetry (anonymous, opt-in)
- Update notifications
- Support portal

**Constraints**:
- No forced telemetry or intrusive analytics
- Fully functional free tier
- No user data transmitted without consent

## Phase 18: Custom Virtual Driver (Long-term Research)

**Status**: Research phase only. No timeline.

**Motivation**: Eliminate dependency on external virtual cable drivers.

**Challenges**:
- Windows kernel driver development (complex, requires signing)
- Certification and compatibility across Windows versions
- Maintenance burden and support complexity

**Approach** (if pursued):
- Investigate Dante or similar existing driver ecosystem
- Profile licensing and distribution costs
- Prototype minimal driver with IPC to user-space mixer

## Future Considerations

### macOS & Linux Support

- Currently Windows-only (WASAPI backend)
- macOS: Would require CoreAudio backend (medium effort)
- Linux: Would require PulseAudio/JACK backend (high effort)
- Timeline: Post-Phase 10 (after Windows stabilizes)

### Collaboration & Network

- Remote control via network
- Multi-user sessions (collaborative mixing)
- Cloud preset sync
- Timeline: Post-Phase 17 (pro features phase)

### Hardware Integration

- MIDI controller mapping (faders, buttons)
- OSC (Open Sound Control) remote protocol
- Hardware mixer control surface support
- Timeline: Post-Phase 14 (console UI phase)

## Release Schedule (Estimated)

| Phase | Feature | Est. Timeline |
|-------|---------|---------------|
| 9 | Pro UI + Virtual Output | ✅ Complete |
| 10 | Windows Packaging | Q3 2026 |
| 11 | Virtual Cable Improvements | Q3 2026 |
| 12 | Streaming DSP | Q4 2026 |
| 13 | Advanced Metering | Q4 2026 |
| 14 | Console UI & Shortcuts | Q1 2027 |
| 15 | Recording Bus | Q1 2027 |
| 16 | Advanced Device Handling | Q2 2027 |
| 17 | Pro Features & Monetization | Q3 2027 |
| 18+ | Custom Driver / macOS / Linux | TBD |

## Contributing

Interested in helping? Please:

1. Check the roadmap to understand upcoming features
2. Open an issue to discuss your interest
3. Review DEVELOPMENT.md for environment setup
4. Submit a pull request with your changes
5. Keep PRs focused (one feature or fix per PR)

See CONTRIBUTING.md (TBD) for detailed guidelines.

## Feedback

Have ideas or found a bug? Open an issue on GitHub or reach out via email (see README.md).
