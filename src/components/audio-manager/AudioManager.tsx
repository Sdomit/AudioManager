import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BusContextMenu } from "./BusContextMenu";
import { EqSampleRateContext } from "./EqGraph";
import { DEFAULT_EQ_SR } from "./eqResponse";
import { BusRail } from "./BusRail";
import { CableNotice } from "./CableNotice";
import { busRoleFor } from "./adapters";
import { DetailPanel } from "./DetailPanel";
import { DevicePicker } from "./DevicePicker";
import { HotkeyOverlay } from "./HotkeyOverlay";
import { InputList } from "./InputList";
import { AmvcBanner } from "./AmvcBanner";
import { PresetBanner } from "./PresetBanner";
import { PresetSaveDialog } from "./PresetSaveDialog";
import { RecordingsPanel } from "./RecordingsPanel";
import { RoutingView } from "./RoutingView";
import { StreamSetupSheet } from "./StreamSetupSheet";
import { TopBar } from "./TopBar";
import { useAudioManager } from "./useAudioManager";
import type { BusId, TapSpec } from "./types";
import * as ipc from "../../ipc/commands";
import type { DeviceInfo } from "../../types/engine";
import {
  hasAnyAmvcDevice,
  suggestAmvcBusDevice,
  suggestAppCaptureInput,
} from "../../utils/amvcPresets";

import "./tokens.css";
import "./base.css";
import styles from "./AudioManager.module.css";

/**
 * Push a short status string to a visually-hidden `aria-live="polite"`
 * region so screen readers announce transient actions (record start/stop,
 * etc.) without taking focus. The region is created lazily on first use
 * and reused for the rest of the session.
 */
function announce(message: string) {
  if (typeof document === "undefined") return;
  let region = document.getElementById("am-aria-live");
  if (!region) {
    region = document.createElement("div");
    region.id = "am-aria-live";
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    region.setAttribute("aria-atomic", "true");
    region.style.position = "absolute";
    region.style.width = "1px";
    region.style.height = "1px";
    region.style.overflow = "hidden";
    region.style.clip = "rect(0 0 0 0)";
    region.style.clipPath = "inset(50%)";
    region.style.whiteSpace = "nowrap";
    document.body.appendChild(region);
  }
  // Clear first so identical sequential messages re-announce.
  region.textContent = "";
  window.setTimeout(() => {
    if (region) region.textContent = message;
  }, 20);
}

/**
 * Top-level AudioManager component.
 *
 * Wires the bus rail, inputs panel, routing center, detail panel, top bar,
 * and stream setup sheet into a single shell. State and actions come from
 * useAudioManager() — replace that with your real Tauri-backed hook when
 * you're ready to wire to the backend.
 *
 * Mount it anywhere that fills the viewport:
 *
 *   <div style={{ height: "100vh" }}>
 *     <AudioManager />
 *   </div>
 */
