/**
 * useAudioManager — single hook returning state + actions.
 *
 * Default behavior: ships with mock data and simulates meter movement
 * via requestAnimationFrame so the UI feels alive without a backend.
 *
 * To wire to Tauri:
 *   1. Replace the useState mock initializers with values fetched from
 *      tauriCommands.listBuses() etc. on mount.
 *   2. In each action, call the matching tauriCommands.setBusXxx etc.
 *      after (or instead of) updating local state.
 *   3. Subscribe to the "meters" Tauri event and update bus.level /
 *      input.level from it.
 */

import { useCallback, useEffect, useReducer, useRef } from "react";

import * as ipc from "../../ipc/commands";
import { busRoleFor, uiVolumeToBackend } from "./adapters";
import { defaultDspConfig, defaultLimiter } from "./dspDefaults";
import { mockStreamSetupSteps } from "./mockData";
import {
  hydrate as fetchHydrate,
  loadPreset as tcLoadPreset,
  savePreset as tcSavePreset,
  deletePreset as tcDeletePreset,
  pollMeters,
  renameBus as tcRenameBus,
} from "./tauriCommands";
import type {
  ActiveRecording,
  AudioInput,
  AudioManagerState,
  Bus,
  BusId,
  BusRole,
  Density,
  DetailSelection,
  DspConfig,
  LimiterConfig,
  Preset,
  RecordingFile,
  RoutingView,
  Send,
  TapSpec,
  UseAudioManager,
} from "./types";
import { takeSnapshot, useHistory, type Snapshot } from "./useHistory";

function defaultBusRoleFor(id: BusId): BusRole {
  return busRoleFor(id);
}

/* ── State + reducer ────────────────────────────────────────────────────── */

const DEFAULT_PRESET_STORAGE_KEY = "audioManager.defaultPresetId";

function readDefaultPresetIdFromStorage(): string | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(DEFAULT_PRESET_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeDefaultPresetIdToStorage(id: string | null): void {
  try {
    if (typeof window === "undefined") return;
    if (id === null) window.localStorage.removeItem(DEFAULT_PRESET_STORAGE_KEY);
    else window.localStorage.setItem(DEFAULT_PRESET_STORAGE_KEY, id);
  } catch {
    // best-effort
  }
}

/* Bus role overrides — client-side icon/accent re-mapping.
 *
 * Stored per-user in localStorage so a user who wants A2 to act as
 * "Stream" (rather than the default "Speakers") sees the broadcast
 * icon + purple accent on the A2 card without any backend change.
 * Persisted only on this machine; not part of presets and not synced. */
const BUS_ROLE_OVERRIDES_STORAGE_KEY = "audioManager.busRoleOverrides";

function readBusRoleOverridesFromStorage(): Record<string, BusRole> {
  try {
    if (typeof window === "undefined") return {};
    const raw = window.localStorage.getItem(BUS_ROLE_OVERRIDES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Record<string, BusRole>;
    return {};
  } catch {
    return {};
  }
}

function writeBusRoleOverridesToStorage(map: Record<string, BusRole>): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      BUS_ROLE_OVERRIDES_STORAGE_KEY,
      JSON.stringify(map),
    );
  } catch {
    // best-effort
  }
}

const initialState: AudioManagerState = {
  buses: [],
  inputs: [],
  sends: [],
  presets: [],
  loadedPresetId: null,
  defaultPresetId: readDefaultPresetIdFromStorage(),
  presetBannerVisible: false,
  streamSetupOpen: false,
  streamSetupSteps: mockStreamSetupSteps,
  routingView: "nodes",
  density: "comfortable",
  selection: { kind: "none" },
  canUndo: false,
  canRedo: false,
  activeRecordings: [],
  recordingFiles: [],
  recordingsDir: null,
  recordingsPanelOpen: false,
};

type Action =
  | { type: "hydrate"; buses: Bus[]; inputs: AudioInput[]; sends: Send[]; presets: Preset[] }
  | { type: "set_bus_enabled"; id: BusId; enabled: boolean }
  | { type: "set_bus_muted"; id: BusId; muted: boolean }
  | { type: "set_bus_volume"; id: BusId; volume: number }
  | { type: "set_bus_device"; id: BusId; device: string | null }
  | { type: "rename_bus"; id: BusId; name: string }
  | { type: "set_bus_role"; id: BusId; role: BusRole | null }
  | { type: "set_bus_buffer_size"; id: BusId; frames: number | null }
  | { type: "set_bus_limiter"; id: BusId; limiter: LimiterConfig }
  | { type: "set_input_gain"; id: string; gain: number }
  | { type: "set_input_muted"; id: string; muted: boolean }
  | { type: "set_input_dsp"; id: string; dsp: DspConfig }
  | { type: "remove_input"; id: string }
  | { type: "add_input" }
  | { type: "toggle_send"; inputId: string; busId: BusId }
  | { type: "set_send_gain"; inputId: string; busId: BusId; gain: number }
  | { type: "set_send_muted"; inputId: string; busId: BusId; muted: boolean }
  | { type: "load_preset"; id: string }
  | { type: "save_preset"; name: string }
  | { type: "delete_preset"; id: string }
  | { type: "set_default_preset"; id: string | null }
  | { type: "dismiss_preset_banner" }
  | { type: "set_routing_view"; view: RoutingView }
  | { type: "set_density"; density: Density }
  | { type: "set_selection"; selection: DetailSelection }
  | { type: "open_stream_setup" }
  | { type: "close_stream_setup" }
  | { type: "tick_meters"; busLevels: Record<BusId, number>; inputLevels: Record<string, number> }
  | { type: "restore_snapshot"; snap: Snapshot }
  | { type: "set_undo_redo_flags"; canUndo: boolean; canRedo: boolean }
  | { type: "set_recordings"; recordings: ActiveRecording[] }
  | { type: "set_recording_files"; files: RecordingFile[] }
  | { type: "set_recordings_dir"; dir: string | null }
  | { type: "open_recordings_panel" }
  | { type: "close_recordings_panel" };

