# Streaming Setup: Virtual Stream Output (B1)

This guide explains how to use **B1 (Stream Output)** with a virtual audio cable to stream audio to OBS, Discord, Zoom, or other applications.

## Overview

**B1** is labeled as "Stream Output" in AudioManager. It's designed to route audio through a virtual audio cable device so you can:

- Stream microphone + music + browser audio to OBS for streaming to Twitch/YouTube
- Route audio to Discord/Zoom calls without system speakers
- Record multiple sources simultaneously in your streaming app

## Step-by-Step Setup

### 1. Install a Virtual Audio Cable

#### Option A — AudioManager Virtual Cable (recommended)

The companion project [AudioManagerVirtualCable](https://github.com/Sdomit/AudioManagerVirtualCable) ships a Windows virtual audio cable that AudioManager detects and integrates with as first-class devices. Once installed it exposes six WASAPI endpoints, all prefixed `AudioManager `:

| Device | Direction | Role |
|---|---|---|
| `AudioManager Cable 1 Playback` | render | App → mixer input |
| `AudioManager Cable 1 Recording` | capture | Mixer captures app audio |
| `AudioManager Cable 2 Playback` | render | App → mixer input (second pair) |
| `AudioManager Cable 2 Recording` | capture | Mixer captures app audio (second pair) |
| `AudioManager Stream Output` | render | **B1** stream bus → OBS |
| `AudioManager Voice Output` | render | **B2** voice bus → Discord/Zoom/Teams |

**What AudioManager surfaces about it:**

- Detects these endpoints by the `AudioManager ` name prefix and marks them as first-class (distinct from third-party cables).
- In the **Stream Setup** sheet, a **Virtual Cable** panel shows live status from `amvc-helper status --json`: `Connected` / `Degraded` / `Needs repair` / `Reboot required` / `Not installed` / `Helper not found`, with `found/expected` count, per-endpoint live/missing dots, and **Install** / **Repair** / **Re-check** buttons.
- The **B1** and **B2** output device pickers highlight `Stream Output` and `Voice Output` with a **Recommended** badge.
- The **Add input** picker highlights `AudioManager Cable N Recording` as the suggested app-capture source.

**Install:**

1. Install the AudioManager Virtual Cable from the companion repo (follow its README).
2. The bundled `amvc-helper` CLI must be reachable on `PATH` (or alongside the driver per its installer).
3. AudioManager never installs or touches the driver directly — it only invokes `amvc-helper`. Use the **Install / Repair** action in AudioManager's notice banner or Stream Setup panel to launch the helper.
4. **Restart your computer** after install (Windows audio devices require it).

**If the helper or driver is absent:** AudioManager continues to run normally and falls back to third-party cables (Option B). A non-blocking banner offers Install / Repair / Re-check.

#### Option B — Third-party virtual cables

If you don't use the AudioManager Virtual Cable, either of these also works:

- **VB-Cable** (Windows, $4.95 or free): https://vb-audio.com/Cable/
- **Virtual Audio Cable** (Windows, trial or free): https://virtualaudiocable.org/

> Note: AudioManager does NOT install or manage third-party drivers. You must download and install manually. **Restart your computer** after install.

### 2. Configure AudioManager

1. **Launch AudioManager**
2. **Assign B1 to the Virtual Cable**:
   - Go to the **Buses** section
   - Find **B1** (labeled "Stream Output")
   - Click the **Output Device** dropdown
   - Select the virtual cable's **playback/output** device:
     - **VB-Cable**: Select "CABLE Input" (confusing, but correct)
     - **Virtual Audio Cable**: Select "Line 1 - Output" or similar
   - B1 should now show the device name

3. **Enable B1** (if not already running):
   - Click the "Enable" button on B1
   - B1 status should change to "running"

4. **Route Audio to B1**:
   - In the **Input Matrix**, find the inputs you want to stream (microphone, browser audio, etc.)
   - For each input, find the **B1** column and toggle "On"
   - Set the volume level if needed

5. **Test**:
   - Speak into your microphone
   - B1 meter should show activity
   - You should NOT hear audio through your computer speakers (B1 routes only to the virtual cable)

### 3. Configure Your Streaming Application

#### **OBS Studio**

1. **Settings** → **Audio** → **Advanced**
2. Set the **Audio Track** input to the virtual cable's **recording/input** device:
   - **VB-Cable**: Select "CABLE Output" (opposite of AudioManager)
   - **Virtual Audio Cable**: Select "Line 1 - Input" or similar
3. **Apply** and restart the scene
4. Check audio levels in OBS; they should match B1 meters in AudioManager

#### **Discord**

1. **User Settings** → **Voice & Video**
2. Set **Input Device** to the virtual cable's **recording/input** device
3. Adjust **Input Volume** to match B1 levels in AudioManager
4. Test with a voice call

#### **Zoom**

1. **Settings** → **Audio**
2. Set **Microphone** to the virtual cable's **recording/input** device
3. Test speakers separately if needed
4. Join a call and test

### 4. Start Streaming/Recording

Your streaming app now captures audio from the virtual cable, which feeds from:

```
AudioManager Input (Mic, Music, Browser)
    → B1 Routing (Mix, Volume Control)
    → Virtual Cable Playback
    → Virtual Cable Recording
    → OBS/Discord/Zoom
```

## Naming Confusion

The naming of virtual cable devices is confusing because they expose two sides:

| Context | AudioManager Cable | VB-Cable Name | Virtual Audio Cable Name | What It Is |
|---------|--------------------|---------------|-------------------------|-----------|
| **AudioManager Output (B1)** | AudioManager Stream Output | CABLE Input | Line 1 - Output | Where AudioManager sends stream audio |
| **AudioManager Output (B2)** | AudioManager Voice Output | — | — | Where AudioManager sends voice-call audio |
| **OBS/Discord Input** | AudioManager Cable 1 Recording | CABLE Output | Line 1 - Input | Where OBS/Discord listens |

This is **not** backwards. The virtual cable is a bidirectional bridge:
- AudioManager writes to the **playback** side (CABLE Input / Output)
- OBS reads from the **recording** side (CABLE Output / Input)

## Sample Rate Matching

⚠️ **Important**: For clean audio, ensure sample rates match.

1. **Check your system sample rate**:
   - Windows Settings → Sound → Advanced → App volume and device preferences
   - Check your primary audio output device

2. **Set AudioManager's target sample rate** to match (usually **48 kHz** or **44.1 kHz**)

3. **Set the virtual cable's sample rate** to match:
   - VB-Cable: Control Panel → VB-Cable settings
   - Virtual Audio Cable: Installer → Settings

4. **Set OBS/Discord to match**:
   - OBS: Settings → Audio → Sample Rate
   - Discord: User Settings → Voice & Video → Input/Output Volume

If sample rates don't match, you'll hear:
- Audio speed changes (faster/slower)
- Pitch distortion
- Dropouts

## Feedback Prevention

⚠️ **Do NOT route B1 to your regular speakers.** It's designed only for virtual cable output.

If you route B1 to speakers AND have an input also going to speakers, you'll create a feedback loop (howling).

If you need to monitor audio while streaming:
- Use **headphones** on a separate input device
- Route that input to bus **A1** or **A2** instead
- Keep B1 assigned only to the virtual cable

## Troubleshooting

### Virtual Cable Not Showing in AudioManager

1. Restart AudioManager
2. Click **Refresh** button in the UI
3. Check that virtual cable driver is installed and active:
   - Control Panel → Sound → Playback/Recording tabs
   - Virtual cable device should appear

### No Audio in OBS/Discord

1. Verify B1 is enabled (status shows "running")
2. Verify an input is routed to B1 (check Input Matrix, B1 column should have toggles "On")
3. Verify B1 meter shows activity when you speak
4. Verify OBS/Discord is listening to the **correct side** of the virtual cable (recording/input, not playback)
5. Verify sample rates match (all set to 48 kHz or 44.1 kHz)
6. Test with `pnpm tauri dev` and check browser console for errors

### Feedback Loop / Howling

You've routed B1 to speakers AND have an input also outputting to speakers.

Solution:
1. Remove the input from speaker output
2. Keep B1 **only** assigned to virtual cable
3. Use headphones for monitoring on a separate input

### Audio Too Quiet or Too Loud

1. Adjust B1 **volume slider** in AudioManager
2. Adjust **send volume** for each input in the Input Matrix
3. Adjust **input master gain** for each input device
4. Verify OBS/Discord input levels are normalized (not clipping)

### Crackling / Dropouts

1. Check sample rates match (see above)
2. Reduce buffer sizes if possible (lower latency = more CPU; higher = more latency)
3. Close other high-CPU applications
4. Update audio drivers (Windows Update or manufacturer's website)

## Next Steps

- Read [ARCHITECTURE.md](ARCHITECTURE.md) to understand the audio pipeline
- Check [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for more issues
- Explore other buses (A1, A2, B2) for different routing configurations
