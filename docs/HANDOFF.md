# Handoff — idle input meter + bus card UI
20260617-000639 · repo AudioManager · branch main

## Goal
Input level meters show real signal for unrouted (idle) inputs — no monitoring
required. Bus cards redesigned with left accent stripe, dashed unconfigured
border, VOL label, slider thumb. Dropdown portal escapes rail clipping.

## Status
- Done: Bus card redesign + dropdown React portal fix — `fd495d7`
- Done: Metering tap infrastructure (`metering_tap.rs` + `sync_metering_taps` +
  `get_system_status` merge) — `718873d`
- Done: Root cause fixed — f32-only guard in `metering_tap.rs` rejected every
  Windows mic (native Int16/Int32); removed guard so cpal/WASAPI converts —
  `b9f2b39`
- All three commits on `origin/main`. Branch clean.

## Next step
Pull on other PC (`git pull`), run the app, add a mic input, confirm meter
moves without enabling monitoring.

## Key files
- `src-tauri/src/audio/metering_tap.rs` — lightweight per-device capture tap;
  peaks stored in AtomicU32; Drop stops thread cleanly
- `src-tauri/src/lib.rs` — `sync_metering_taps()` reconciles taps to
  `graph.list_inputs()` (Device-type only); `get_system_status` merges tap
  peaks for devices NOT captured by a running engine
- `src/components/audio-manager/BusCard.tsx` + `.module.css` — redesigned card
- `src/components/audio-manager/BusDeviceDropdown.tsx` — portal fix

## Decisions & gotchas
- Taps key off `graph.list_inputs()` → only inputs added via Phase 8B
  `add_input` command get taps; legacy `start_passthrough` path ALSO adds to
  the graph (line 507 in lib.rs), so both paths covered
- When engine IS running for a device, `get_system_status` skips the tap peak
  (`contains_key` guard) — engine peaks take priority
- `metering_tap::start` passes `device_id` as cpal device name; must match
  `InputSourceSpec::Device { name }` exactly
- f32 guard was the only broken piece — rest of the tap architecture is correct
- Bus card `--bus-accent` CSS var controls left stripe color per bus

## Resume
- Branch: `main` (all committed + pushed to origin)
- Verify: `cargo check --manifest-path src-tauri/Cargo.toml` → no errors
- Open questions: none — feature should work after pull + rebuild

## Resume prompt (paste into new chat)
> Continue AudioManager development on branch main. Read docs/HANDOFF.md.
> Idle input meter feature is complete (b9f2b39). Pull and run the app to
> verify meters show without monitoring. Next feature TBD.
