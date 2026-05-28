# Setup Guide

## Prerequisites

- **Windows 10 or later** (Windows 11 recommended)
- **Node.js 18+** (check with `node --version`)
- **pnpm** (install with `npm install -g pnpm`)
- **Rust 1.70+** (install from [rustup.rs](https://rustup.rs/))
- **Visual Studio Build Tools** (required for Rust compilation on Windows)

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/sarmad/AudioManager.git
cd AudioManager
```

### 2. Install Dependencies

```bash
pnpm install
```

This installs Node dependencies and Rust dependencies (via `cargo`).

## Development

### Start Dev Mode

```bash
pnpm tauri dev
```

This:
1. Starts Vite dev server (React hot reload on `http://localhost:1420`)
2. Compiles Rust backend
3. Launches the Tauri window
4. Frontend and backend auto-reload on file changes

### Type Check

```bash
pnpm exec tsc --noEmit
```

Verify TypeScript without emitting files.

### Rust Checks

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

Check Rust compilation and run tests.

## Building for Release

```bash
pnpm build tauri
```

This:
1. Builds React (optimized, minified)
2. Compiles Rust in release mode
3. Bundles the app
4. Outputs `.msi` installer to `src-tauri/target/release/bundle/msi/`

## Project Structure

```
AudioManager/
├── src/                        # React frontend
│   ├── App.tsx                # Main UI component
│   ├── App.css                # Styles
│   ├── ipc/                   # IPC command wrappers
│   ├── types/                 # TypeScript types (DeviceInfo, BusStatus, etc.)
│   └── main.tsx               # React entry point
├── src-tauri/                 # Rust backend
│   ├── src/
│   │   ├── main.rs            # Tauri setup and IPC handlers
│   │   ├── lib.rs             # Library exports
│   │   ├── state.rs           # SystemState and AudioState
│   │   ├── presets.rs         # Preset save/load
│   │   └── audio/
│   │       ├── mod.rs         # Audio module
│   │       ├── devices.rs     # Device enumeration
│   │       ├── mixer.rs       # MixerEngine
│   │       ├── graph.rs       # AudioGraph
│   │       └── bus.rs         # Bus implementation
│   ├── tauri.conf.json        # Tauri config
│   └── Cargo.toml             # Rust dependencies
├── docs/                      # Documentation
├── README.md                  # Project overview
├── package.json               # Node dependencies
├── pnpm-workspace.yaml        # pnpm workspace config
└── tsconfig.json              # TypeScript config
```

## Troubleshooting

### "Node not found" or "pnpm not found"

Ensure Node.js 18+ and pnpm are installed:

```bash
node --version  # Should be 18+
npm install -g pnpm
pnpm --version
```

### "Rust not found"

Install Rust from [rustup.rs](https://rustup.rs/). Verify:

```bash
rustc --version
cargo --version
```

### "MSBUILD not found" or "Visual Studio Build Tools not found"

Windows Rust requires Visual Studio Build Tools. Install from:
https://visualstudio.microsoft.com/downloads/ (select "Desktop development with C++")

### Dev mode fails to start

1. Kill any existing `audio-manager` processes
2. Clear Vite cache: `rm -rf dist`
3. Clear Rust cache: `cargo clean`
4. Try again: `pnpm tauri dev`

### Compilation fails

Run:
```bash
cargo clean
cargo build --manifest-path src-tauri/Cargo.toml
```

Then try `pnpm tauri dev` again.

## Git Workflow

Never commit:
- `src-tauri/target/` (build artifacts)
- `.env` or `.env.*` (secrets)
- `node_modules/` (dependencies)
- `dist/` (build output)

These are in `.gitignore`.

Always verify before committing:
```bash
git status                      # Check what's staged
git diff --check                # Check for trailing whitespace
pnpm exec tsc --noEmit         # Verify TypeScript
cargo check --manifest-path src-tauri/Cargo.toml  # Verify Rust
cargo test --manifest-path src-tauri/Cargo.toml   # Run Rust tests
```

## Next Steps

- Read [ARCHITECTURE.md](ARCHITECTURE.md) to understand the tech stack
- Read [DEVELOPMENT.md](DEVELOPMENT.md) for detailed dev instructions
- Start `pnpm tauri dev` and explore the UI
- Check [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for common issues