export function AudioManager() {
  const am = useAudioManager();
  const { state } = am;

  const [busPickerFor, setBusPickerFor] = useState<BusId | null>(null);
  const busPickerTarget = busPickerFor
    ? state.buses.find((b) => b.id === busPickerFor) ?? null
    : null;

  const [inputPickerOpen, setInputPickerOpen] = useState(false);
  const usedInputIds = new Set(state.inputs.map((i) => i.id));

  // Preset dialog: "save" mode collects a new name; "rename" mode
  // captures the existing id so the rename action can save+delete.
  const [presetDialog, setPresetDialog] = useState<
    | { kind: "closed" }
    | { kind: "save" }
    | { kind: "rename"; oldId: string; oldName: string }
  >({ kind: "closed" });

  const [cableNoticeDismissed, setCableNoticeDismissed] = useState(false);
  const [hasCableDevices, setHasCableDevices] = useState<boolean | null>(null);
  const [outputDevicesCache, setOutputDevicesCache] = useState<DeviceInfo[]>([]);
  // Engine sample rate for EQ response curves: DSP runs at the output device's
  // rate, so use the default (else first) output device's rate; falls back to
  // 48 kHz when no devices are cached yet.
  const eqSampleRate = useMemo(
    () =>
      outputDevicesCache.find((d) => d.is_default)?.default_sample_rate ??
      outputDevicesCache[0]?.default_sample_rate ??
      DEFAULT_EQ_SR,
    [outputDevicesCache],
  );
  const [inputDevicesCache, setInputDevicesCache] = useState<DeviceInfo[]>([]);

  // Re-poll device lists and recompute AudioManager-cable presence. Runs at
  // mount and again on demand (e.g. after CableNotice launches the installer)
  // so a freshly-installed cable clears the notice without an app restart.
  const refreshCableDevices = useCallback(async () => {
    try {
      const [outs, ins] = await Promise.all([
        ipc.listOutputDevices(),
        ipc.listInputDevices(),
      ]);
      setOutputDevicesCache(outs);
      setInputDevicesCache(ins);
      setHasCableDevices(hasAnyAmvcDevice(outs, ins));
    } catch {
      setHasCableDevices(false);
    }
  }, []);

  useEffect(() => {
    void refreshCableDevices();
  }, [refreshCableDevices]);

  const recommendedBusDevice = busPickerTarget
    ? suggestAmvcBusDevice(busPickerTarget.id, outputDevicesCache)
    : null;

  // App-capture source: suggest an AudioManager Cable Recording endpoint
  // (skip any already added as an input). Routing to a chosen bus is the
  // existing matrix action — this only surfaces the source.
  const recommendedInputDevice = suggestAppCaptureInput(
    inputDevicesCache.filter((d) => !usedInputIds.has(d.id)),
  );

  // Bus right-click context menu (position + target id).
  const [busCtx, setBusCtx] = useState<{ id: BusId; x: number; y: number } | null>(null);
  const busCtxTarget = busCtx ? state.buses.find((b) => b.id === busCtx.id) ?? null : null;

  // Bus rename dialog. Distinct from preset rename; same dialog
  // component, different action on confirm.
  const [busRenameFor, setBusRenameFor] = useState<BusId | null>(null);
  const busRenameTarget = busRenameFor
    ? state.buses.find((b) => b.id === busRenameFor) ?? null
    : null;

  const presetNames = state.presets.map((p) => p.name);

  const loadedPreset = state.presets.find((p) => p.id === state.loadedPresetId);

  const [hotkeyOverlayOpen, setHotkeyOverlayOpen] = useState(false);

  // Hotkeys. Pause whenever a text field is focused (so typing in the
  // preset save dialog or the device-picker search doesn't trip Space
  // / M / number shortcuts) or when any modal/dialog is open.
  //
  // stateRef gives the listener current state without re-binding on
  // every render — the listener is wired once.
  const amRef = useRef(am);
  amRef.current = am;
  const dialogOpen =
    busPickerFor !== null ||
    inputPickerOpen ||
    presetDialog.kind !== "closed" ||
    state.streamSetupOpen ||
    state.recordingsPanelOpen ||
    busRenameFor !== null ||
    busCtx !== null ||
    hotkeyOverlayOpen;
  const dialogOpenRef = useRef(dialogOpen);
  dialogOpenRef.current = dialogOpen;

  useEffect(() => {
    const isTextEntryTarget = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (el.isContentEditable) return true;
      return false;
    };

    const onKey = (e: KeyboardEvent) => {
      // The hotkey overlay listens for `?` and Esc itself.
      // Other dialogs install their own Esc listeners.
      if (e.defaultPrevented) return;
      if (isTextEntryTarget(e.target)) return;

      // Ctrl/Cmd+S always opens save dialog (even if another dialog is open,
      // browsers want us to suppress the default save-page behavior).
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!dialogOpenRef.current) {
          setPresetDialog({ kind: "save" });
        }
        return;
      }

      // Ctrl/Cmd+Z → undo. Ctrl/Cmd+Shift+Z (or Ctrl+Y) → redo.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (dialogOpenRef.current) return;
        if (e.shiftKey) amRef.current.redo();
        else amRef.current.undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        if (dialogOpenRef.current) return;
        amRef.current.redo();
        return;
      }

      // `?` toggles the hotkey overlay regardless of selection. Shift+/
      // produces "?" on most keyboards; check both forms.
      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        setHotkeyOverlayOpen((v) => !v);
        return;
      }

      // Suppress remaining shortcuts while a modal is up.
      if (dialogOpenRef.current) return;

      const cur = amRef.current;
      const sel = cur.state.selection;

      // 1..4 → focus bus by id.
      if (/^[1-4]$/.test(e.key)) {
        e.preventDefault();
        const id = (["A1", "A2", "B1", "B2"] as const)[Number(e.key) - 1];
        cur.setSelection({ kind: "bus", busId: id });
        return;
      }

      // Space → enable/disable selected bus.
      if (e.key === " " || e.code === "Space") {
        if (sel.kind !== "bus") return;
        const bus = cur.state.buses.find((b) => b.id === sel.busId);
        if (!bus) return;
        // Don't trip on a bus that has no device (would no-op or surface
        // a backend error). Match the BusCard's "Pick device" behavior.
        if (!bus.device) return;
        e.preventDefault();
        cur.setBusEnabled(sel.busId, !bus.enabled);
        return;
      }

      // M → mute selected bus OR selected input.
      if (e.key === "m" || e.key === "M") {
        if (sel.kind === "bus") {
          const bus = cur.state.buses.find((b) => b.id === sel.busId);
          if (!bus) return;
          e.preventDefault();
          cur.setBusMuted(sel.busId, !bus.muted);
        } else if (sel.kind === "input") {
          const input = cur.state.inputs.find((i) => i.id === sel.inputId);
          if (!input) return;
          e.preventDefault();
          cur.setInputMuted(sel.inputId, !input.muted);
        }
        return;
      }

      // R → toggle master recording. Records every running bus.
      if ((e.key === "r" || e.key === "R") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        const cur2 = amRef.current;
        if (cur2.state.activeRecordings.length > 0) {
          void cur2.stopAllRecordings();
          announce("Stopped all recordings.");
        } else {
          void cur2.startMasterRecording().then((started) => {
            if (started.length > 0) {
              announce(`Master recording started on ${started.length} bus${started.length === 1 ? "" : "es"}.`);
            } else {
              announce("Master recording: no buses running.");
            }
          });
        }
        return;
      }

      // Up/Down → move selection in the input list.
      if (sel.kind === "input" && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        const inputs = cur.state.inputs;
        if (inputs.length === 0) return;
        const idx = inputs.findIndex((i) => i.id === sel.inputId);
        if (idx < 0) return;
        const next =
          e.key === "ArrowDown"
            ? Math.min(idx + 1, inputs.length - 1)
            : Math.max(idx - 1, 0);
        if (next === idx) return;
        e.preventDefault();
        cur.setSelection({ kind: "input", inputId: inputs[next].id });
        return;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      className={`audioManager ${styles.root}`}
      data-density={state.density}
    >
      <TopBar
        presets={state.presets}
        loadedPresetId={state.loadedPresetId}
        defaultPresetId={state.defaultPresetId}
        density={state.density}
        streamSetupSteps={state.streamSetupSteps}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
        onUndo={am.undo}
        onRedo={am.redo}
        activeRecordings={state.activeRecordings}
        onStartMasterRecording={() => void am.startMasterRecording()}
        onStopAllRecordings={() => void am.stopAllRecordings()}
        onOpenRecordings={am.openRecordingsPanel}
        onLoadPreset={am.loadPreset}
        onOpenSaveDialog={() => setPresetDialog({ kind: "save" })}
        onRenamePreset={(id) => {
          const p = state.presets.find((x) => x.id === id);
          if (!p) return;
          setPresetDialog({ kind: "rename", oldId: id, oldName: p.name });
        }}
        onDeletePreset={am.deletePreset}
        onSetDefaultPreset={am.setDefaultPreset}
        onDensityChange={am.setDensity}
        onOpenStreamSetup={am.openStreamSetup}
      />

      {/* Slot order A1/A2/B1/B2 is the sync-plan contract — don't trust
          array order. */}
      <AmvcBanner
        busNames={(["A1", "A2", "B1", "B2"] as const).map(
          (id) => state.buses.find((b) => b.id === id)?.label ?? id,
        )}
      />

      {state.presetBannerVisible && loadedPreset && (
        <PresetBanner preset={loadedPreset} onDismiss={am.dismissPresetBanner} />
      )}

      {!cableNoticeDismissed && hasCableDevices === false && (
        <CableNotice
          onDismiss={() => setCableNoticeDismissed(true)}
          onRecheck={() => void refreshCableDevices()}
        />
      )}

      <BusRail
        buses={state.buses}
        selection={state.selection}
        onSelectBus={(id) => am.setSelection({ kind: "bus", busId: id })}
        onToggleEnabled={(id) => {
          const bus = state.buses.find((b) => b.id === id);
          if (!bus) return;
          am.setBusEnabled(id, !bus.enabled);
        }}
        onToggleMuted={(id) => {
          const bus = state.buses.find((b) => b.id === id);
          if (!bus) return;
          am.setBusMuted(id, !bus.muted);
        }}
        onVolumeChange={am.setBusVolume}
        onSelectDevice={(id, deviceId) => am.setBusDevice(id, deviceId)}
        onContextMenu={(id, x, y) => setBusCtx({ id, x, y })}
      />

      <main className={styles.main}>
        {state.routingView !== "nodes" && (
          <InputList
            inputs={state.inputs}
            selection={state.selection}
            onSelectInput={(id) => am.setSelection({ kind: "input", inputId: id })}
            onMuteInput={(id) => {
              const input = state.inputs.find((i) => i.id === id);
              if (!input) return;
              am.setInputMuted(id, !input.muted);
            }}
            onInputGainChange={am.setInputGain}
            onAddInput={() => setInputPickerOpen(true)}
          />
        )}

        <RoutingView
          buses={state.buses}
          inputs={state.inputs}
          sends={state.sends}
          view={state.routingView}
          selection={state.selection}
          activeRecordings={state.activeRecordings}
          onViewChange={am.setRoutingView}
          onToggleSend={am.toggleSend}
          onSendGainChange={am.setSendGain}
          onSendMuted={am.setSendMuted}
          onSelectInput={(id) => am.setSelection({ kind: "input", inputId: id })}
          onSelectBus={(id) => am.setSelection({ kind: "bus", busId: id })}
          onStartRecording={(spec: TapSpec) => void am.startRecording(spec)}
          onStopRecording={(id: string) => void am.stopRecording(id)}
          onAddInput={() => setInputPickerOpen(true)}
          onRemoveInput={am.removeInput}
          onInputGainChange={am.setInputGain}
          onBusVolumeChange={am.setBusVolume}
          onInputDsp={am.setInputDsp}
          onBusEq={am.setBusEq}
          onBusLimiter={am.setBusLimiter}
        />

        {/* Detail panel: always present in matrix/flow; in the nodes canvas it
            appears only when a bus/input is selected, so per-bus/per-input
            settings (DSP, buffer size, limiter) are reachable from every view. */}
        {(state.routingView !== "nodes" || state.selection.kind !== "none") && (
          <EqSampleRateContext.Provider value={eqSampleRate}>
          <DetailPanel
            selection={state.selection}
            buses={state.buses}
            inputs={state.inputs}
            sends={state.sends}
            activeRecordings={state.activeRecordings}
            onInputGainChange={am.setInputGain}
            onInputMuted={(id) => {
              const input = state.inputs.find((i) => i.id === id);
              if (!input) return;
              am.setInputMuted(id, !input.muted);
            }}
            onInputDsp={am.setInputDsp}
            onApplyStreamVoice={am.applyStreamVoice}
            onRemoveInput={am.removeInput}
            onToggleSend={am.toggleSend}
            onSendGainChange={am.setSendGain}
            onSendMuted={am.setSendMuted}
            onBusVolumeChange={am.setBusVolume}
            onBusEnabledChange={(id) => {
              const bus = state.buses.find((b) => b.id === id);
              if (!bus) return;
              am.setBusEnabled(id, !bus.enabled);
            }}
            onBusMutedChange={(id) => {
              const bus = state.buses.find((b) => b.id === id);
              if (!bus) return;
              am.setBusMuted(id, !bus.muted);
            }}
            onBusBufferSizeChange={am.setBusBufferSize}
            onBusLatencyModeChange={am.setBusLatencyMode}
            onBusLimiterChange={am.setBusLimiter}
            onBusEqChange={am.setBusEq}
            onPickDevice={(id) => setBusPickerFor(id)}
            onSelectInputContext={(id) =>
              am.setSelection({ kind: "input", inputId: id })
            }
            onStartRecording={(spec: TapSpec) => void am.startRecording(spec)}
            onStopRecording={(id: string) => void am.stopRecording(id)}
            inputOnly={state.routingView === "nodes"}
          />
          </EqSampleRateContext.Provider>
        )}
      </main>

      <RecordingsPanel
        open={state.recordingsPanelOpen}
        active={state.activeRecordings}
        files={state.recordingFiles}
        recordingsDir={state.recordingsDir}
        onClose={am.closeRecordingsPanel}
        onStopRecording={(id) => void am.stopRecording(id)}
        onStopAll={() => void am.stopAllRecordings()}
        onOpenFolder={() => void am.openRecordingsFolder()}
        onSetDir={(p) => void am.setRecordingsDir(p)}
        onDelete={(p) => void am.deleteRecordingFile(p)}
        onRefresh={() => void am.refreshRecordingFiles()}
      />

      <StreamSetupSheet
        open={state.streamSetupOpen}
        steps={state.streamSetupSteps}
        onClose={am.closeStreamSetup}
      />

      {busPickerFor && busPickerTarget && (
        <DevicePicker
          open={true}
          kind="output"
          title={`Output device for ${busPickerTarget.label}`}
          subtitle={
            busPickerTarget.id === "B1"
              ? "Tip: pick a virtual cable input to stream to OBS/Discord/Zoom."
              : busPickerTarget.id === "B2"
              ? "Tip: pick a virtual cable output for Discord/Zoom/Teams."
              : undefined
          }
          currentDeviceId={busPickerTarget.device}
          highlightVirtual={busPickerTarget.id === "B1" || busPickerTarget.id === "B2"}
          recommendedDeviceId={recommendedBusDevice}
          onPick={(deviceId) => {
            am.setBusDevice(busPickerFor, deviceId);
            setBusPickerFor(null);
          }}
          onClose={() => setBusPickerFor(null)}
        />
      )}

      {inputPickerOpen && (
        <DevicePicker
          open={true}
          kind="input"
          title="Add input"
          subtitle={
            recommendedInputDevice
              ? "Capture an app or system sound directly, or pick a mic / cable device."
              : "Capture an app or system sound directly, or pick a microphone."
          }
          excludeIds={usedInputIds}
          highlightVirtual
          includeLoopbackSources
          recommendedDeviceId={recommendedInputDevice}
          onPick={(deviceId) => {
            if (deviceId) am.addInput(deviceId);
            setInputPickerOpen(false);
          }}
          onClose={() => setInputPickerOpen(false)}
        />
      )}

      <PresetSaveDialog
        open={presetDialog.kind === "save"}
        existingNames={presetNames}
        title="Save preset"
        confirmLabel="Save"
        onConfirm={(name) => {
          am.savePreset(name);
          setPresetDialog({ kind: "closed" });
        }}
        onClose={() => setPresetDialog({ kind: "closed" })}
      />

      <HotkeyOverlay
        open={hotkeyOverlayOpen}
        onClose={() => setHotkeyOverlayOpen(false)}
      />

      <PresetSaveDialog
        open={presetDialog.kind === "rename"}
        initialName={
          presetDialog.kind === "rename" ? presetDialog.oldName : ""
        }
        existingNames={presetNames.filter(
          (n) => presetDialog.kind === "rename" && n !== presetDialog.oldName,
        )}
        title="Rename preset"
        confirmLabel="Rename"
        onConfirm={(name) => {
          if (presetDialog.kind === "rename") {
            am.renamePreset(presetDialog.oldId, name);
          }
          setPresetDialog({ kind: "closed" });
        }}
        onClose={() => setPresetDialog({ kind: "closed" })}
      />

      {busCtx && busCtxTarget && (
        <BusContextMenu
          target={busCtxTarget}
          defaultRole={busRoleFor(busCtxTarget.id)}
          x={busCtx.x}
          y={busCtx.y}
          onRename={() => {
            setBusRenameFor(busCtxTarget.id);
            setBusCtx(null);
          }}
          onPickDevice={() => {
            setBusPickerFor(busCtxTarget.id);
            setBusCtx(null);
          }}
          onSetRole={(role) => {
            am.setBusRoleOverride(busCtxTarget.id, role);
            setBusCtx(null);
          }}
          onClose={() => setBusCtx(null)}
        />
      )}

      <PresetSaveDialog
        open={busRenameFor !== null}
        initialName={busRenameTarget?.label ?? ""}
        existingNames={
          busRenameFor === null
            ? []
            : state.buses
                .filter((b) => b.id !== busRenameFor)
                .map((b) => b.label)
        }
        title="Rename bus"
        confirmLabel="Rename"
        onConfirm={(name) => {
          if (busRenameFor !== null) {
            am.renameBus(busRenameFor, name);
          }
          setBusRenameFor(null);
        }}
        onClose={() => setBusRenameFor(null)}
      />
    </div>
  );
}
