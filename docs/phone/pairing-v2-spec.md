# Pairing v2 + polish — feature spec (for the next session)

Branch `phone-audio/pairing-v2`, forked from `phone-audio/mvp` (tip a67c899, pushed
to origin). Builds on the completed phone-mic feature (Phases 0–5 + stereo +
on-device controls + Podcast/Adaptive mode). Plan and build here; the mvp branch
is the safe backup — do NOT force-push or delete it.

## Goal
Four follow-up features, ranked by value. Plan each before building. Keep the
existing default behaviour intact (the phone-mic MVP works today — don't regress).

## 1. Persistent session — pair once, auto-reconnect, kick from the tool (HIGHEST value)
The feature that makes it a tool, not a demo.
- **Phone**: persist `{session, token}` (from `location.hash`) in `localStorage`; on
  revisit, auto-`hello` with the saved creds — no QR. Falls back to the QR flow if
  the saved session is gone/rejected.
- **Desktop**: sessions are in-memory today (`net::session` registry, lost on app
  restart). Persist accepted sessions to `app_local_data_dir` (id, **hashed** token,
  label, client kind/os, created/last-seen) and reload on boot. A returning phone
  re-hellos with a known token → recognised → **auto-accept** (trusted), no re-prompt.
- **Kick control**: a "Paired devices" list in the UI with Remove → deletes from the
  persisted store → that phone can't reconnect. `phone_remove_session` exists; needs
  persistence + management UI.
- **Security (must get right, review carefully)**: store the token **hashed**, never
  plaintext (constant_time_eq already exists in session.rs — reuse for the hash
  compare). Trusted-device = auto-accept; revoke = delete + (optionally) push `bye`.
  Consider a per-device expiry / "forget after N days". This phase is security-
  sensitive → adversarial review before merge (mirror the #44 review pass).
- Touch points: `net/session.rs` (registry + persistence), `presets.rs`-style JSON
  persistence pattern, `lib.rs` phone_* commands (list/remove/forget), `server.rs`
  hello path (auto-accept trusted), phone `main-phone.ts` + `core/signaling.ts`
  (save/restore creds), pairing sheet (Paired-devices list).

## 2. Editable device name (LOW effort, pairs with #1)
Correction: browsers **cannot** read the real hardware name (privacy — no API). So:
- Add an editable friendly-name field on the phone, saved in `localStorage`, sent in
  `hello.name` (protocol already carries `name`; desktop already shows it as `label`).
- With #1 the name persists across sessions. Frame as user-set, not auto-read.

## 3. Phone UI/UX redesign (LOW risk, high polish)
- **Hard rule: keep the phone client plain DOM + CSS** (it's `src/phone/main-phone.ts`
  + `phone.html` styles). Do NOT add React to the phone bundle — it bloats it and
  breaks the framework-free Capacitor-reuse contract (`src/phone/core/` must stay
  React-free; see docs/phone/architecture.md app-readiness invariants).
- Mobile-first: big thumb targets, safe-area insets (`env(safe-area-inset-*)`),
  dark, single-column, the level meter + mute as the hero, controls collapsible.
- Figma/Claude for mockups is fine; implement as hand-written CSS.

## 4. mDNS / `.local` instead of IP (LOWEST priority — consider deferring)
- The QR already hides the IP (user scans, never types). Real value = a name that
  survives DHCP IP changes (`audiomanager.local`; the TLS cert SAN already includes
  it — see net/tls.rs / decisions.md D1).
- Risk: phone mDNS support is inconsistent (iOS ok, Android/Chrome spotty) → must keep
  IP fallback. Medium effort, medium reliability risk. Do last or skip.

## Suggested order
#1 (with #2 folded in) → #3 polish → maybe #4. #1 is the headline; #2 is cheap and
interlocks with it; #3 is independent and low-risk; #4 is optional.

## Build/run reminders (carry over)
- Rust build needs the MSVC dev shell: `scripts/win-dev-shell.ps1 <cmd>` (audiopus
  builds libopus via cmake). `scripts/win-dev-shell.ps1 pnpm tauri dev` to run.
- Phone server needs the inbound firewall rule (already added on this machine):
  ports 47800–47809, Private. See docs/phone/user-guide.md.
- Verify: `cargo test --lib`, `pnpm test`, `pnpm build` + `pnpm build:phone`.
- Each feature = its own commit/PR; keep the default path unchanged; adversarially
  review the persistence/security work before merge.
