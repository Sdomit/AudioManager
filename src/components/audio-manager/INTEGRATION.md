# AudioManager UI — Integration guide

This directory contains a complete React + TypeScript UI for the AudioManager redesign described in `docs/UI_REDESIGN_PLAN.md`. Drop the whole `audio-manager/` folder into your project, mount `<AudioManager />`, and you're rendering. Wiring it to your real Tauri backend is a separate, well-bounded step.

> **Status:** Pure UI. Ships with a mock data layer (`mockData.ts` + `useAudioManager.ts`) so it runs in isolation. No backend changes. No audio engine changes. No preset schema changes.

---

## What's in here

```
src/components/audio-manager/
├── AudioManager.tsx          ← top-level shell, mount this
├── AudioManager.module.css
├── tokens.css                ← design system tokens (CSS variables)
├── base.css                  ← scoped resets + font import
├── types.ts                  ← all public types
│
├── TopBar.tsx                ← wordmark, presets, stream pill, density, settings
├── PresetBanner.tsx          ← "preset loaded, buses not auto-started" banner
├── BusRail.tsx               ← 4-card horizontal rail (A1/A2 | B1/B2)
├── BusCard.tsx               ← single bus card, all 6 visual states
├── MeterCanvas.tsx           ← Canvas-based animated meter
│
├── InputList.tsx             ← left column: search + rows + add
├── InputRow.tsx              ← one input row
│
├── RoutingView.tsx           ← center column shell + view toggle
├── MatrixView.tsx            ← spreadsheet-grid routing
├── FlowView.tsx              ← chip-based routing (default)
│
├── DetailPanel.tsx           ← right column shell
├── InputDetail.tsx           ← detail view for selected input
├── BusDetail.tsx             ← detail view for selected bus
│
├── StreamSetupSheet.tsx      ← slide-in sheet with live checklist
│
├── Pill.tsx, Icon.tsx        ← small reusable primitives
│
├── useAudioManager.ts        ← state + actions hook (mock by default)
├── mockData.ts               ← seed data: 10 inputs, 4 buses, sends, presets
├── tauriCommands.ts          ← placeholder invoke() wrappers
│
├── index.ts                  ← barrel export
└── INTEGRATION.md            ← this file
```

All `.module.css` files are colocated next to their components. No external CSS dependencies beyond two `@import url(...)` lines at the top of `base.css` that pull Geist from a CDN — replace those with self-hosted fonts before shipping.

---

## Drop-in: zero-change preview

Once you copy the folder into your project at `src/components/audio-manager/`, you can preview it without touching anything else:

```tsx
// src/App.tsx (or a temporary preview page)
import { AudioManager } from "./components/audio-manager";

export default function App() {
  return (
    <div style={{ height: "100vh", width: "100vw" }}>
      <AudioManager />
    </div>
  );
}
```

That's it. The mock data layer simulates meters and lets you click around. Save a preset, load a preset, toggle the matrix/flow view, switch density, open the stream setup sheet — everything works against fake state.

**Visual checklist after first mount:**

- Top bar with `AudioManager` wordmark, preset dropdown showing "Stream — Twitch", stream pill, density toggle.
- Info banner under the top bar saying the preset is loaded and buses are off.
- Bus rail with 4 cards showing all the requested states: A1 idle, A2 idle, B1 clipping, B2 unconfigured. Click a card to select it in the detail panel.
- Inputs list on the left with 10 inputs and a working search box.
- Flow view in the middle showing per-input bus chips. Click a chip to toggle the send. Click the Matrix toggle in the routing header to swap views.
- Detail panel on the right showing the Microphone (currently selected). Per-send gains, per-send mutes, all working.
- Click the Stream pill in the top bar to open the Stream Setup sheet. Esc or click backdrop to close.

---

## Wiring to your Tauri backend

The mock hook lives in `useAudioManager.ts`. Replace its internals with your real backend calls. The component tree never changes — only the hook does.

### 1. Wire the reads

In `useAudioManager()`'s reducer state, replace the `initialState` defaults with values from Tauri:

```ts
import { useEffect, useReducer } from "react";
import { invoke } from "@tauri-apps/api/core";

const [state, dispatch] = useReducer(reducer, initialState);

useEffect(() => {
  (async () => {
    const [buses, inputs, sends, presets] = await Promise.all([
      invoke<Bus[]>("list_buses"),
      invoke<AudioInput[]>("list_inputs"),
      invoke<Send[]>("list_sends"),
      invoke<Preset[]>("list_presets"),
    ]);
    dispatch({ type: "hydrate", buses, inputs, sends, presets });
  })();
}, []);
```

You'll need to add a `hydrate` action to the reducer.

### 2. Wire the writes

Each action in the hook currently dispatches locally. Make it also call Tauri:

