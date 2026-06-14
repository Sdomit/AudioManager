# Phone Wireless Audio — Network & slow-WiFi guide

How to make the phone-mic path reliable, especially for podcasting and weaker
WiFi. The single biggest lever is the **network**: treat it like an audio system,
not ordinary home WiFi. See [latency.md](latency.md) for the latency model and
[user-guide.md](user-guide.md) for pairing/troubleshooting.

## WiFi that actually works for live speech

| Item | Recommendation |
|---|---|
| Band | **5 GHz or 6 GHz** — never 2.4 GHz (congested, jittery, the #1 dropout cause) |
| PC backhaul | **Wired Ethernet** for the PC; keep only the phones on WiFi |
| Access point | A **dedicated AP** for the phones if you can — fewer competing clients |
| Channel width | 20 MHz is the safe default; 40 MHz only in a clean single-room setup |
| QoS | Enable **WMM** on the AP; it prioritises voice traffic |
| Network | Phones on your **main** network, not a guest SSID (guest/AP isolation blocks the media path entirely) |
| RF | One room, one AP; avoid roaming between APs mid-session |

A dedicated 5/6 GHz AP with the PC on Ethernet is the difference between
"occasional crackle" and "rock solid" for a multi-phone podcast.

## Slow / lossy WiFi survival kit

When the link is weak (the health dot goes amber/red, drops climb), in order:

1. **Switch the input to Podcast (Adaptive).** It auto-grows buffering, recovers
   lost packets with Opus FEC, and corrects clock drift — built for exactly this.
   Watch the `FEC n` and `drift ±N ppm` readouts; a **weak link** flag means the
   link, not the tool, is the limit.
2. **Turn on "Low bandwidth" on the phone.** Caps the Opus send rate to ~28 kb/s —
   still clean for speech, far less airtime to lose. No reconnect needed.
3. **Move the phone closer to the AP**, or switch it to 5/6 GHz if it was on 2.4.
4. **Turn off battery saver on the phone** (a "battery saver" tag shows on the
   desktop when it's on) — it can throttle the radio and the mic.
5. Keep the **phone screen on** (browsers stop the mic on lock).

## Multi-phone podcast

Each phone is its own session and its own routable mixer input — pair as many as
you need and record/route them independently. In Podcast (Adaptive) each phone's
playout is locked to the PC's audio clock by the drift compensator, so the phones
stay coherent with each other through that shared clock. For speech this is all
the alignment you need; broadcast-style sample-locking (a clap-sync reference)
isn't necessary and isn't implemented.

## Measuring on your own setup

- Watch the per-phone **drops**, **FEC**, **drift ppm**, and the health dot live in
  the pairing sheet — they tell you whether to step down a mode or fix the WiFi.
- For real end-to-end latency, use the recorder method in [latency.md](latency.md).
- For a long-haul check, run a 30–60 min recording in Podcast (Adaptive) and
  confirm `drift ppm` stays well under ±300 (saturation = a genuinely mismatched
  clock or an overrun) and drops stay near zero.
