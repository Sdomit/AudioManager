# Code signing (Windows)

Releases ship **unsigned** today, so Windows SmartScreen shows "unknown
publisher" (see [INSTALL.md](INSTALL.md)). To remove that warning:

## 1. Get an Authenticode certificate
- **OV** (Organization Validation) — cheaper (~$200-400/yr) but SmartScreen
  reputation builds slowly. Ships as an importable `.pfx`.
- **EV** (Extended Validation) — instant SmartScreen trust (~$300-600/yr), ships
  on a hardware token / HSM. Recommended for public distribution.

Vendors: DigiCert, Sectigo, GlobalSign, SSL.com.

## 2. Point Tauri at it
Add to `src-tauri/tauri.conf.json` under `bundle.windows`:
```json
"certificateThumbprint": "<SHA1 thumbprint of the installed cert>",
"digestAlgorithm": "sha256",
"timestampUrl": "http://timestamp.digicert.com"
```
The cert must be in the build machine's cert store (OV `.pfx`) or reachable via
the token CSP (EV). Then `pnpm tauri build` signs the exe **and** installer
automatically.

## 3. CI (release.yml)
- **OV**: add a step before `tauri-apps/tauri-action` that imports the pfx
  (`Import-PfxCertificate`) from `secrets.WINDOWS_CERT_PFX` +
  `secrets.WINDOWS_CERT_PASSWORD`, then set the thumbprint in config.
- **EV**: hardware tokens generally can't run on hosted runners — sign on a
  self-hosted runner or locally.

Until a cert exists, leave the config unsigned; the build works, users just
click through SmartScreen.