```ts
const setBusVolume = useCallback(async (id: BusId, volume: number) => {
  dispatch({ type: "set_bus_volume", id, volume });   // optimistic local update
  await invoke("set_bus_volume", { id, volume });     // real call
}, []);
```

The action names in `tauriCommands.ts` are placeholders — replace `set_bus_volume`, `set_bus_enabled`, `toggle_send`, etc. with whatever your `#[tauri::command]` handlers are named.

### 3. Wire meter events

The mock hook fakes meters with a `requestAnimationFrame` loop. Delete that effect and replace it with a Tauri event subscription:

```ts
import { listen } from "@tauri-apps/api/event";

useEffect(() => {
  let unlisten: (() => void) | null = null;
  (async () => {
    unlisten = await listen<MeterPayload>("meters", (event) => {
      dispatch({
        type: "tick_meters",
        busLevels: event.payload.buses,
        inputLevels: event.payload.inputs,
      });
    });
  })();
  return () => unlisten?.();
}, []);
```

The payload shape (`MeterPayload`) is stubbed in `tauriCommands.ts` — adjust it to match what your Rust backend actually emits.

### 4. Wire device pickers

Two callbacks are stubbed with `console.log`:

- `onPickDevice` in the BusRail
- `onPickDevice` in the DetailPanel

Replace those with whatever device-picker modal you want to show. The picker should call `am.setBusDevice(busId, deviceId)` on confirm.

---

## Styling notes

### Design tokens

All visual primitives are CSS variables defined in `tokens.css` under `:root`. Reference them with `var(--am-...)`. To rebrand:

- **Accent color** — change `--am-accent`, `--am-accent-hover`, `--am-accent-active`, `--am-accent-muted`, `--am-accent-ring`. They're red by default (`#EF4444` family).
- **Bus tints** — `--am-bus-a1`, `--am-bus-a2`, `--am-bus-b1`, `--am-bus-b2` and their `*-muted` variants. Keep them visually distinct from accent and from each other.
- **Fonts** — `--am-font-ui` and `--am-font-mono`. Currently Geist + Geist Mono via CDN; swap the `@import` lines in `base.css` for your self-hosted fonts.

### Density

Density is a state-driven `data-density` attribute on the root `.audioManager` element. Tokens have a `.audioManager[data-density="compact"]` block in `tokens.css` that overrides spacing and font sizes. Add new compact overrides there.

### Scope

`base.css` and all component styles are scoped under `.audioManager` (via CSS Modules for component styles, and explicit class scoping in `base.css`). They will not leak to the rest of your app.

### CSS Modules

Each `.module.css` is consumed via `import styles from "./Foo.module.css"`. Your bundler must be configured for CSS Modules. Vite supports this out of the box.

---

## TypeScript

- All types are exported from `index.ts`.
- The codebase uses strict typings — no `any`. A small handful of `as any` casts exist where CSS custom-property names are assigned via `style={{ ["--bus-accent" as any]: ... }}`; this is the standard React workaround for typed inline styles with CSS variables.
- If your `tsconfig.json` has `verbatimModuleSyntax: true`, the type-only imports already use `import type`.
- `tauriCommands.ts` has a self-stub for `invoke()` so the file compiles in isolation. Delete the stub and uncomment `import { invoke } from "@tauri-apps/api/core"` when wiring.

---

## Accessibility

Already in: keyboard focus rings, ARIA labels on meters/cells/buttons, `prefers-reduced-motion` respected in `tokens.css`, color + shape state encoding (Pill component uses both).

Not yet in (Phase F per the plan): a global hotkey overlay, full screen-reader sweep, an explicit "high contrast" theme. The skeleton is in place — add hotkeys via a `useEffect` listener at the AudioManager level, and the overlay component itself wherever you keep app-wide chrome.

---

## What's deliberately NOT here

Per your original task scope:

- **No backend changes.** Nothing in `src-tauri/` is touched.
- **No new audio features.** Limiters, EQ, sample-rate conversion, recording-to-disk — all roadmap items.
- **No preset schema changes.** The `Preset` type matches V2's shape; V1 migration stays on the Rust side.
- **No `App.tsx` or `App.css` edits in this folder.** You mount `<AudioManager />` from your own `App.tsx` when you're ready.
- **No GitHub repo creation, no git operations, no shell calls.**

---

## Next steps

1. **Drop the folder** into `src/components/audio-manager/` in your repo.
2. **Render `<AudioManager />`** somewhere visible (a new route, or temporarily replacing `App.tsx`'s content).
3. **Run `pnpm tsc --noEmit`** to confirm everything compiles in your project's TypeScript config.
4. **Walk through the visual checklist** above.
5. **Decide what to wire first** — usually `list_buses` + `list_inputs` so real device names appear, then meter events so the UI feels live, then writes.

If something breaks or you want a piece redesigned, tell me which file/component and I'll iterate on just that.
