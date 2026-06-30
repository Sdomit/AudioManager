# Handoff — UI/UX settings pass (buttons, cards, node graph)

Branch: `claude/sweet-brahmagupta-2b60b1` (committed, not pushed). Frontend-only.
tsc clean, 205 vitest tests pass. Verified live in the Tauri app.

## Goal

Whole-tool UI pass: real buttons everywhere, polished bus cards, proper
Flow/Nodes/Matrix switch + canvas toolbar, snap-to-grid, output nodes pinned
right, and select-node → push detail panel + zoom-to-fit.

## Root cause that gated everything

`src/components/audio-manager/base.css` reset `.audioManager button { background:none;
border:none; padding:0 }` had specificity (0,1,1), beating every component's
single-class button style (0,1,0) → all buttons rendered as flat text app-wide.
Fix: wrap the button + input/select resets in `:where(...)` (zero specificity).
One change un-clobbered every component button/input/select.

## Changes (all under src/components/audio-manager/)

- **base.css** — `:where()` zero-specificity reset (systemic button fix).
- **SettingsSheet.tsx / .module.css** — tabs/close/select scoped to win over the
  reset; density button-row → native `<select>` dropdown w/ chevron; device lists
  compacted.
- **BusCard.tsx / .module.css** — `min-height` (was fixed `height`) so the
  clipped Enable/Mute action row shows; Enable active → green (`.actionEnabled`);
  Mute shows `VolumeIcon` unmuted / `MuteIcon` (speaker-X) + solid red muted.
- **BusDetail.tsx / .module.css** — same green-enable + mute-icon-swap for parity.
- **useAudioManager.ts** — `setBusDevice` auto-enables a disabled bus when a
  device is assigned (with rollback on IPC failure).
- **NodeView.tsx / .module.css**:
  - Toolbar rebuilt: zoom segmented pill + standalone Snap / Reset layout /
    Add input (accent) / Group buttons, sized to match the view toggle.
  - Snap-to-grid: `GRID=20`, `snap` state (persisted `am.nodeView.snap`),
    `snapTo()` applied in node-drag; background grid brightens when on.
  - Output pinned right: `busColumnX` = right edge of visible viewport
    (`wrapSize.w`, not the 10k world); guarded re-pin effect on width change;
    bus x locked during drag via `busColXRef` (y still moves).
  - `fitToContent()` (zoom-out-only, re-center) + effect on `selKey` + `wrapSize.w`
    → selecting a node re-fits so inputs+effects+outputs stay visible while the
    detail panel (flex sibling in `.main`) narrows the canvas.

## How "push" works

`AudioManager.module.css .main` is `display:flex` (row); `RoutingView` is `flex:1`,
`DetailPanel` mounts on selection with fixed width → canvas auto-narrows. The
right-pin + `fitToContent` keep everything visible in the narrower canvas.

## Verify / run

VS2022 dev shell + `$env:CMAKE_POLICY_VERSION_MINIMUM=3.5` (CMake 4 vs opus) +
`$env:CARGO_TARGET_DIR=C:\ambuild` (MAX_PATH in worktree). The cmake crate also
needs the generator forced if it auto-picks "Visual Studio 18 2026":
`Launch-VsDevShell.ps1 -Arch amd64` then `npm run tauri dev`. Frontend also served
at http://localhost:1420 (Playwright for DOM/computed-style checks).

## Possible follow-ups

- Minor: right-pinned buses can clip ~30px when the view has leftover pan at
  <100% zoom before a fit fires; cosmetic, resolves on node-select fit / reset.
- Propagate mute-icon-swap to ConsoleView strip + InputRow/InputDetail if full
  consistency wanted (left as-is; they were already red-on-mute).
