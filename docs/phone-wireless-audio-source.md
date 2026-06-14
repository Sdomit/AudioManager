# Phone Wireless Audio Source

## Goal

Add a Remote Input plugin that lets a phone act as a wireless microphone/audio source for AudioManager over local WiFi. The first version should use a browser-based phone client so users can scan a QR code, grant microphone access, and stream voice into the AudioManager mixer without installing a native app.

## Product Flow

1. AudioManager creates a temporary phone input session.
2. AudioManager displays a QR code and short pairing code.
3. The phone opens a local web client from the QR code.
4. The phone user grants microphone permission and taps Start Mic.
5. The phone streams audio to AudioManager over WebRTC.
6. AudioManager exposes the phone as a normal input source with volume, mute, status, and latency controls.

## Recommended MVP Architecture

```text
Phone browser microphone
-> WebRTC peer connection
-> Opus mono audio, 48 kHz, 10 ms frames where possible
-> Local WiFi UDP media path
-> AudioManager WebRTC receiver
-> Remote Input plugin source
-> Mixer / stream output
```

Use WebRTC first instead of raw WebSocket or HTTP streaming. WebRTC is already built for real-time audio, UDP transport, packet loss handling, Opus audio, jitter buffering, and browser microphone permissions.

## Latency Strategy

The feature cannot be truly zero-latency over WiFi, but it should feel fast enough for voice, podcasts, calls, interviews, and streaming commentary.

Target ranges:

- Excellent: 20-50 ms
- Good / usable: 50-100 ms
- Noticeable but acceptable for speech: 100-150 ms
- Too delayed for live voice comfort: 200 ms or more

Latency comes from:

```text
phone mic capture
+ browser/app audio buffer
+ audio encode
+ WiFi transit
+ receiver jitter buffer
+ audio decode
+ AudioManager mixer buffer
= total input latency
```

Implementation choices to keep delay low:

- Keep the media path local on LAN/WiFi; do not route audio through cloud servers.
- Prefer WebRTC UDP media instead of TCP/WebSocket audio.
- Use Opus in low-latency voice mode.
- Prefer mono 48 kHz for the MVP.
- Use 10 ms Opus frames by default; experiment with 5 ms only if stable.
- Keep the receiver jitter buffer as small as safely possible.
- Add a user-facing latency mode: Fastest, Balanced, Stable.
- Avoid unnecessary phone-side processing by making echo cancellation, noise suppression, and auto gain configurable.
- Recommend 5 GHz or 6 GHz WiFi for lower jitter.
- Keep the phone awake during recording.

## Required UX

The phone input should feel like any other source in AudioManager:

- Device name, for example `Phone Mic - Sarah's iPhone`
- Connection state: Waiting, Connected, Reconnecting, Disconnected
- Input meter
- Mute
- Volume
- Latency mode
- Latency estimate
- Disconnect control
- Pair another phone

## Security And Pairing

The receiver must not allow arbitrary devices on the network to inject audio.

Minimum protections:

- Per-session random pairing token in the QR URL.
- Pairing code fallback for manual entry.
- Session expiry for unused pair links.
- Explicit user confirmation in AudioManager when a new phone connects.
- Reject unknown peers after the session is paired.
- Avoid logging microphone tokens or WebRTC secrets.

## Phased Implementation

### Phase 0: Feature Contract And Planning

Define the Remote Input plugin contract, source lifecycle, mixer integration points, and feature acceptance criteria.

### Phase 1: Pairing And Local Session Setup

Create the desktop-side session server, QR code, pairing token, device naming, and connection state model.

### Phase 2: Browser Phone Client

Build the phone web client with microphone permission, start/stop controls, WebRTC peer setup, Opus audio, and basic connection status.

### Phase 3: Desktop WebRTC Receiver

Receive WebRTC audio in AudioManager, decode it, and expose it as a mixer input source.

### Phase 4: Low-Latency Audio Pipeline

Tune buffering, jitter handling, Opus frame sizing, sample-rate conversion, and mixer buffer integration. Add Fastest, Balanced, and Stable latency modes.

### Phase 5: Reliability, Security, And Testing

Add reconnection, token expiry, permission failure handling, network error handling, metrics, automated tests, and docs.

### Future: Native Phone App

Only build native iOS/Android apps after the browser client proves the feature is valuable. A native app could improve background behavior, device naming, audio routing, and reliability, but it should not block the MVP.

