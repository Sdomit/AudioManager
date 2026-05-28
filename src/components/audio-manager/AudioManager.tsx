import { BusRail } from "./BusRail";
import { DetailPanel } from "./DetailPanel";
import { InputList } from "./InputList";
import { PresetBanner } from "./PresetBanner";
import { RoutingView } from "./RoutingView";
import { StreamSetupSheet } from "./StreamSetupSheet";
import { TopBar } from "./TopBar";
import { useAudioManager } from "./useAudioManager";

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

  const loadedPreset = state.presets.find((p) => p.id === state.loadedPresetId);

  return (
    <div
      className={`audioManager ${styles.root}`}
      data-density={state.density}
    >
      <TopBar
        presets={state.presets}
        loadedPresetId={state.loadedPresetId}
        density={state.density}
        streamSetupSteps={state.streamSetupSteps}
        onLoadPreset={am.loadPreset}
        onSavePreset={() => am.savePreset(`Preset ${state.presets.length + 1}`)}
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
        onPickDevice={(id) => {
          // Placeholder — wire to your device picker modal.
          console.log("Pick device for bus", id);
        }}
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
            onAddInput={am.addInput}
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
            onPickDevice={(id) => {
              console.log("Pick device for bus", id);
            }}
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
    </div>
  );
}