function reducer(state: AudioManagerState, action: Action): AudioManagerState {
  switch (action.type) {
    case "hydrate": {
      const inputIds = new Set(action.inputs.map((i) => i.id));
      const busIds = new Set(action.buses.map((b) => b.id));
      let selection = state.selection;
      if (
        (selection.kind === "input" && !inputIds.has(selection.inputId)) ||
        (selection.kind === "bus" && !busIds.has(selection.busId))
      ) {
        selection = { kind: "none" };
      }
      // Apply persisted role overrides so the user's chosen icon /
      // accent for each bus survives every backend hydrate. Adapter
      // can't know about localStorage; merge here.
      const overrides = readBusRoleOverridesFromStorage();
      const busesWithOverrides = action.buses.map((b) => {
        const ov = overrides[b.id];
        return ov ? { ...b, role: ov } : b;
      });
      return {
        ...state,
        buses: busesWithOverrides,
        inputs: action.inputs,
        sends: action.sends,
        presets: action.presets,
        selection,
      };
    }

    case "set_bus_enabled":
      return updateBus(state, action.id, (b) => ({
        ...b,
        enabled: action.enabled,
        state: deriveBusState({ ...b, enabled: action.enabled }, hasAnySend(state.sends, action.id)),
      }));

    case "set_bus_muted":
      return updateBus(state, action.id, (b) => ({ ...b, muted: action.muted }));

    case "set_bus_volume":
      return updateBus(state, action.id, (b) => ({
        ...b,
        volume: clamp01(action.volume),
      }));

    case "set_bus_device":
      return updateBus(state, action.id, (b) => {
        const next = { ...b, device: action.device };
        return { ...next, state: deriveBusState(next, hasAnySend(state.sends, b.id)) };
      });

    case "rename_bus":
      return updateBus(state, action.id, (b) => ({ ...b, label: action.name }));

    case "set_bus_role":
      // Apply the override (or fall back to the default role for the id)
      // and persist via the wrapper above. Reducer is pure — storage
      // write happens in the setBusRoleOverride action wrapper.
      return updateBus(state, action.id, (b) => ({
        ...b,
        role: action.role ?? defaultBusRoleFor(b.id),
      }));

    case "set_bus_buffer_size":
      return updateBus(state, action.id, (b) => ({ ...b, bufferSizeFrames: action.frames }));

    case "set_bus_limiter":
      return updateBus(state, action.id, (b) => ({ ...b, limiter: action.limiter }));

    case "set_input_gain":
      return updateInput(state, action.id, (i) => ({ ...i, gain: clamp01(action.gain) }));

    case "set_input_muted":
      return updateInput(state, action.id, (i) => ({ ...i, muted: action.muted }));

    case "set_input_dsp":
      return updateInput(state, action.id, (i) => ({ ...i, dsp: action.dsp }));

    case "remove_input":
      return {
        ...state,
        inputs: state.inputs.filter((i) => i.id !== action.id),
        sends: state.sends.filter((s) => s.inputId !== action.id),
        selection:
          state.selection.kind === "input" && state.selection.inputId === action.id
            ? { kind: "none" }
            : state.selection,
      };

    case "add_input": {
      const id = `in_new_${Date.now()}`;
      const next: AudioInput = {
        id,
        name: "New Input",
        kind: "microphone",
        device: "(choose a device)",
        gain: 0.7,
        muted: false,
        level: 0,
        dsp: defaultDspConfig(),
      };
      return { ...state, inputs: [...state.inputs, next], selection: { kind: "input", inputId: id } };
    }

    case "toggle_send": {
      const existing = state.sends.find(
        (s) => s.inputId === action.inputId && s.busId === action.busId,
      );
      let nextSends: Send[];
      if (existing) {
        nextSends = state.sends.filter(
          (s) => !(s.inputId === action.inputId && s.busId === action.busId),
        );
      } else {
        nextSends = [
          ...state.sends,
          { inputId: action.inputId, busId: action.busId, enabled: true, gain: 0.7, muted: false },
        ];
      }
      // Recompute bus state to catch silent → running transitions.
      const nextBuses = state.buses.map((b) => ({
        ...b,
        state: deriveBusState(b, hasAnySend(nextSends, b.id)),
      }));
      return { ...state, sends: nextSends, buses: nextBuses };
    }

    case "set_send_gain":
      return {
        ...state,
        sends: state.sends.map((s) =>
          s.inputId === action.inputId && s.busId === action.busId
            ? { ...s, gain: clamp01(action.gain) }
            : s,
        ),
      };

    case "set_send_muted":
      return {
        ...state,
        sends: state.sends.map((s) =>
          s.inputId === action.inputId && s.busId === action.busId
            ? { ...s, muted: action.muted }
            : s,
        ),
      };

    case "load_preset":
      // Mock: just flip the loaded id + show banner. Buses do NOT auto-start.
      return {
        ...state,
        loadedPresetId: action.id,
        presetBannerVisible: true,
        buses: state.buses.map((b) => ({ ...b, enabled: false, state: deriveBusState({ ...b, enabled: false }, hasAnySend(state.sends, b.id)) })),
      };

    case "save_preset": {
      const id = `preset_${Date.now()}`;
      return {
        ...state,
        presets: [
          ...state.presets,
          { id, name: action.name, version: 2, createdAt: Date.now(), updatedAt: Date.now() },
        ],
        loadedPresetId: id,
      };
    }

    case "delete_preset":
      return {
        ...state,
        presets: state.presets.filter((p) => p.id !== action.id),
        loadedPresetId: state.loadedPresetId === action.id ? null : state.loadedPresetId,
        defaultPresetId: state.defaultPresetId === action.id ? null : state.defaultPresetId,
      };

    case "set_default_preset":
      return { ...state, defaultPresetId: action.id };

    case "dismiss_preset_banner":
      return { ...state, presetBannerVisible: false };

    case "set_routing_view":
      return { ...state, routingView: action.view };

    case "set_density":
      return { ...state, density: action.density };

    case "set_selection":
      return { ...state, selection: action.selection };

    case "open_stream_setup":
      return { ...state, streamSetupOpen: true };

    case "close_stream_setup":
      return { ...state, streamSetupOpen: false };

    case "restore_snapshot": {
      const { snap } = action;
      const currentBusMap = new Map(state.buses.map((b) => [b.id, b]));
      const currentInputMap = new Map(state.inputs.map((i) => [i.id, i]));
      const nextSends = snap.sends.map((s) => ({ ...s }));
      const nextBuses: Bus[] = snap.buses.map((bs) => {
        const cur = currentBusMap.get(bs.id);
        const merged: Bus = cur
          ? {
              ...cur,
              device: bs.device,
              enabled: bs.enabled,
              muted: bs.muted,
              volume: bs.volume,
            }
          : {
              id: bs.id,
              role: "monitor",
              label: bs.id,
              device: bs.device,
              state: "idle",
              enabled: bs.enabled,
              muted: bs.muted,
              volume: bs.volume,
              level: 0,
              clipUntil: null,
              error: null,
              bufferSizeFrames: null,
              underruns: 0,
              overruns: 0,
              limiter: defaultLimiter(),
            };
        return {
          ...merged,
          state: deriveBusState(merged, hasAnySend(nextSends, merged.id)),
        };
      });
      const nextInputs: AudioInput[] = snap.inputs.map((is) => {
        const cur = currentInputMap.get(is.id);
        return cur
          ? { ...cur, name: is.name, kind: is.kind, device: is.device, gain: is.gain, muted: is.muted }
          : {
              id: is.id,
              name: is.name,
              kind: is.kind,
              device: is.device,
              gain: is.gain,
              muted: is.muted,
              level: 0,
              dsp: defaultDspConfig(),
            };
      });
      const inputIds = new Set(nextInputs.map((i) => i.id));
      const busIds = new Set(nextBuses.map((b) => b.id));
      let selection = state.selection;
      if (
        (selection.kind === "input" && !inputIds.has(selection.inputId)) ||
        (selection.kind === "bus" && !busIds.has(selection.busId))
      ) {
        selection = { kind: "none" };
      }
      return { ...state, buses: nextBuses, inputs: nextInputs, sends: nextSends, selection };
    }

    case "set_undo_redo_flags":
      return { ...state, canUndo: action.canUndo, canRedo: action.canRedo };

    case "set_recordings":
      return { ...state, activeRecordings: action.recordings };

    case "set_recording_files":
      return { ...state, recordingFiles: action.files };

    case "set_recordings_dir":
      return { ...state, recordingsDir: action.dir };

    case "open_recordings_panel":
      return { ...state, recordingsPanelOpen: true };

    case "close_recordings_panel":
      return { ...state, recordingsPanelOpen: false };

    case "tick_meters":
      return {
        ...state,
        buses: state.buses.map((b) => {
          const level = action.busLevels[b.id] ?? b.level;
          const clipping = level >= 1.0;
          return {
            ...b,
            level: b.enabled ? level : 0,
            clipUntil: clipping ? Date.now() + 2400 : b.clipUntil,
            state: deriveBusStateWithClip(b, hasAnySend(state.sends, b.id), clipping),
          };
        }),
        inputs: state.inputs.map((i) => ({
          ...i,
          level: i.muted ? 0 : action.inputLevels[i.id] ?? i.level,
        })),
      };

    default:
      return state;
  }
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

function updateBus(state: AudioManagerState, id: BusId, fn: (b: Bus) => Bus): AudioManagerState {
  return { ...state, buses: state.buses.map((b) => (b.id === id ? fn(b) : b)) };
}

function updateInput(state: AudioManagerState, id: string, fn: (i: AudioInput) => AudioInput): AudioManagerState {
  return { ...state, inputs: state.inputs.map((i) => (i.id === id ? fn(i) : i)) };
}

function hasAnySend(sends: Send[], busId: BusId): boolean {
  return sends.some((s) => s.busId === busId && s.enabled);
}

function deriveBusState(b: Bus, hasSends: boolean): Bus["state"] {
  if (b.error) return "error";
  if (!b.device) return "unconfigured";
  if (!b.enabled) return "idle";
  if (!hasSends) return "silent";
  return "running";
}

function deriveBusStateWithClip(b: Bus, hasSends: boolean, clipping: boolean): Bus["state"] {
  const base = deriveBusState(b, hasSends);
  if (base === "running" && (clipping || (b.clipUntil ?? 0) > Date.now())) return "clipping";
  return base;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/* ── The hook ───────────────────────────────────────────────────────────── */

export function useAudioManager(): UseAudioManager {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Undo/redo history. push() is called before each undoable mutation.
  // undo()/redo() return the snapshot to restore; we dispatch
  // restore_snapshot then reconcile the backend by walking the diff.
  const history = useHistory();
  const recordHistory = useCallback((coalesceKey?: string) => {
    const s = stateRef.current;
    history.push(takeSnapshot(s.buses, s.inputs, s.sends), coalesceKey);
  }, [history]);

  // Mirror history availability into the reducer state so UI components
  // can read it via state.canUndo / state.canRedo.
  useEffect(() => {
    dispatch({
      type: "set_undo_redo_flags",
      canUndo: history.canUndo,
      canRedo: history.canRedo,
    });
  }, [history.canUndo, history.canRedo]);

  // Phase C: hydrate buses/inputs/sends/presets from the Rust backend on
  // mount. Phase D will replace per-action dispatches with optimistic
  // dispatch + invoke; Phase E will replace the RAF meter loop below
  // with a real Tauri event subscription.
  // Initial hydrate. If a default preset is pinned AND it exists in the
  // backend's preset list, auto-load it via the safe-load path (sets
  // routes/gains/devices; the backend never auto-starts buses).
  const didAutoLoadDefault = useRef(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await fetchHydrate();
        if (cancelled) return;
        dispatch({
          type: "hydrate",
          buses: result.buses,
          inputs: result.inputs,
          sends: result.sends,
          presets: result.presets,
        });
        history.reset();

        if (didAutoLoadDefault.current) return;
        const pinned = readDefaultPresetIdFromStorage();
        if (!pinned) return;
        const exists = result.presets.some((p) => p.id === pinned);
        if (!exists) {
          // Default preset was deleted out-of-band; clear the pin.
          writeDefaultPresetIdToStorage(null);
          return;
        }
        didAutoLoadDefault.current = true;
        try {
          const warnings = await tcLoadPreset(pinned);
          if (cancelled) return;
          if (warnings.length > 0) {
            console.warn("Default preset load warnings:", warnings);
          }
          dispatch({ type: "load_preset", id: pinned });
          // Re-hydrate to pick up the backend's restored state.
          const after = await fetchHydrate();
          if (cancelled) return;
          dispatch({
            type: "hydrate",
            buses: after.buses,
            inputs: after.inputs,
            sends: after.sends,
            presets: after.presets,
          });
        } catch (e) {
          console.error("Default preset auto-load failed:", e);
        }
      } catch (e) {
        // Leave the UI in its empty initial state; surface in console
        // until Phase D wires an error banner.
        console.error("AudioManager hydrate failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Phase E: real meter loop.
  //
  // Backend doesn't emit events — it's poll-based via get_system_status.
  // We run TWO intervals:
  //
  //   1. METER_POLL_MS (~33 ms / 30 Hz) — fast path. pollMeters() calls
  //      get_system_status and dispatches tick_meters with only the
  //      level/peak maps. Backend reads + resets atomics; very cheap.
  //
  //   2. STATE_REFRESH_MS (~1000 ms) — slow path. Full hydrate to pick
  //      up out-of-band state changes (device errors surfacing on the
  //      audio thread, devices being unplugged, etc). Keeps bus.state,
  //      bus.error, bus.enabled in sync without paying for the heavier
  //      hydrate at meter speed.
  //
  // Both intervals pause when document.hidden so a minimised window
  // doesn't hammer the audio thread's atomics + IPC bridge.
  useEffect(() => {
    const METER_POLL_MS = 33;
    const STATE_REFRESH_MS = 1000;

    let cancelled = false;
    let meterInflight = false;
    let stateInflight = false;
    let meterTimer = 0;
    let stateTimer = 0;

    const tickMeters = async () => {
      if (cancelled || meterInflight || document.hidden) return;
      meterInflight = true;
      try {
        const { busLevels, inputLevels } = await pollMeters();
        if (cancelled) return;
        dispatch({ type: "tick_meters", busLevels, inputLevels });
      } catch (e) {
        // Don't spam the console on every failed tick.
        if (!cancelled) console.warn("pollMeters failed:", e);
      } finally {
        meterInflight = false;
      }
    };

    const tickState = async () => {
      if (cancelled || stateInflight || document.hidden) return;
      stateInflight = true;
      try {
        const [r, recs] = await Promise.all([
          fetchHydrate(),
          ipc.listActiveRecordings().catch(() => [] as ActiveRecording[]),
        ]);
        if (cancelled) return;
        dispatch({
          type: "hydrate",
          buses: r.buses,
          inputs: r.inputs,
          sends: r.sends,
          presets: r.presets,
        });
        dispatch({ type: "set_recordings", recordings: recs });
      } catch (e) {
        if (!cancelled) console.warn("state refresh failed:", e);
      } finally {
        stateInflight = false;
      }
    };

    meterTimer = window.setInterval(tickMeters, METER_POLL_MS);
    stateTimer = window.setInterval(tickState, STATE_REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(meterTimer);
      window.clearInterval(stateTimer);
    };
  }, []);

  /* ── Actions ──────────────────────────────────────────────────────────── */

  // rAF throttle: coalesce rapid-fire writes (e.g. slider drags) into at
  // most one Tauri invoke per animation frame. The Map is keyed so that
  // the same control overwrites its own pending task instead of queueing.
  const pendingWrites = useRef<Map<string, () => Promise<unknown>>>(new Map());
  const writeRaf = useRef(0);

  const flushWrites = useCallback(() => {
    writeRaf.current = 0;
    const tasks = Array.from(pendingWrites.current.values());
    pendingWrites.current.clear();
    for (const task of tasks) {
      task().catch((e) =>
        console.error("AudioManager throttled write failed:", e),
      );
    }
  }, []);

  const scheduleWrite = useCallback(
    (key: string, task: () => Promise<unknown>) => {
      pendingWrites.current.set(key, task);
      if (writeRaf.current === 0) {
        writeRaf.current = requestAnimationFrame(flushWrites);
      }
    },
    [flushWrites],
  );

  useEffect(
    () => () => {
      if (writeRaf.current) cancelAnimationFrame(writeRaf.current);
    },
    [],
  );

  const refresh = useCallback(async () => {
    try {
      const r = await fetchHydrate();
      dispatch({
        type: "hydrate",
        buses: r.buses,
        inputs: r.inputs,
        sends: r.sends,
        presets: r.presets,
      });
    } catch (e) {
      console.error("AudioManager refresh failed:", e);
    }
  }, []);

  const getBus = useCallback(
    (id: BusId) => stateRef.current.buses.find((b) => b.id === id),
    [],
  );
  const getInput = useCallback(
    (id: string) => stateRef.current.inputs.find((i) => i.id === id),
    [],
  );
  const getSend = useCallback(
    (inputId: string, busId: BusId) =>
      stateRef.current.sends.find(
        (s) => s.inputId === inputId && s.busId === busId,
      ),
    [],
  );

  const setBusEnabled = useCallback(
    (id: BusId, enabled: boolean) => {
      const prev = getBus(id)?.enabled ?? !enabled;
      recordHistory();
      dispatch({ type: "set_bus_enabled", id, enabled });
      ipc
        .setBusEnabled(id, enabled)
        .then(() => refresh())
        .catch((e) => {
          console.error("setBusEnabled failed:", e);
          dispatch({ type: "set_bus_enabled", id, enabled: prev });
        });
    },
    [getBus, refresh],
  );

  const setBusMuted = useCallback(
    (id: BusId, muted: boolean) => {
      const bus = getBus(id);
      if (!bus) return;
      const prev = bus.muted;
      recordHistory();
      dispatch({ type: "set_bus_muted", id, muted });
      ipc
        .setBusVolume(id, uiVolumeToBackend(bus.volume), muted)
        .catch((e) => {
          console.error("setBusMuted failed:", e);
          dispatch({ type: "set_bus_muted", id, muted: prev });
        });
    },
    [getBus],
  );

  const setBusVolume = useCallback(
    (id: BusId, volume: number) => {
      recordHistory(`bus_volume:${id}`);
      dispatch({ type: "set_bus_volume", id, volume });
      scheduleWrite(`bus-volume:${id}`, () => {
        const bus = getBus(id);
        if (!bus) return Promise.resolve();
        return ipc.setBusVolume(id, uiVolumeToBackend(bus.volume), bus.muted);
      });
    },
    [getBus, scheduleWrite],
  );

  const setBusDevice = useCallback(
    (id: BusId, device: string | null) => {
      const prev = getBus(id)?.device ?? null;
      recordHistory();
      dispatch({ type: "set_bus_device", id, device });
      ipc
        .setBusDevice(id, device)
        .then(() => refresh())
        .catch((e) => {
          console.error("setBusDevice failed:", e);
          dispatch({ type: "set_bus_device", id, device: prev });
        });
    },
    [getBus, refresh],
  );

  const renameBus = useCallback(
    (id: BusId, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const prev = getBus(id)?.label ?? "";
      dispatch({ type: "rename_bus", id, name: trimmed });
      tcRenameBus(id, trimmed)
        .then(() => refresh())
        .catch((e) => {
          console.error("renameBus failed:", e);
          dispatch({ type: "rename_bus", id, name: prev });
        });
    },
    [getBus, refresh],
  );

  const setBusRoleOverride = useCallback(
    (id: BusId, role: BusRole | null) => {
      const cur = readBusRoleOverridesFromStorage();
      const next: Record<string, BusRole> = { ...cur };
      if (role === null) delete next[id];
      else next[id] = role;
      writeBusRoleOverridesToStorage(next);
      dispatch({ type: "set_bus_role", id, role });
    },
    [],
  );

  const setBusBufferSize = useCallback(
    (id: BusId, frames: number | null) => {
      const prev = getBus(id)?.bufferSizeFrames ?? null;
      dispatch({ type: "set_bus_buffer_size", id, frames });
      // Rebuilds the engine, so refresh to pick up the resulting state
      // (running/error). Not throttled — discrete control, not a slider.
      ipc
        .setBusBufferSize(id, frames)
        .then(() => refresh())
        .catch((e) => {
          console.error("setBusBufferSize failed:", e);
          dispatch({ type: "set_bus_buffer_size", id, frames: prev });
          refresh();
        });
    },
    [getBus, refresh],
  );

  const setBusLimiter = useCallback(
    (id: BusId, limiter: LimiterConfig) => {
      dispatch({ type: "set_bus_limiter", id, limiter });
      scheduleWrite(`bus-limiter:${id}`, () => {
        const bus = getBus(id);
        if (!bus) return Promise.resolve();
        return ipc.updateBusDsp(id, { limiter: bus.limiter });
      });
    },
    [getBus, scheduleWrite],
  );

  const setInputGain = useCallback(
    (id: string, gain: number) => {
      recordHistory(`input_gain:${id}`);
      dispatch({ type: "set_input_gain", id, gain });
      scheduleWrite(`input-gain:${id}`, () => {
        const input = getInput(id);
        if (!input) return Promise.resolve();
        return ipc.setInputGain(
          id,
          uiVolumeToBackend(input.gain),
          input.muted,
        );
      });
    },
    [getInput, scheduleWrite],
  );

  const setInputMuted = useCallback(
    (id: string, muted: boolean) => {
      const input = getInput(id);
      if (!input) return;
      const prev = input.muted;
      recordHistory();
      dispatch({ type: "set_input_muted", id, muted });
      ipc
        .setInputGain(id, uiVolumeToBackend(input.gain), muted)
        .catch((e) => {
          console.error("setInputMuted failed:", e);
          dispatch({ type: "set_input_muted", id, muted: prev });
        });
    },
    [getInput],
  );

  const setInputDsp = useCallback(
    (id: string, dsp: DspConfig) => {
      dispatch({ type: "set_input_dsp", id, dsp });
      scheduleWrite(`input-dsp:${id}`, () => {
        const input = getInput(id);
        if (!input) return Promise.resolve();
        // DSP is stored per-input in the graph; the busId arg only selects
        // which running engine gets the live seqlock publish. Push to every
        // bus this input is routed to so whichever engine is live updates
        // immediately. With no routes, one call still persists it to the graph.
        const routed = Array.from(
          new Set(
            stateRef.current.sends
              .filter((s) => s.inputId === id)
              .map((s) => s.busId),
          ),
        );
        const targets: BusId[] = routed.length > 0 ? routed : ["A1"];
        return Promise.all(
          targets.map((busId) => ipc.updateInputDsp(busId, id, input.dsp)),
        );
      });
    },
    [getInput, scheduleWrite],
  );

  const removeInput = useCallback(
    (id: string) => {
      recordHistory();
      dispatch({ type: "remove_input", id });
      ipc
        .removeInput(id)
        .then(() => refresh())
        .catch((e) => {
          console.error("removeInput failed:", e);
          refresh();
        });
    },
    [refresh],
  );

  const addInput = useCallback(
    (deviceId: string) => {
      recordHistory();
      ipc
        .addInput(deviceId)
        .then(() => refresh())
        .catch((e) => {
          console.error("addInput failed:", e);
        });
    },
    [refresh],
  );

  const toggleSend = useCallback(
    (inputId: string, busId: BusId) => {
      const before = !!getSend(inputId, busId);
      const enabled = !before;
      recordHistory();
      dispatch({ type: "toggle_send", inputId, busId });
      ipc
        .setSend(inputId, busId, enabled)
        .then(() => refresh())
        .catch((e) => {
          console.error("toggleSend failed:", e);
          // Re-toggle to revert.
          dispatch({ type: "toggle_send", inputId, busId });
        });
    },
    [getSend, refresh],
  );

  const setSendGain = useCallback(
    (inputId: string, busId: BusId, gain: number) => {
      recordHistory(`send_gain:${inputId}|${busId}`);
      dispatch({ type: "set_send_gain", inputId, busId, gain });
      scheduleWrite(`send-gain:${inputId}|${busId}`, () => {
        const send = getSend(inputId, busId);
        if (!send) return Promise.resolve();
        return ipc.setSendGain(
          inputId,
          busId,
          uiVolumeToBackend(send.gain),
          send.muted,
        );
      });
    },
    [getSend, scheduleWrite],
  );

  const setSendMuted = useCallback(
    (inputId: string, busId: BusId, muted: boolean) => {
      const send = getSend(inputId, busId);
      if (!send) return;
      const prev = send.muted;
      recordHistory();
      dispatch({ type: "set_send_muted", inputId, busId, muted });
      ipc
        .setSendGain(
          inputId,
          busId,
          uiVolumeToBackend(send.gain),
          muted,
        )
        .catch((e) => {
          console.error("setSendMuted failed:", e);
          dispatch({ type: "set_send_muted", inputId, busId, muted: prev });
        });
    },
    [getSend],
  );
  const loadPreset = useCallback(
    (id: string) => {
      tcLoadPreset(id)
        .then((warnings) => {
          if (warnings.length > 0) {
            console.warn("Preset load warnings:", warnings);
          }
          // Backend resets routes/buses/inputs to preset state without
          // auto-starting buses. Hydrate refreshes UI; load_preset
          // reducer action sets loadedPresetId + presetBannerVisible.
          dispatch({ type: "load_preset", id });
          history.reset();
          refresh();
        })
        .catch((e) => {
          console.error("loadPreset failed:", e);
        });
    },
    [history, refresh],
  );

  const savePreset = useCallback(
    (name: string) => {
      tcSavePreset(name)
        .then(() => refresh())
        .catch((e) => {
          console.error("savePreset failed:", e);
        });
    },
    [refresh],
  );

  const deletePreset = useCallback(
    (id: string) => {
      if (stateRef.current.defaultPresetId === id) {
        writeDefaultPresetIdToStorage(null);
      }
      dispatch({ type: "delete_preset", id });
      tcDeletePreset(id)
        .then(() => refresh())
        .catch((e) => {
          console.error("deletePreset failed:", e);
          refresh();
        });
    },
    [refresh],
  );

  const renamePreset = useCallback(
    (oldId: string, newName: string) => {
      const trimmed = newName.trim();
      if (!trimmed || trimmed === oldId) return;
      // No backend rename: save under new name first; only if that
      // succeeds, delete the old. On any failure we refresh so the UI
      // reflects whatever the backend now holds (one, both, or neither).
      tcSavePreset(trimmed)
        .then(() =>
          tcDeletePreset(oldId).catch((e) => {
            console.error(
              `renamePreset: saved as "${trimmed}" but failed to delete old "${oldId}":`,
              e,
            );
          }),
        )
        .then(() => {
          // Move default-pin to the new name if the renamed preset was default.
          if (stateRef.current.defaultPresetId === oldId) {
            writeDefaultPresetIdToStorage(trimmed);
            dispatch({ type: "set_default_preset", id: trimmed });
          }
          refresh();
        })
        .catch((e) => {
          console.error("renamePreset (save) failed:", e);
        });
    },
    [refresh],
  );

  const setDefaultPreset = useCallback((id: string | null) => {
    writeDefaultPresetIdToStorage(id);
    dispatch({ type: "set_default_preset", id });
  }, []);
  const dismissPresetBanner = useCallback(() => {
    dispatch({ type: "dismiss_preset_banner" });
  }, []);
  const setRoutingView = useCallback((v: RoutingView) => {
    dispatch({ type: "set_routing_view", view: v });
  }, []);
  const setDensity = useCallback((d: Density) => {
    dispatch({ type: "set_density", density: d });
  }, []);
  const setSelection = useCallback((sel: DetailSelection) => {
    dispatch({ type: "set_selection", selection: sel });
  }, []);
  const openStreamSetup = useCallback(() => dispatch({ type: "open_stream_setup" }), []);
  const closeStreamSetup = useCallback(() => dispatch({ type: "close_stream_setup" }), []);

  // Undo / redo: restore the previous (or next) snapshot and reconcile
  // the backend by walking the diff and invoking the matching IPC.
  const reconcileToSnapshot = useCallback(async (target: Snapshot) => {
    const cur = stateRef.current;
    // Buses: enabled, muted/volume, device.
    for (const bs of target.buses) {
      const cb = cur.buses.find((b) => b.id === bs.id);
      if (!cb) continue;
      if (cb.enabled !== bs.enabled) {
        try { await ipc.setBusEnabled(bs.id, bs.enabled); }
        catch (e) { console.error("undo:setBusEnabled failed", e); }
      }
      if (cb.volume !== bs.volume || cb.muted !== bs.muted) {
        try { await ipc.setBusVolume(bs.id, uiVolumeToBackend(bs.volume), bs.muted); }
        catch (e) { console.error("undo:setBusVolume failed", e); }
      }
      if (cb.device !== bs.device) {
        try { await ipc.setBusDevice(bs.id, bs.device); }
        catch (e) { console.error("undo:setBusDevice failed", e); }
      }
    }
    // Inputs: removed first, then added, then gain/muted on present.
    const tgtInputIds = new Set(target.inputs.map((i) => i.id));
    const curInputIds = new Set(cur.inputs.map((i) => i.id));
    for (const ci of cur.inputs) {
      if (!tgtInputIds.has(ci.id)) {
        try { await ipc.removeInput(ci.id); }
        catch (e) { console.error("undo:removeInput failed", e); }
      }
    }
    for (const ti of target.inputs) {
      if (!curInputIds.has(ti.id)) {
        try { await ipc.addInput(ti.device); }
        catch (e) { console.error("undo:addInput failed", e); }
      }
    }
    for (const ti of target.inputs) {
      const ci = cur.inputs.find((i) => i.id === ti.id);
      if (!ci) continue;
      if (ci.gain !== ti.gain || ci.muted !== ti.muted) {
        try { await ipc.setInputGain(ti.id, uiVolumeToBackend(ti.gain), ti.muted); }
        catch (e) { console.error("undo:setInputGain failed", e); }
      }
    }
    // Sends: disable removed, enable added, then gain/muted on present.
    const sendKey = (s: Send) => `${s.inputId}|${s.busId}`;
    const curSendMap = new Map(cur.sends.map((s) => [sendKey(s), s]));
    const tgtSendMap = new Map(target.sends.map((s) => [sendKey(s), s]));
    for (const [k, cs] of curSendMap) {
      if (!tgtSendMap.has(k)) {
        try { await ipc.setSend(cs.inputId, cs.busId, false); }
        catch (e) { console.error("undo:setSend(off) failed", e); }
      }
    }
    for (const [k, ts] of tgtSendMap) {
      const cs = curSendMap.get(k);
      if (!cs) {
        try { await ipc.setSend(ts.inputId, ts.busId, true); }
        catch (e) { console.error("undo:setSend(on) failed", e); }
      }
      if (!cs || cs.gain !== ts.gain || cs.muted !== ts.muted) {
        try { await ipc.setSendGain(ts.inputId, ts.busId, uiVolumeToBackend(ts.gain), ts.muted); }
        catch (e) { console.error("undo:setSendGain failed", e); }
      }
    }
  }, []);

  const undo = useCallback(() => {
    const cur = takeSnapshot(stateRef.current.buses, stateRef.current.inputs, stateRef.current.sends);
    const target = history.undo(cur);
    if (!target) return;
    dispatch({ type: "restore_snapshot", snap: target });
    reconcileToSnapshot(target).then(() => refresh()).catch(() => {});
  }, [history, refresh, reconcileToSnapshot]);

  const redo = useCallback(() => {
    const cur = takeSnapshot(stateRef.current.buses, stateRef.current.inputs, stateRef.current.sends);
    const target = history.redo(cur);
    if (!target) return;
    dispatch({ type: "restore_snapshot", snap: target });
    reconcileToSnapshot(target).then(() => refresh()).catch(() => {});
  }, [history, refresh, reconcileToSnapshot]);

  /* ── Recording ────────────────────────────────────────────────────────── */

  const refreshActiveRecordings = useCallback(async () => {
    try {
      const recs = await ipc.listActiveRecordings();
      dispatch({ type: "set_recordings", recordings: recs });
    } catch (e) {
      console.error("listActiveRecordings failed:", e);
    }
  }, []);

  const refreshRecordingFiles = useCallback(async () => {
    try {
      const [files, dir] = await Promise.all([
        ipc.listRecordingFiles(),
        ipc.getRecordingsDir().catch(() => null),
      ]);
      dispatch({ type: "set_recording_files", files });
      if (dir !== null) dispatch({ type: "set_recordings_dir", dir });
    } catch (e) {
      console.error("listRecordingFiles failed:", e);
    }
  }, []);

  // Initial fetch of recordings dir + file list (runs once after mount).
  useEffect(() => {
    refreshRecordingFiles().catch(() => {});
  }, [refreshRecordingFiles]);

  const startRecording = useCallback(
    async (spec: TapSpec): Promise<ActiveRecording | null> => {
      try {
        const info = await ipc.startRecording(spec);
        await refreshActiveRecordings();
        return info;
      } catch (e) {
        console.error("startRecording failed:", e);
        return null;
      }
    },
    [refreshActiveRecordings],
  );

  const startMasterRecording = useCallback(
    async (): Promise<ActiveRecording[]> => {
      try {
        const infos = await ipc.startMasterRecording();
        await refreshActiveRecordings();
        return infos;
      } catch (e) {
        console.error("startMasterRecording failed:", e);
        return [];
      }
    },
    [refreshActiveRecordings],
  );

  const stopRecording = useCallback(
    async (id: string): Promise<void> => {
      try {
        await ipc.stopRecording(id);
      } catch (e) {
        console.error("stopRecording failed:", e);
      }
      await Promise.all([refreshActiveRecordings(), refreshRecordingFiles()]);
    },
    [refreshActiveRecordings, refreshRecordingFiles],
  );

  const stopAllRecordings = useCallback(async (): Promise<void> => {
    try {
      await ipc.stopAllRecordings();
    } catch (e) {
      console.error("stopAllRecordings failed:", e);
    }
    await Promise.all([refreshActiveRecordings(), refreshRecordingFiles()]);
  }, [refreshActiveRecordings, refreshRecordingFiles]);

  const setRecordingsDir = useCallback(
    async (path: string): Promise<void> => {
      try {
        const newDir = await ipc.setRecordingsDir(path);
        dispatch({ type: "set_recordings_dir", dir: newDir });
        await refreshRecordingFiles();
      } catch (e) {
        console.error("setRecordingsDir failed:", e);
      }
    },
    [refreshRecordingFiles],
  );

  const openRecordingsFolder = useCallback(async (): Promise<void> => {
    try {
      await ipc.openRecordingsFolder();
    } catch (e) {
      console.error("openRecordingsFolder failed:", e);
    }
  }, []);

  const deleteRecordingFile = useCallback(
    async (path: string): Promise<void> => {
      try {
        await ipc.deleteRecordingFile(path);
      } catch (e) {
        console.error("deleteRecordingFile failed:", e);
      }
      await refreshRecordingFiles();
    },
    [refreshRecordingFiles],
  );

  const openRecordingsPanel = useCallback(() => {
    refreshRecordingFiles().catch(() => {});
    dispatch({ type: "open_recordings_panel" });
  }, [refreshRecordingFiles]);

  const closeRecordingsPanel = useCallback(() => {
    dispatch({ type: "close_recordings_panel" });
  }, []);

  return {
    state,
    undo,
    redo,
    setBusEnabled,
    setBusMuted,
    setBusVolume,
    setBusDevice,
    renameBus,
    setBusRoleOverride,
    setBusBufferSize,
    setBusLimiter,
    startRecording,
    startMasterRecording,
    stopRecording,
    stopAllRecordings,
    refreshRecordingFiles,
    setRecordingsDir,
    openRecordingsFolder,
    deleteRecordingFile,
    openRecordingsPanel,
    closeRecordingsPanel,
    setInputGain,
    setInputMuted,
    setInputDsp,
    removeInput,
    addInput,
    toggleSend,
    setSendGain,
    setSendMuted,
    loadPreset,
    savePreset,
    renamePreset,
    deletePreset,
    setDefaultPreset,
    dismissPresetBanner,
    setRoutingView,
    setDensity,
    setSelection,
    openStreamSetup,
    closeStreamSetup,
  };
}
