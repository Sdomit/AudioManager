# Installing AudioManager (Windows)

## Download

Grab the latest `AudioManager_<version>_x64-setup.exe` from the
[Releases](../../releases) page.

## Run the installer

1. Double-click the `.exe`.
2. **SmartScreen warning** — this build is not yet code-signed, so Windows shows
   "Windows protected your PC / unknown publisher". Click **More info → Run
   anyway**. (Code signing lands in a later release.)
3. Installs per-user — **no administrator prompt** required.
4. Launch **AudioManager** from the Start menu.

## Uninstall

Settings → Apps → AudioManager → Uninstall, or the entry in the Start menu.

## Virtual audio cable (optional)

AudioManager routes through any virtual audio device. To send audio between apps
(e.g. into OBS, Discord, Zoom):

1. Install a third-party virtual cable such as
   [VB-Cable](https://vb-audio.com/Cable/) and reboot.
2. In AudioManager, point an output bus at the cable's playback side; point the
   receiving app's microphone at the cable's recording side.

> The branded **AudioManager Virtual Cable** (one-click, named endpoints) ships
> separately once driver signing is complete. Until then, a third-party cable is
> the supported path.

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) if a device or the cable is not
detected.
