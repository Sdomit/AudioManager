# Native phone app (Capacitor) — notes

Out of MVP scope. This records how a native wrapper slots into the existing
design without a redesign, so the work is a known quantity when it is picked up.
The browser MVP is deliberately shaped to make this a shell swap, not a rewrite
(see [architecture.md](architecture.md) "app-readiness invariants").

## Why a native app

Two limits are the browser's, not ours, and a native WebView removes both:

1. **Screen-lock capture stop.** Mobile browsers suspend `getUserMedia` when the
   screen locks or the tab backgrounds (a hard block on iOS WebKit; OEM-dependent
   on Android). The MVP mitigates with a wake lock + a "keep screen on" banner —
   accepted, but it is the main reason to go native.
2. **Certificate interstitial.** A native WebView is granted mic permission
   directly and can trust the cert programmatically, so the one-time
   "proceed past the warning" tap disappears.

A native app could also enable background streaming (phone in pocket), nicer
device naming, and — the bigger feature — true per-physical-mic / multi-channel
capture, which the browser cannot do (the OS hands web one fused mic).

## What it reuses, unchanged

`src/phone/core/` is framework-free by contract — no React, no Vite, no DOM
layout — just `getUserMedia` / `RTCPeerConnection` / `WebSocket`, which a
Capacitor WebView provides identically:

- `core/protocol.ts` — v1 message types + helpers
- `core/signaling.ts` — WS client + reconnect backoff
- `core/transport.ts` — RTCPeerConnection, offer, Opus-stereo SDP munge
- `core/capture.ts` — getUserMedia + level meter + wake lock
- `core/machine.ts` — connection state machine

A Capacitor project imports these as-is and supplies its own shell (instead of
`ui/` + `main-phone.ts`) plus the native bits below. **The desktop side needs
zero changes** — it only ever sees a v1 WebSocket then a standard WebRTC offer,
and never branches on `hello.client.kind`. Set `client.kind: "app"` in the hello
(informational only).

## Native bits to add

- **iOS:** background-audio entitlement (`UIBackgroundModes: ["audio"]`) +
  `AVAudioSession` category `playAndRecord` so the mic stays live under lock.
  Configure the WebView to accept the desktop's self-signed cert (or pin it).
- **Android:** a foreground service of type `microphone` (with
  `FOREGROUND_SERVICE_MICROPHONE` on Android 14+) and a persistent notification
  so capture survives lock/Doze; request battery-optimisation exemption.
- **Cert trust:** ship the desktop cert fingerprint to the app at pair time, or
  let the WebView trust the LAN origin, removing the interstitial.
- **Multi-mic (stretch):** native `AudioRecord` (Android) / `AVAudioSession`
  data-source selection (iOS) to capture individual mics; send each as its own
  WebRTC track. The desktop already models one feed per track — expose them as
  `phone:<sid>#mic0`, `#mic1` (multiple `remote::subscribe` feeds per session).

## Suggested layout

```
apps/phone-app/            # Capacitor project
  src/                     # imports ../../src/phone/core/* unchanged
  ios/  android/           # native shells + the entitlements above
```

Keep `src/phone/core/` the single source of truth; the app and the browser page
both consume it, so protocol/transport fixes land in one place.
