# AudioManager UI/UX Audit (native Windows app)

- Date: 2026-11-16
- Target: installed app `%LOCALAPPDATA%\AudioManager\audio-manager.exe`, About says **v0.1.0** (repo main is 0.1.1)
- Method: drove the real Tauri/WebView2 window via desktop control at 1456x819, maximized. Walked bus cards, device picker, Add input, Nodes/Flow/Matrix, input detail + DSP + sends, Settings (all 5 tabs), Light/Dark theme, Presets, Recordings, Live Sound Gate, Phone pairing, Stream setup, bus context menu, Console, Compact.
- Items marked **(main)** were re-checked in current source and still exist.

## P0: wrong information shown to the user

1. **Every dB label is wrong (main).** `adapters.ts` maps UI 0.5 to backend 1.0 (unity) and UI 1.0 to backend 2.0 (+6 dB). `units.ts:gainToDb` assumes 0.75 = unity at 80 dB per unit, so true unity reads **"-20 dB"** and max reads **"+20 dB"**. Tooltips repeat the claim ("0.75 = unity, up to +20 dB"). `ConsoleView.tsx:126` uses a third formula, `20*log10(vol/0.75)`, so the same fader reads **"-4 dB"** in Console. Fix: one helper, `20*log10(ui*2)`, used everywhere. Update tooltips.
2. **Stream Setup checklist is mock data (main).** `useAudioManager.ts:127` passes `mockStreamSetupSteps`. The sheet says "B1 -> CABLE Input configured" and "Microphone, System, Game routed" while B1 had no device and only one mic existed. The top-bar "Stream ● 2" badge comes from the same mock data. Users trust a go-live checklist, so this does real harm. Derive the steps from real state, or hide the feature until they are.

## P1: broken or misleading controls

3. **Bus card ⋮ "More options" does nothing (main).** `BusCard.tsx:173` handler is only `e.stopPropagation()`. The menu (Rename, Change device, Role) exists only on right-click. Wire ⋮ to open `BusContextMenu`.
4. **Default WebView2 context menu in release.** Right-click on non-custom areas shows Back / Refresh / Save as / Print / **Inspect**. Refresh drops UI state, and Inspect opens devtools. No `contextmenu` suppression found in `src`. Fix: `preventDefault` globally in production builds, keeping inputs/text selectable.
5. **Remove input is a bare "×" in the detail header, with no confirm or undo.** It reads as "close panel" (`InputDetail.tsx:106`). One click destroys the input together with its sends and DSP. Use a trash icon with a label, or add an undo toast. The app already has an undo stack.
6. **Console mode layout bug.** The fader bank renders as a floating box over the node canvas and detail panel instead of replacing the bus-card row.
7. **Escape-close swallows the next click.** After closing Preset, Recordings, or Live Sound Gate with Escape, the next top-bar click only shows a tooltip. Closing with × does not have this problem. A backdrop or focus trap probably outlives the close.
8. **Settings modal resizes and re-centers per tab.** The tab bar jumps vertically. A click on the next tab can land outside the modal, which closes it and hits whatever is underneath. During the audit this muted the B1 bus. Fix: give the modal a fixed height or anchor it to the top.

## P2: layout and flow

9. **Nodes view:** bus nodes render mid-canvas while the "BUSES" header sits at the far right edge. Zoom defaults to 56% on a fresh window, which makes node text unreadable. Fix: fit to content on first load and on resize.
10. **Layout shift on first signal:** the bus card grows when the spectrum appears, which pushes the whole routing area down about 40px. Reserve the spectrum height up front.
11. **Three different layouts per routing view.** Flow adds the Inputs sidebar. Nodes removes it. The view switcher moves to a different position, so muscle-memory clicks miss. The Cards/Console toggle disappears in Flow/Matrix.
12. **Matrix legend mismatch:** the legend says "send on" = red dot, but active cells use the bus color (yellow for A1).
13. **Add-input picker:** section headers ("Capture an app...", "Input devices") are misaligned with their items. The list includes `msedgewebview2.exe`, which is AudioManager's own WebView, so filter it out. Duplicate output names (two "27G1G4 (NVIDIA...)") cannot be told apart.
14. **Truncation everywhere:** "Micropho...", "Microphone (UG...", and "Microphone (UGREEN Ca...". The detail panel shows the device name 4 times (title, Device, Name, list) and truncates it each time. Show it once at full width.
15. **Blank first paint of about 3 s** on launch, with no skeleton or spinner.
16. **Phone pairing:** the firewall fix is a copy-paste elevated PowerShell command. Offer a "Fix (admin)" button. Opening the sheet silently creates a pairing session.
17. **Empty state:** two "Add input" CTAs show at once. The Flow canvas center stays blank with no hint.
18. **"SILENT" amber badge** shows on a healthy, enabled bus that simply has no inputs. Amber implies a problem, so use neutral grey.

## P3: polish and consistency

19. Density is called "Cozy" in the top bar and "Comfortable" in Settings.
20. Light theme: the native title bar stays black even though Settings says "title bar follows theme". Off-state toggles render black, so they read as ON. Meter tracks are nearly invisible.
21. Theme has no "System" option.
22. Live Sound Gate uses a link-chain icon, which does not convey its purpose. Several icon-only buttons (input row headphone/S/speaker, the round button next to Boost) need labels or tooltips.
23. Recordings default to an AppData path (`...m.sarmad.audiomanager\recordings`) that is hidden from most users. Default to Music\AudioManager. 32-bit float default makes files large. Int24 is a saner default.
24. About shows v0.1.0. Link contrast (red on dark) is low.
25. Settings > Virtual cable says nothing about the AMVC install that the banner asks for. Put the Install/Repair action there too.

## Suggested fix order
1 and 2 first (wrong data). Then 3, 4, 5, 7, 8 (small, high-trust). Then 6, 9, 10, 11 (layout). Batch P3 into one polish PR.

## State changes made during the audit
- Assigned **A1 Monitor -> Speakers (Realtek USB2.0 Audio)**. Not reverted, because the picker has no "none" option. Unassign manually if unwanted.
- Added, routed, and then removed a test mic input. Theme, density, and view were restored to Dark, Cozy, and Cards.
