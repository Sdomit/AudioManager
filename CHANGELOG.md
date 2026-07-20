# Changelog

All notable changes to this project are documented here.

## [Unreleased]

## [0.1.0] - 2026-07-20

### Release notes
- Refreshed the AudioManager brand across the app window, installer, Windows shortcuts, and generated icon sizes.
- Corrected live meter ownership and protected routing/device updates with rollback handling.
- Added startup preference support and tightened production security configuration.
- Improved the streaming workflow documentation for VB-CABLE: install VB-CABLE separately from VB-Audio, restart Windows, use `CABLE Input` for AudioManager B1, and use `CABLE Output` in OBS, Discord, or Zoom.
- AudioManager does not bundle, install, or manage the VB-CABLE driver.

### Added
- Pro UI cleanup: Bus matrix cards with enhanced visual hierarchy
- Virtual audio cable device detection (frontend-only)
- B1 "Stream Output" labeling and guidance for streaming workflows
- In-app setup guide for OBS/Discord/Zoom streaming
- Virtual device hints in output device dropdown
- Smart suggestions/warnings for B1 when virtual devices detected
- Comprehensive documentation: SETUP.md, ARCHITECTURE.md, STREAMING_SETUP.md, TROUBLESHOOTING.md, DEVELOPMENT.md, ROADMAP.md
- README.md rewritten with project overview, features, and getting started guide

### Changed
- Bus card styling: improved padding, gaps, and visual separation
- Matrix table header styling: stronger border, bolder font
- Input device display: increased font weight and size for prominence
- B1 label changed from generic "B1" to "Stream Output"
- Message panel: improved contrast and readability

### Fixed
- TypeScript error: unused `b1Bus` declaration removed
- Minor CSS inconsistencies in matrix table layout

---

## Phase 8: Preset Route Persistence (Shipped)

**Version**: Beta 0.8.x

### Added
- Preset V2 schema: per-input gain/mute, per-route enable/volume/mute, per-bus output device
- Bus routing matrix in presets (routes persist across save/load)
- Preset migration: V1 presets auto-migrate to V2 format on load
- Route enable/disable toggles in Input Matrix
- Route-level mute buttons (independent from input/bus mute)
- Per-route volume sliders (0–200% range)
- Preset versioning and schema validation

### Fixed
- Routes now correctly stored and restored from presets
- V1 preset compatibility layer ensures old presets work with new system

---

## Phase 7: Preset Management System (Shipped)

**Version**: Beta 0.7.x

### Added
- Preset save functionality (capture current routing state)
- Preset load functionality (restore saved routing)
- Preset delete functionality
- Preset list dropdown with quick-load
- Preset naming validation and error handling
- JSON preset file storage (local filesystem)
- Preset versioning support (V1 schema)

### Fixed
- Preset file I/O error handling
- Prevent duplicate preset names
- Graceful fallback on corrupted preset files

---

## Phase 6: Real-time Metering & Clipping (Shipped)

**Version**: Beta 0.6.x

### Added
- Peak metering for inputs and buses (visual bars)
- Clipping detection (red "CLIP" badge when peak > 1.0)
- Per-input peak tracking
- Per-bus peak tracking
- Meter updates synchronized with audio callback (~200ms polling)
- Visual clip indicator with clear warning

### Fixed
- Meter precision: accurate peak detection without locks
- Clipping flag reset after user interaction

---

## Phase 5: Input Matrix & Per-Send Controls (Shipped)

**Version**: Beta 0.5.x

### Added
- Input Matrix UI: rows (inputs) × columns (buses) toggle grid
- Per-send enable/disable toggles
- Per-send volume sliders (0–200%)
- Per-send mute buttons
- Master send controls (toggle all sends for input)
- Visual grid layout with clear input/bus labels
- Responsive matrix that scales with input count

### Fixed
- Matrix rendering performance with many inputs
- Toggle click handling and state synchronization
- Volume slider precision

---

## Phase 4: Output Bus Foundation (Shipped)

**Version**: Beta 0.4.x

### Added
- 4 fixed output buses: A1, A2, B1, B2
- Per-bus volume control (0–200%)
- Per-bus mute button
- Per-bus enable/disable (start/stop audio stream)
- Per-bus output device assignment (dropdown selector)
- Per-bus status display (running/stopped)
- Bus routing to WASAPI output devices
- Real-time audio mixing for multiple buses

### Fixed
- Bus enable/disable state persistence
- Device assignment validation
- Audio callback stability with multiple buses

---

## Phase 3: Input Device Management (Shipped)

**Version**: Beta 0.3.x

### Added
- Add input button (select from available devices)
- Remove input button (cleanup)
- Input device list view
- Input master gain slider (0–200% per device)
- Input mute button (per device)
- Device enumeration via WASAPI
- Input device state management

### Fixed
- Device enumeration performance
- Input removal state cleanup
- Gain/mute state synchronization

---

## Phase 2: Core Audio Architecture (Shipped)

**Version**: Beta 0.2.x

### Added
- Tauri desktop framework integration
- Rust/CPAL/WASAPI audio backend
- React 19 frontend
- IPC commands: listInputDevices, listOutputDevices, getSystemStatus
- SystemState: tracks buses, inputs, routes
- AudioGraph: lock-free routing state for audio callback
- MixerEngine: real-time mixing with per-input and per-route gain/mute
- Audio callback: runs lock-free, no allocations, no blocking

### Changed
- Switched from simple passthrough to full mixer architecture

### Fixed
- Audio callback synchronization
- Device enumeration caching
- State thread-safety with atomics

---

## Phase 1: Project Setup (Shipped)

**Version**: Beta 0.1.x

### Added
- Tauri 2 boilerplate (window, IPC, bundling)
- React 19 + TypeScript + Vite frontend
- Rust backend with Cargo workspace
- Initial project structure (src/, src-tauri/, docs/)
- Development environment: pnpm, cargo, Node 18+
- .gitignore for build artifacts and dependencies
- README.md (initial placeholder)

### Changed
- Initial repo creation and structure

---

## Phase 0: Concept (Shipped)

**Version**: Prototype

### Added
- Project concept: Windows desktop audio router
- Technology stack decision: Tauri + React + Rust + CPAL
- Initial design: 4 fixed buses, Input Matrix, per-send controls
- Documentation outline: ARCHITECTURE.md, SETUP.md, TROUBLESHOOTING.md

---

## Notes

- All phases are cumulative; earlier features remain unless explicitly deprecated
- Version numbering: Beta X.Y.Z (not yet 1.0 release)
- See ROADMAP.md for planned future phases (10+)
- See ARCHITECTURE.md for detailed technical design
- See DEVELOPMENT.md for development environment and workflow

## License

(To be determined)
