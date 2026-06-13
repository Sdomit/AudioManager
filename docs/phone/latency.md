# Phone Wireless Audio — Latency

Phase 4 (#43) deliverable: the latency model, the three modes, how to measure
real end-to-end delay, and the network conditions that keep it low. See
[architecture.md](architecture.md) for the pipeline and
[decisions.md](decisions.md) D5 for the jitter-buffer design.

## Where the delay comes from

```
phone mic capture + browser buffer ─┐
Opus encode (frame size)            │  phone side (~30–50 ms, not tunable
WiFi transit                        │  from the desktop; a native app could
────────────────────────────────────┘  shave the browser buffer)
jitter buffer hold (mode)           ─┐
Opus decode                         │  desktop side (what we control)
mixer ring + output device buffer   ─┘
```

Only the desktop side is tunable here. The phone's capture + browser audio
buffer is a fixed floor (roughly 30–50 ms on Android Chrome) that the browser
MVP cannot remove — it is the main reason the native-app tier exists.

## The three modes

The jitter buffer holds a reorder window of N Opus frames (~20 ms each) before
releasing audio at the arrival rate. Larger window = more delay, fewer dropouts.

| Mode | Window | Added desktop delay (window + ring) | Use when |
|---|---|---|---|
| **Fastest** | 1 frame | ~20–40 ms | clean 5/6 GHz WiFi, want minimum delay |
| **Balanced** (default) | 2 frames | ~40–60 ms | normal voice streaming |
| **Stable** | 5 frames | ~100–120 ms | weak/busy WiFi, prioritise no dropouts |
| **Podcast (Adaptive)** | 2–12 frames (auto) | floats with the link | long recordings / lossy WiFi |

### Podcast (Adaptive) mode

An opt-in robust mode that adds three receiver-side features the fixed modes don't
have. It is the right choice for long podcast recordings and weak WiFi; the fixed
modes are otherwise unchanged.

- **Adaptive jitter depth** — the window floats in [2, 12] frames: it grows fast on
  loss and shrinks slowly on a sustained-clean link, so latency stays low when the
  network is good and only rises while it's troubled.
- **Opus in-band FEC recovery** — when a packet is lost but its successor has
  arrived, the lost frame is *reconstructed* from the successor's FEC data instead
  of being concealed. Recovers real audio on lossy WiFi (the `FEC n` readout counts
  recoveries).
- **Clock-drift compensation** — over a long session the phone's and PC's 48 kHz
  clocks drift apart; the mode trims the playout rate by a few ppm to hold the
  buffer steady, instead of the periodic glitch the fixed modes get. The `drift
  ±N ppm` readout shows the live trim; a **weak link** flag appears if the trim
  saturates (±300 ppm) or the feed is overflowing.

These run only in Adaptive; selecting Fastest/Balanced/Stable is byte-for-byte the
prior behaviour.

The mixer ring is capped at ~80 ms (`REMOTE_RING_SIZE`) so clock drift or
arrival bursts cannot silently accumulate latency the way a large ring would.
Switching mode is live (no reconnect): the feeder reads the new window on the
next packet.

## Health indicator (pairing sheet)

Each live phone shows `~N ms` — the **measured** buffered depth
(`jitter_depth × 20 ms`), i.e. the delay we are currently adding — and a dot:

- **green** — under ~1 concealed frame/s (healthy)
- **amber** — ~1–5/s (jittery; consider Stable)
- **red** — over ~5/s (struggling; check WiFi / move closer / use Stable)

The cumulative `N drops` count is concealed (PLC) frames since connect.

## Measuring real end-to-end latency

The buffered-ms figure is the desktop-added delay only. To measure true
acoustic round path (speak → hear on the bus):

1. Route the phone to a bus with a known output device.
2. Start a recording of that bus (the app's recorder is sample-accurate).
3. Produce a sharp transient both at the source and in the captured audio:
   easiest is to tap the phone mic hard (or play a click out a desktop speaker
   that the phone mic picks up) while recording.
4. Open the WAV; measure the sample offset between the source click and its
   appearance on the recorded bus. `offset / 48000` = end-to-end seconds.
5. Repeat per mode. Subtract a wired-mic baseline run to isolate the wireless
   path from the soundcard's own I/O latency.

Target (healthy home WiFi, desktop wired or on 5 GHz): Balanced comfortably
under ~110 ms, Fastest under ~80 ms, and never the 200 ms+ that feels broken
for live voice (#45).

## Keeping it low

- **Use 5 GHz or 6 GHz WiFi.** 2.4 GHz is congested and jittery; it is the most
  common cause of red-health dropouts.
- **Keep the phone on the same LAN**, not a guest network (guest/AP isolation
  breaks the media path entirely — see the troubleshooting docs).
- **Keep the phone screen on** while streaming (browser suspends capture on
  lock — wake lock helps but is not guaranteed; the native app removes this).
- Prefer **Fastest** only on a clean link; drop to **Balanced/Stable** the
  moment the health dot goes amber/red.
- The media path is **local only** — no cloud relay — so transit is one WiFi hop.

## Frame size (ptime) — evaluated, deferred

#43 suggests trying 10 ms Opus frames for the Fastest tier. We ship 20 ms
frames (the browser default) for now:

- Going to 10 ms saves at most ~10 ms of frame-fill latency but **doubles** the
  packet rate (more overhead and more loss sensitivity), and browser `ptime`
  negotiation is honoured inconsistently across Chrome/Safari versions.
- Mode changes are live; switching ptime would force a WebRTC renegotiation per
  toggle, adding complexity for a marginal, device-dependent gain.

It is a clean future tuning knob: set `maxptime`/`ptime` in the answer fmtp for
Fastest and renegotiate on mode change. Revisit if real measurements show the
frame-fill term dominating after the WiFi and ring terms are minimised.
