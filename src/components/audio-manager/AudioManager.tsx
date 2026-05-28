import { useState } from "react";
import { BusRail } from "./BusRail";
import { DetailPanel } from "./DetailPanel";
import { DevicePicker } from "./DevicePicker";
import { InputList } from "./InputList";
import { PresetBanner } from "./PresetBanner";
import { PresetSaveDialog } from "./PresetSaveDialog";
import { RoutingView } from "./RoutingView";
import { StreamSetupSheet } from "./StreamSetupSheet";
import { TopBar } from "./TopBar";
import { useAudioManager } from "./useAudioManager";
import type { BusId } from "./types";

import "./tokens.css";
import "./base.css";
import styles from "./AudioManager.module.css";

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

  const presetNames = state.presets.map((p) => p.name);

  const loadedPreset = state.presets.find((p) => p.id === state.loadedPresetId);

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

      {state.presetBannerVisible && loadedPreset && (
        <PresetBanner preset={loadedPreset} onDismiss={am.dismissPresetBanner} />
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
        onPickDevice={(id) => setBusPickerFor(id)}
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
          onViewChange={am.setRoutingView}
          onToggleSend={am.toggleSend}
          onSendGainChange={am.setSendGain}
          onSendMuted={am.setSendMuted}
          onSelectInput={(id) => am.setSelection({ kind: "input", inputId: id })}
          onSelectBus={(id) => am.setSelection({ kind: "bus", busId: id })}
        />

        {state.routingView !== "nodes" && (
          <DetailPanel
            selection={state.selection}
            buses={state.buses}
            inputs={state.inputs}
            sends={state.sends}
            onInputGainChange={am.setInputGain}
            onInputMuted={(id) => {
              const input = state.inputs.find((i) => i.id === id);
              if (!input) return;
              am.setInputMuted(id, !input.muted);
            }}
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
            onPickDevice={(id) => setBusPickerFor(id)}
            onSelectInputContext={(id) =>
              am.setSelection({ kind: "input", inputId: id })
            }
          />
        )}
      </main>

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
              : undefined
          }
          currentDeviceId={busPickerTarget.device}
          highlightVirtual={busPickerTarget.id === "B1"}
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
          title="Add input device"
          subtitle="Pick a microphone, system source, or virtual cable output."
          excludeIds={usedInputIds}
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
    </div>
  );
}
