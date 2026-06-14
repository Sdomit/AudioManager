# Troubleshooting Guide

## General Issues

### App Won't Start

**Symptom**: AudioManager launches but immediately crashes or hangs.

**Solution**:
1. Check Windows Event Viewer for crash logs
2. Kill any existing `audio-manager.exe` processes
3. Try again
4. If persistent, check that WASAPI drivers are installed: `mmsys.cpl` → Sound settings

### "No input devices" or "No output devices"

**Symptom**: Input/output device lists are empty.

**Solution**:
1. Click **Refresh** button in AudioManager
2. Verify devices exist in Windows Sound settings:
   - Right-click volume icon → Sound settings
   - Check Playback and Recording tabs
3. If devices were added/removed, restart AudioManager
4. Check for disabled devices: Sound settings → Show disabled devices

## Audio Issues

### No Audio Output

**Symptom**: Bus is running, meter shows activity, but no sound from speakers.

**Checklist**:
1. **Is the bus enabled?** → Status should show "running"
2. **Is the bus assigned to an output device?** → Check "Output Device" dropdown
3. **Is an input routed to the bus?** → Check Input Matrix, toggle should be "On"
4. **Is the bus volume too low?** → Check volume slider (should be ≥ 50%)
5. **Is the bus muted?** → Button should NOT show "Muted"
6. **Is the input muted?** → Check input master mute button
7. **Is the send muted?** → Check Input Matrix send mute buttons

If all checked:
- Close AudioManager completely
- Unplug and replug audio devices (or restart computer)
- Try a different output device (e.g., headphones)

### Audio Too Quiet

**Solution**:
1. Increase **bus volume** slider
2. Increase **input gain** for the source device
3. Increase **send volume** in Input Matrix
4. Check Windows volume mixer: Windows Settings → Volume Mixer → Increase AudioManager volume

### Audio Too Loud / Clipping

**Symptom**: Bus meter shows red, audio is distorted.

**Solution**:
1. Decrease **bus volume** slider (start at 100%)
2. Decrease **input gain** for the source device (start at 100%)
3. Reduce source application volume (Spotify, OBS, etc.)
4. Avoid routing multiple inputs to same bus if they're all loud

### Crackling / Choppy Audio / Dropouts

**Symptom**: Audio stutters, clicks, or breaks up.

**Causes**:
- Mismatched sample rates
- USB audio device latency
- High CPU usage
- Buffer size too small

**Solution**:
1. **Check sample rates**:
   - Windows Settings → Sound → Advanced → App volume and device preferences
   - All devices should use same sample rate (48 kHz or 44.1 kHz)
   - If mismatched, change device to use 48 kHz (standard for audio/video)
2. **Close high-CPU apps**: Browsers, streaming software, games
3. **Try different USB port**: If using USB audio device
4. **Update audio drivers**: Windows Update → Settings → Update & Security
5. **Restart computer**

### Feedback Loop / Howling

**Symptom**: Audio loops and amplifies, creating loud howl.

**Cause**: Input is routed to both AudioManager output AND computer speakers.

**Solution**:
1. **B1 users**: Remove input from regular output bus (A1/A2), keep B1 for virtual cable only
2. **Check Output Device**: Ensure B1 is assigned to virtual cable, not speakers
3. **Use headphones**: For monitoring during streaming, plug into separate audio interface/input

### Sample Rate Mismatch

**Symptom**: Audio plays at wrong speed (fast/slow), sounds robotic, or has pitch distortion.

**Cause**: Device sample rates don't match.

