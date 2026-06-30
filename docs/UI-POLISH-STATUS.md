# UI Polish Status

Snapshot after the polish pass (PRs #87 + #88). Use this to scope a follow-up
design pass.

The design system is mature: full token scales (color, spacing, radius, elevation,
motion, z-index), `prefers-reduced-motion` kill switch, focus-visible safety net,
compact-density mode. This was **polish**, not restyle.

---

## ✅ Done — do not redo

**Motion (PR #87, merged to main `854a449`):**
- SettingsSheet, TemplateDialog: backdrop fade + dialog pop-in
- BusContextMenu, TopBar preset/right-click menus: slide+scale entrance
- ConsoleView strip + mute: hover transitions

**Token hygiene (PR #88):**
- Colors → semantic tokens; remaining hardcoded hex now *only* intentional
  (QR-code white, bespoke solo-yellow, gradient stops, token fallbacks)
- Font-sizes 10–22px → `--am-text-*` across 24 files (compact-density now shrinks text)
- Hover transitions added to 7 snap-gap files
- New `--am-text-10` micro-label token

**Review-pass fixes (in #88):**
- `--am-meter-ok` (undefined, no fallback) → `--am-meter-low` — ConsoleView status
  dots were rendering invisible
- `--am-warn` typo → `--am-warning` + matching `--am-warning-muted` background
- `--am-drop-invalid` → `--am-meter-clip`

Verified: `tsc` clean, `vitest` 205/205, token-definition audit clean, reviewer
pass (1 finding, fixed). Live HMR-tested in `pnpm tauri dev`.

---

## 🔴 Needs a design eye — the actual design pass

Decisions, not mechanical. Could not be safely auto-fixed blind (no screenshot path
in this env — CDN font load blocks headless capture).

1. **NodeView / FlowView / MatrixView** — routing canvases. Wire colors, node cards,
   badges, drag affordances. Biggest unaudited visual surface.
2. **Cross-view alignment** — bus cards / input rows / detail panels sharing one grid
   across Flow / Nodes / Matrix / Console.
3. **Status-banner tone system** (CablePanel, CableNotice, AmvcBanner, PresetBanner) —
   ok/warn/error coloring is ad-hoc per file; unify.
4. **Light mode** — tokens are dark-only. None exists. Full palette task if wanted.
5. **Detail panels** (BusDetail, InputDetail, DspControls, EqGraph) — spacing/hierarchy.
6. **Mini Controller** (MiniPanel, Knob, MiniWindow) — proportions/motion vs main shell.
7. **Z-index system** — raw `100`/`110`/`200` live alongside the `--am-z-*` scale;
   `--am-z-overlay` is referenced but undefined (works via `900` fallback). Unify.

---

## Known parallel work (not part of this polish)

- `claude/ecstatic-cori-264b91` (on GitHub) — Settings 4→7 tab expansion + sidebar
  redesign + its own token hygiene. Awaiting Codex review. Separate from #87/#88.

## Verify path for a follow-up agent

- `node node_modules/typescript/bin/tsc --noEmit` (Bash — PowerShell mangles exit)
- `node node_modules/vitest/vitest.mjs run`
- `pnpm dev` → `preview_inspect` for exact computed styles (screenshots blocked)
- Real visual check: `pnpm tauri dev` (needs VS2026 dev shell + `CMAKE_POLICY_VERSION_MINIMUM=3.5`)
