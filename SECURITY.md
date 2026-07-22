# Security Policy

## Reporting a Vulnerability

**Do not open a public issue for security bugs.**

Report privately via [GitHub Security Advisories](https://github.com/Sdomit/AudioManager/security/advisories/new).
Expect an initial response within 7 days.

Include: affected version, platform, reproduction steps, and impact.

## Scope

AudioManager opens a TLS listener on the local network for phone pairing. The
areas most worth scrutiny:

| Area | Code |
| --- | --- |
| Pairing token generation and verification | `src-tauri/src/net/session.rs`, `src-tauri/src/net/paired.rs` |
| TLS certificate generation and rotation | `src-tauri/src/net/tls.rs` |
| HTTP request handling and routing | `src-tauri/src/net/server.rs`, `src-tauri/src/net/signaling.rs` |
| Preset loading and deserialization | `src-tauri/src/presets.rs` |

## Design Notes

Relevant to assessing a finding:

- Pairing tokens are 122-bit UUID v4. Only their SHA-256 digest is persisted —
  the plaintext token never touches disk. Rationale for the unsalted single-pass
  hash is documented in `src-tauri/src/net/paired.rs`.
- Tokens travel in the URL **fragment**, so they are not sent to the server in a
  request line and do not land in server logs.
- Token comparison is constant-time.
- The listener binds to the local network only. Exposing it to the public
  internet is unsupported and out of scope.
- An attacker with write access to the app's config directory is **in** the
  threat model for injection, and **out** of scope for privilege escalation —
  that access already implies local compromise.

## Supported Versions

Pre-1.0. Only the latest `main` receives fixes.