**Solution**:
1. Check all audio devices on Windows Sound settings
2. Set all to same sample rate:
   - Right-click device → Properties → Advanced → Audio format
   - Select 48 kHz / 16 bit (or 44.1 kHz if that's your standard)
3. Restart AudioManager
4. If using OBS/Discord: Set their sample rates to match

### Bluetooth Audio Choppy

**Symptom**: Audio from Bluetooth device (headphones, headset) is choppy.

**Cause**: Bluetooth sample rate often defaults to 44.1 kHz on Windows; USB devices often use 48 kHz.

**Solution**:
1. Set Bluetooth device to 48 kHz in Windows Sound settings (if available)
2. Set other devices to 44.1 kHz to match
3. Test with 44.1 kHz consistently across all devices

## Streaming Issues (B1)

### Virtual Cable Not Detected

**Symptom**: "No virtual audio cable detected" warning shows.

**Cause**: Virtual cable driver not installed or not active.

**Solution**:
1. Install VB-Cable or Virtual Audio Cable (restart computer after install)
2. Click **Refresh** button in AudioManager
3. Check Windows Sound settings (Playback/Recording tabs) for cable device
4. If device exists but not detected: This is a naming pattern match issue; contact support

### No Audio in OBS/Discord

**Symptom**: B1 routes to virtual cable, but OBS/Discord receives no audio.

**Checklist**:
1. **Is B1 enabled?** → Status should show "running"
2. **Is an input routed to B1?** → Check Input Matrix B1 column
3. **Is OBS/Discord listening to correct device?**:
   - OBS: Settings → Audio → Mic Input should be virtual cable's **recording** side (CABLE Output)
   - Discord: User Settings → Voice & Video → Microphone should be virtual cable's **recording** side
4. **Does B1 meter show activity?** → If not, no audio is being routed

If all verified:
- Restart OBS/Discord
- Restart AudioManager
- Restart computer

### Naming Confusion: CABLE Input vs CABLE Output

**FAQ**: Why does AudioManager assign B1 to "CABLE Input" but OBS uses "CABLE Output"?

**Answer**: Virtual cable has two sides:
- **CABLE Input** (AudioManager side): Where apps write audio
- **CABLE Output** (OBS/Discord side): Where apps read audio

It's a full-duplex bridge. The naming is from the perspective of the original app; opposite from yours.

**Remember**:
- AudioManager → CABLE Input (playback/output)
- OBS/Discord → CABLE Output (recording/input)

## Device Issues

### Device Disappears After Unplugging

**Symptom**: USB audio device unplugged, then reconnected, but AudioManager doesn't see it.

Since Phase 11, AudioManager detects unplug/replug automatically within a few
seconds: device lists refresh on their own, and any bus bound to the device
reconnects when it returns (a "disconnected — reconnects automatically" note
shows on the bus in the meantime).

**If a device still doesn't appear**:
1. Wait a few seconds (the watcher polls every 2 s)
2. Close and reopen the device picker
3. If still not detected, restart AudioManager (Windows occasionally
   re-registers USB endpoints under a new name — re-assign the bus if so)

### "Unknown Device" or Strange Device Names

**Cause**: Third-party audio software or USB devices use unusual names.

**Solution**:
1. In Windows Sound settings, identify which is your audio device
2. Try assigning buses to different devices to find the right one
3. Test with a known device (headphones, speakers)

### Too Many Duplicate Devices

**Cause**: Virtual surround, stereo mix, or Windows audio enhancement devices.

**Solution**:
1. Right-click device in Sound settings → Disable
2. Restart AudioManager
3. Refresh device list

## Performance Issues

### High CPU Usage

**Symptom**: AudioManager uses >20% CPU, or audio stutters with many inputs.

**Cause**: Mixing many high-sample-rate streams, or system overloaded.

**Solution**:
1. Close other applications
2. Reduce number of routed inputs
3. Disable unused buses (unassign their output devices)
4. Check Windows Task Manager → Performance for overall system CPU

### App Freezes

**Symptom**: UI becomes unresponsive, but audio continues (or stops).

**Cause**: IPC lag from Rust backend, or main thread blocking.

**Solution**:
1. Force-close and restart (rarely needed)
2. Check Windows Event Viewer for crash logs
3. Report issue with logs to GitHub Issues

## Preset Issues

### Preset Loads But Audio Doesn't Start

**Symptom**: Preset loads successfully, but buses show "stopped".

**Design**: Presets do NOT auto-start audio. You must manually enable each bus.

**Solution**:
1. Click **Enable** button for each bus
2. This is intentional for safety (prevent feedback)

### Preset Fails to Load

**Symptom**: "Failed to load preset" error message.

**Cause**: Corrupted file, incompatible version, or file permissions.

**Solution**:
1. Check preset name in dropdown (should exist)
2. Try loading a different preset
3. Check Windows temp folder for logs
4. Delete corrupted preset and resave

### V1 Preset Migration

**Symptom**: Old preset loads but shows warnings.

**Info**: V1 presets are migrated to V2 format automatically.

**Action**: Resave the preset to update format permanently.

## Build/Development Issues

### `pnpm tauri dev` Fails

**Error**: Compilation errors, or dev server won't start.

**Solution**:
1. Clean build: `cargo clean`
2. Clear Vite cache: `rm -rf dist`
3. Reinstall deps: `pnpm install`
4. Try again: `pnpm tauri dev`

### TypeScript Errors After Editing

**Solution**:
```bash
pnpm exec tsc --noEmit
```

Fix any reported errors in source files.

### Rust Compilation Fails

**Error**: `error: failed to compile`

**Solution**:
```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

Check output for specific error. Most common:
- Missing dependencies: `cargo update`
- Outdated Rust: `rustup update`
- Visual Studio Build Tools missing (Windows): Install from VS installer

## Still Stuck?

1. Check [SETUP.md](SETUP.md) for environment setup
2. Read [ARCHITECTURE.md](ARCHITECTURE.md) to understand the system
3. Check [STREAMING_SETUP.md](STREAMING_SETUP.md) if issue is related to B1/virtual cable
4. Search existing [GitHub Issues](https://github.com/sarmad/AudioManager/issues)
5. Open a new issue with:
   - Windows version
   - What you were trying to do
   - What happened
   - Steps to reproduce
   - Console errors (if dev mode)
