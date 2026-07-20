# Development Guide

## Environment Setup

### Prerequisites

- Windows 10 or later (Windows 11 recommended)
- Node.js 18+ (check with `node --version`)
- pnpm (install with `npm install -g pnpm`)
- Rust 1.70+ (install from [rustup.rs](https://rustup.rs/))
- Visual Studio Build Tools (for Rust compilation on Windows)
- Git (for version control)

### Install Dependencies

```bash
cd AudioManager
pnpm install
```

This installs Node dependencies and pulls Rust dependencies (via `cargo`).

## Development Workflow

### Start Dev Mode

```bash
pnpm tauri:dev
```

- Vite dev server runs on `http://localhost:1420` with hot reload
- Rust backend compiles in debug mode
- Tauri window launches with both frontend and backend
- Frontend and backend auto-reload on file changes

### TypeScript Type Checking

```bash
pnpm exec tsc --noEmit
```

Run before committing to catch type errors. Do not emit files, just check.

### Rust Checks

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

Verify Rust compilation without building artifacts (faster).

### Rust Tests

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Run all Rust unit and integration tests. Currently ~32 tests.

### Format Check

```bash
git diff --check
```

Verify no trailing whitespace or mixed line endings before committing.

## Building for Release

```bash
pnpm build tauri
```

- React builds optimized (minified)
- Rust compiles in release mode
- Bundles application
- Output: `src-tauri/target/release/bundle/msi/AudioManager_*.msi`

## Git Workflow

### Before Committing

1. Type check: `pnpm exec tsc --noEmit`
2. Cargo check: `cargo check --manifest-path src-tauri/Cargo.toml`
3. Cargo test: `cargo test --manifest-path src-tauri/Cargo.toml`
4. Format check: `git diff --check`
5. Review: `git diff` (unstaged), `git diff --staged` (staged)

### Commit Guidelines

- Write clear, present-tense commit messages
- Use conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `style:`, `test:`
- Link to issues when relevant
- Keep commits focused (one feature or fix per commit)

### Never Commit

- `src-tauri/target/` (build artifacts)
- `.env` or `.env.*` (secrets)
- `node_modules/` (dependencies)
- `dist/` (build output)
- `secrets/`, `keys/`, `certificates/`, `signing/`
- Audio driver code, ASIO code, custom driver implementations

These are in `.gitignore`.

### Branch Strategy

- `main`: stable, release-ready
- `feature/*`: new features (e.g., `feature/audio-matrix-output-buses`)
- `fix/*`: bug fixes
- Create branches from `main` or latest release tag
- Merge via pull request after review and CI checks

## Code Organization

### Frontend (React/TypeScript)

- `src/App.tsx`: Main UI component (buses, input matrix, presets)
- `src/App.css`: Styling
- `src/main.tsx`: React entry point
- `src/ipc/`: Tauri IPC command wrappers
- `src/types/`: TypeScript interfaces (DeviceInfo, BusStatus, etc.)

Prefer React hooks, avoid class components. Keep components focused.

### Backend (Rust)

- `src-tauri/src/main.rs`: Tauri setup, IPC handlers
- `src-tauri/src/lib.rs`: Library exports
- `src-tauri/src/state.rs`: SystemState, AudioState
- `src-tauri/src/presets.rs`: Preset V2 save/load
- `src-tauri/src/audio/mod.rs`: Audio module (public API)
- `src-tauri/src/audio/devices.rs`: Device enumeration (WASAPI)
- `src-tauri/src/audio/mixer.rs`: MixerEngine (real-time mixing)
- `src-tauri/src/audio/graph.rs`: AudioGraph (routing state)
- `src-tauri/src/audio/bus.rs`: Bus implementation

Follow Rust conventions: snake_case for functions/variables, CamelCase for types/traits.

### Documentation

- `docs/ARCHITECTURE.md`: Audio pipeline, tech stack, design decisions
- `docs/SETUP.md`: Installation, build, basic development
- `docs/STREAMING_SETUP.md`: Virtual cable workflow for OBS/Discord
- `docs/TROUBLESHOOTING.md`: Common issues and solutions
- `docs/DEVELOPMENT.md`: (this file) Development environment and workflow
- `docs/ROADMAP.md`: Future features and planned phases

## Audio Pipeline Notes

The audio callback runs lock-free:
- No mutex locks in real-time thread
- Atomic updates for flags (enable, mute)
- Read-only access to gains (updated atomically on main thread)
- Metering uses lock-free circular buffers
- Never allocate or block in audio callback

When modifying audio code:
- Do not add locks to the callback
- Do not allocate memory in the callback
- Do not call blocking I/O (sleep, file ops, IPC)
- Update `AudioGraph` on main thread, callback reads it without locks
- Test with CPU profiler to verify no glitches

## Testing Locally

### Smoke Test Checklist

After `pnpm tauri dev`:

- [ ] App opens without errors
- [ ] A1, A2, B1, B2 buses visible
- [ ] Assign A1 to output device
- [ ] Assign B1 to output device
- [ ] Add microphone input
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

**Safety**: Use headphones during testing to prevent feedback loops.

### Virtual Cable Testing

If testing B1 with virtual cable:

1. Install VB-Cable or Virtual Audio Cable (external)
2. Assign B1 to cable's playback device
3. Configure OBS/Discord to listen to cable's recording device
4. Route microphone to B1
5. Verify audio appears in OBS/Discord
6. Check `getSystemStatus()` for bus running state and meter activity

## Debugging

### Browser Console

`pnpm tauri dev` logs React and TypeScript errors to the terminal and in-app console.

### Rust Logs

Add `eprintln!` or use `log` crate for backend debugging. Output appears in terminal running `pnpm tauri dev`.

### IPC Tracing

Tauri logs all IPC calls. Check terminal for request/response timing.

### Windows Event Viewer

For crashes, check Windows Event Viewer (`eventvwr.msc`) → Windows Logs → Application.

## Common Development Tasks

### Add a New IPC Command

1. Define handler in `src-tauri/src/main.rs` (Tauri `#[command]` attribute)
2. Add TypeScript wrapper in `src/ipc/` (export async function)
3. Call from React component
4. Add test in Rust if logic warrants it

### Modify Bus Routing

Routes are stored in `SystemState` and copied to `AudioGraph` for the audio callback.

1. Update route state in command handler (`src-tauri/src/main.rs`)
2. Call `mixer.update_routes()` to sync to audio callback
3. No changes needed to callback itself

### Change UI Layout

Edit `src/App.tsx` (component structure) and `src/App.css` (styling). Hot reload updates the window instantly.

### Update Preset Schema

Currently V2. If changing preset format:

1. Update `src-tauri/src/presets.rs` (V3 struct, serialization)
2. Add migration logic for V1→V3 and V2→V3
3. Update ARCHITECTURE.md to document new schema
4. Increment `schema_version` in preset files

## Performance Profiling

### CPU Usage

- Windows Task Manager → Performance tab
- Tauri window uses minimal CPU at idle (<1%)
- Audio mixing CPU depends on input count and sample rate
- Test with 5–8 inputs at 48 kHz to gauge scaling

### Memory Usage

- Task Manager → Details → AudioManager.exe
- Typical usage: 100–150 MB (React + Rust state)
- Check for leaks during long sessions with add/remove input cycles

### Audio Glitches

- If audio stutters, check overall system CPU (Task Manager)
- Disable unused buses (reduces mixing load)
- Reduce input count temporarily
- Check Windows audio buffer size (unlikely to change, but possible)

## Staying Up-to-Date

- Check ROADMAP.md for planned features
- Review CHANGELOG.md for recent changes
- Run `pnpm install` and `cargo update` periodically
- Watch for Tauri and CPAL updates
- Subscribe to GitHub Issues for discussions

## Getting Help

1. Read ARCHITECTURE.md to understand the design
2. Check TROUBLESHOOTING.md for known issues
3. Search GitHub Issues for similar problems
4. Open a new issue with reproduction steps and logs
5. Contact via GitHub Issues (email in README.md not monitored for support)
