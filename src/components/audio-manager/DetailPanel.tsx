import { InputDetail } from "./InputDetail";
import { BusDetail } from "./BusDetail";
import { InfoIcon } from "./Icon";
import type {
  ActiveRecording,
  AudioInput,
  Bus,
  BusId,
  DetailSelection,
  DspConfig,
  EqConfig,
  LimiterConfig,
  Send,
  TapSpec,
} from "./types";
import styles from "./DetailPanel.module.css";

interface DetailPanelProps {
  selection: DetailSelection;
  buses: Bus[];
  inputs: AudioInput[];
  sends: Send[];
  activeRecordings: ActiveRecording[];
  onInputGainChange: (id: string, v: number) => void;
  onInputMuted: (id: string) => void;
  onInputDsp: (id: string, dsp: DspConfig) => void;
  onApplyStreamVoice: (id: string) => void;
  onRemoveInput: (id: string) => void;
  onToggleSend: (inputId: string, busId: BusId) => void;
  onSendGainChange: (inputId: string, busId: BusId, v: number) => void;
  onSendMuted: (inputId: string, busId: BusId, muted: boolean) => void;
  onBusVolumeChange: (id: BusId, v: number) => void;
  onBusEnabledChange: (id: BusId) => void;
  onBusMutedChange: (id: BusId) => void;
  onBusBufferSizeChange: (id: BusId, frames: number | null) => void;
  onBusLatencyModeChange: (id: BusId, mode: string) => void;
  onBusLimiterChange: (id: BusId, limiter: LimiterConfig) => void;
  onBusEqChange: (id: BusId, eq: EqConfig) => void;
  onPickDevice: (id: BusId) => void;
  onSelectInputContext: (id: string) => void;
  onStartRecording: (spec: TapSpec) => void;
  onStopRecording: (id: string) => void;
  /** True when shown in node view — hide the input's in-panel DSP chain so
   *  the canvas is the single place to edit effects. */
  inputOnly?: boolean;
}

/**
 * Right column. Context-sensitive panel showing details for either the
 * selected input or the selected bus.
 */
export function DetailPanel(props: DetailPanelProps) {
  const { selection, buses, inputs, sends } = props;

  if (selection.kind === "none") {
    return (
      <aside className={styles.panel} aria-label="Detail panel">
        <EmptyDetail />
      </aside>
    );
  }

  if (selection.kind === "input") {
    const input = inputs.find((i) => i.id === selection.inputId);
    if (!input) return null;
    return (
      <aside className={styles.panel} aria-label={`Details for input ${input.name}`}>
        <InputDetail
          input={input}
          buses={buses}
          sends={sends.filter((s) => s.inputId === input.id)}
          activeRecordings={props.activeRecordings}
          onGainChange={(v) => props.onInputGainChange(input.id, v)}
          onMuteToggle={() => props.onInputMuted(input.id)}
          onRemove={() => props.onRemoveInput(input.id)}
          onToggleSend={(busId) => props.onToggleSend(input.id, busId)}
          onSendGainChange={(busId, v) => props.onSendGainChange(input.id, busId, v)}
          onSendMuted={(busId, muted) => props.onSendMuted(input.id, busId, muted)}
          onDspChange={(dsp) => props.onInputDsp(input.id, dsp)}
          onApplyStreamVoice={() => props.onApplyStreamVoice(input.id)}
          onStartRecording={props.onStartRecording}
          onStopRecording={props.onStopRecording}
          inputOnly={props.inputOnly}
        />
      </aside>
    );
  }

  // selection.kind === "bus"
  const bus = buses.find((b) => b.id === selection.busId);
  if (!bus) return null;
  const routedInputs = sends
    .filter((s) => s.busId === bus.id && s.enabled)
    .map((s) => ({
      send: s,
      input: inputs.find((i) => i.id === s.inputId)!,
    }))
    .filter((x) => x.input);

  return (
    <aside className={styles.panel} aria-label={`Details for bus ${bus.label}`}>
      <BusDetail
        bus={bus}
        routedInputs={routedInputs}
        activeRecordings={props.activeRecordings}
        onVolumeChange={(v) => props.onBusVolumeChange(bus.id, v)}
        onToggleEnabled={() => props.onBusEnabledChange(bus.id)}
        onToggleMuted={() => props.onBusMutedChange(bus.id)}
        onPickDevice={() => props.onPickDevice(bus.id)}
        onSelectInput={props.onSelectInputContext}
        onBufferSizeChange={(frames) => props.onBusBufferSizeChange(bus.id, frames)}
        onLatencyModeChange={(mode) => props.onBusLatencyModeChange(bus.id, mode)}
        onEqChange={(eq) => props.onBusEqChange(bus.id, eq)}
        onLimiterChange={(limiter) => props.onBusLimiterChange(bus.id, limiter)}
        onStartRecording={props.onStartRecording}
        onStopRecording={props.onStopRecording}
      />
    </aside>
  );
}

function EmptyDetail() {
  return (
    <div className={styles.empty}>
      <div className={styles.emptyIcon} aria-hidden>
        <InfoIcon size={24} />
      </div>
      <h3 className={styles.emptyTitle}>No selection</h3>
      <p className={styles.emptyHint}>
        Click an input on the left or a bus above to see its details and per-send
        controls here.
      </p>
    </div>
  );
}
