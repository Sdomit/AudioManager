import { FlowIcon, GridIcon, ChainIcon } from "./Icon";
import { MatrixView } from "./MatrixView";
import { FlowView } from "./FlowView";
import { NodeView } from "./NodeView";
import type {
  ActiveRecording,
  AudioInput,
  Bus,
  BusId,
  DetailSelection,
  DspConfig,
  EqConfig,
  LimiterConfig,
  RoutingView as RoutingViewKind,
  Send,
  TapSpec,
} from "./types";
import styles from "./RoutingView.module.css";

interface RoutingViewProps {
  buses: Bus[];
  inputs: AudioInput[];
  sends: Send[];
  view: RoutingViewKind;
  selection: DetailSelection;
  activeRecordings: ActiveRecording[];
  onViewChange: (v: RoutingViewKind) => void;
  onToggleSend: (inputId: string, busId: BusId) => void;
  onSendGainChange: (inputId: string, busId: BusId, v: number) => void;
  onSendMuted: (inputId: string, busId: BusId, muted: boolean) => void;
  onSelectInput: (id: string) => void;
  onSelectBus: (id: BusId) => void;
  onStartRecording: (spec: TapSpec) => void;
  onStopRecording: (id: string) => void;
  /**
   * Open the add-input device picker. Used by NodeView (which hides
   * the side InputList) so users can still add inputs in node view.
   */
  onAddInput: () => void;
  /** Remove an input. Used by NodeView's Del shortcut for multi-select. */
  onRemoveInput: (id: string) => void;
  onInputGainChange: (id: string, v: number) => void;
  onBusVolumeChange: (id: BusId, v: number) => void;
  onInputDsp: (id: string, dsp: DspConfig) => void;
  onBusEq: (id: BusId, eq: EqConfig) => void;
  onBusLimiter: (id: BusId, limiter: LimiterConfig) => void;
}

/**
 * Center column. A view toggle (Matrix / Flow) sits at the top of the panel;
 * one of the two routing views fills the rest.
 *
 * Both views read and write the same Send[] — view choice is purely visual.
 */
export function RoutingView({
  buses,
  inputs,
  sends,
  view,
  selection,
  activeRecordings,
  onViewChange,
  onToggleSend,
  onSendGainChange,
  onSendMuted,
  onSelectInput,
  onSelectBus,
  onStartRecording,
  onStopRecording,
  onAddInput,
  onRemoveInput,
  onInputGainChange,
  onBusVolumeChange,
  onInputDsp,
  onBusEq,
  onBusLimiter,
}: RoutingViewProps) {
  return (
    <section className={styles.routing} aria-label="Routing">
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h2 className={styles.title}>Routing</h2>
          <span className={styles.subtitle}>
            {sends.filter((s) => s.enabled).length} active sends
          </span>
        </div>
        {/* Canvas toolbar (zoom / Reset layout / Add input / Group) is
            portalled into here by NodeView when this view is active. */}
        {view === "nodes" && (
          <div id="am-node-toolbar-slot" className={styles.nodeToolbarSlot} />
        )}
        <ViewToggle view={view} onChange={onViewChange} />
      </header>

      <div className={styles.body}>
        {view === "matrix" && (
          <MatrixView
            buses={buses}
            inputs={inputs}
            sends={sends}
            selection={selection}
            onToggleSend={onToggleSend}
            onSendGainChange={onSendGainChange}
            onSelectInput={onSelectInput}
            onSelectBus={onSelectBus}
          />
        )}
        {view === "flow" && (
          <FlowView
            buses={buses}
            inputs={inputs}
            sends={sends}
            selection={selection}
            onToggleSend={onToggleSend}
            onSelectInput={onSelectInput}
            onSelectBus={onSelectBus}
          />
        )}
        {view === "nodes" && (
          <NodeView
            buses={buses}
            inputs={inputs}
            sends={sends}
            selection={selection}
            activeRecordings={activeRecordings}
            onToggleSend={onToggleSend}
            onSendGainChange={onSendGainChange}
            onSendMuted={onSendMuted}
            onSelectInput={onSelectInput}
            onSelectBus={onSelectBus}
            onStartRecording={onStartRecording}
            onStopRecording={onStopRecording}
            onAddInput={onAddInput}
            onRemoveInput={onRemoveInput}
            onInputGainChange={onInputGainChange}
            onBusVolumeChange={onBusVolumeChange}
            onInputDsp={onInputDsp}
            onBusEq={onBusEq}
            onBusLimiter={onBusLimiter}
          />
        )}
      </div>
    </section>
  );
}

function ViewToggle({
  view,
  onChange,
}: {
  view: RoutingViewKind;
  onChange: (v: RoutingViewKind) => void;
}) {
  return (
    <div className={styles.toggle} role="tablist" aria-label="Routing view">
      <button
        role="tab"
        aria-selected={view === "flow"}
        className={`${styles.toggleBtn} ${view === "flow" ? styles.toggleBtnActive : ""}`}
        onClick={() => onChange("flow")}
      >
        <FlowIcon size={18} />
        <span>Flow</span>
      </button>
      <button
        role="tab"
        aria-selected={view === "nodes"}
        className={`${styles.toggleBtn} ${view === "nodes" ? styles.toggleBtnActive : ""}`}
        onClick={() => onChange("nodes")}
      >
        <ChainIcon size={18} />
        <span>Nodes</span>
      </button>
      <button
        role="tab"
        aria-selected={view === "matrix"}
        className={`${styles.toggleBtn} ${view === "matrix" ? styles.toggleBtnActive : ""}`}
        onClick={() => onChange("matrix")}
      >
        <GridIcon size={18} />
        <span>Matrix</span>
      </button>
    </div>
  );
}
