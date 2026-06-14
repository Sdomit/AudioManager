# Using your phone as a wireless microphone

AudioManager can take your phone's microphone as an input over WiFi — no app to
install, no cloud. You scan a QR code, tap once, and the phone becomes a normal
mixer input you can route, level, mute, and record like any other source.

Good for voice, podcasts, calls, interviews, and streaming commentary. It is
**not** zero-latency live monitoring (you will hear a small delay); for that, a
wired mic is still the tool. See [latency.md](latency.md) for the numbers.

## Before you start

- Phone and PC on the **same WiFi** (not a "guest" network — see troubleshooting).
- Prefer **5 GHz or 6 GHz** WiFi; 2.4 GHz is the usual cause of dropouts.
- Keep the **phone screen on** while streaming (browsers stop the mic when the
  screen locks — the future app removes this limit).

## Pair the phone

1. In AudioManager: **Add input → Phone microphone**. A QR code appears.
2. If a **"Phones may not reach this PC"** banner shows, your firewall is
   blocking the port — fix it first (see [Firewall](#firewall) below).
3. On the phone, open the **camera** and scan the QR code, then tap the link.
4. The browser shows a **certificate warning** (expected — the connection is
   encrypted with a self-signed certificate generated on your PC):
   - **iPhone / Safari:** tap **Show Details → visit this website → Visit Website**.
   - **Android / Chrome:** tap **Advanced → Proceed to … (unsafe)**.
   You only do this once per phone.
5. The phone page loads and says *"Waiting for the desktop to accept…"*.
6. Back in AudioManager, the phone appears under **Phones** — click **Accept**.
7. On the phone, tap **Start mic** and allow microphone access.
8. The phone is now an input. Drag a wire from it to a bus (e.g. A1) to hear it.

## Tuning latency

On the paired phone row: **Fastest / Balanced / Stable**.

- **Fastest** — least delay, best on clean 5 GHz WiFi.
- **Balanced** (default) — normal voice.
- **Stable** — most buffering, fewest dropouts on weak/busy WiFi.

The `~N ms` figure is the buffering delay being added; the coloured dot is link
health (green good, amber jittery, red struggling). If it goes amber/red, step
down to Stable or move closer to the router.

## Firewall

The first time the phone server runs, Windows usually shows a Firewall prompt —
tick **Private networks** and **Allow access**. If you missed it (phones get
"site can't be reached" and the sheet shows the warning banner), open an
**elevated** PowerShell (Win+X → *Terminal (Admin)*) and run:

```powershell
New-NetFirewallRule -DisplayName "AudioManager Phone Pairing" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 47800-47809 -Profile Private
```

Remove it later with:

```powershell
Remove-NetFirewallRule -DisplayName "AudioManager Phone Pairing"
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Phone: "site can't be reached" | Firewall blocking the port | Run the firewall rule above; check the sheet's warning banner |
| Page loads, but never connects / no audio after Accept | Router **AP / client isolation** (common on guest WiFi) — devices can't reach each other | Use your main WiFi, not guest; disable "AP isolation" / "client isolation" in the router |
| No mic prompt / "can't capture audio here" | Insecure context or unsupported browser | Make sure you opened the **https** link and accepted the cert; use a current Chrome or Safari |
| "Microphone permission denied" | Permission blocked | Allow the mic for the site in the browser, reload, tap Start mic |
| Choppy / crackly audio | WiFi jitter | Switch to **Stable**; prefer 5/6 GHz; move closer to the router |
| Audio stops when the screen locks | Browser suspends capture on lock | Keep the screen on; this is a browser limit the native app will remove |
| Phone shows "Reconnecting" | Brief WiFi/sleep hiccup | It auto-recovers within the grace window; if it expires, re-scan a fresh QR |

## Privacy

The audio and the pairing token never leave your local network — there is no
cloud relay in the media path. The pairing token lives only in the QR code (in
the URL fragment, which is never sent to the server or written to logs), expires
if unused, and a paired session accepts only one phone at a time.

## Future: a native app

A native iOS/Android app (a thin wrapper around this same web client) is planned
to remove the two browser limits above — the certificate tap and the
screen-lock capture stop — and to enable background streaming. It is not part of
this version. See [capacitor-notes.md](capacitor-notes.md).
