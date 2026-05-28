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
import { uiVolumeToBackend } from "./adapters";
import { mockStreamSetupSteps } from "./mockData";
import {
  hydrate as fetchHydrate,
  loadPreset as tcLoadPreset,
  savePreset as tcSavePreset,
  deletePreset as tcDeletePreset,
} from "./tauriCommands";
import type {
  AudioInput,
  AudioManagerState,
  Bus,
  BusId,
  Density,
  DetailSelection,
  Preset,
  RoutingView,
  Send,
  UseAudioManager,
} from "./types";

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
};

type Action =
  | { type: "hydrate"; buses: Bus[]; inputs: AudioInput[]; sends: Send[]; presets: Preset[] }
  | { type: "set_bus_enabled"; id: BusId; enabled: boolean }
  | { type: "set_bus_muted"; id: BusId; muted: boolean }
  | { type: "set_bus_volume"; id: BusId; volume: number }
  | { type: "set_bus_device"; id: BusId; device: string | null }
  | { type: "set_input_gain"; id: string; gain: number }
  | { type: "set_input_muted"; id: string; muted: boolean }
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
  | { type: "tick_meters"; busLevels: Record<BusId, number>; inputLevels: Record<string, number> };

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
      return {
        ...state,
        buses: action.buses,
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

    case "set_input_gain":
      return updateInput(state, action.id, (i) => ({ ...i, gain: clamp01(action.gain) }));

    case "set_input_muted":
      return updateInput(state, action.id, (i) => ({ ...i, muted: action.muted }));

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

  // Fake meter animation loop. Replace with Tauri event subscription.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      if (now - last > 80) {
        last = now;
        const cur = stateRef.current;
        const busLevels: Record<BusId, number> = {} as Record<BusId, number>;
        for (const b of cur.buses) {
          if (!b.enabled) {
            busLevels[b.id] = 0;
            continue;
          }
          const target = b.id === "B1" ? 0.85 : b.id === "A1" ? 0.55 : 0.3;
          const jitter = (Math.random() - 0.5) * 0.3;
          const v = clamp01(target + jitter);
          busLevels[b.id] = v;
        }
        const inputLevels: Record<string, number> = {};
        for (const i of cur.inputs) {
          if (i.muted) {
            inputLevels[i.id] = 0;
            continue;
          }
          const base = i.gain * 0.6;
          const jitter = (Math.random() - 0.5) * 0.25;
          inputLevels[i.id] = clamp01(base + jitter);
        }
        dispatch({ type: "tick_meters", busLevels, inputLevels });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
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

  const setInputGain = useCallback(
    (id: string, gain: number) => {
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

  const removeInput = useCallback(
    (id: string) => {
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
          refresh();
        })
        .catch((e) => {
          console.error("loadPreset failed:", e);
        });
    },
    [refresh],
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

  return {
    state,
    setBusEnabled,
    setBusMuted,
    setBusVolume,
    setBusDevice,
    setInputGain,
    setInputMuted,
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
