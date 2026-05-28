import { FlowIcon, GridIcon, ChainIcon } from "./Icon";
import { MatrixView } from "./MatrixView";
import { FlowView } from "./FlowView";
import { NodeView } from "./NodeView";
import type {
  AudioInput,
  Bus,
  BusId,
  DetailSelection,
  RoutingView as RoutingViewKind,
  Send,
} from "./types";
import styles from "./RoutingView.module.css";

interface RoutingViewProps {
  buses: Bus[];
  inputs: AudioInput[];
  sends: Send[];
  view: RoutingViewKind;
  selection: DetailSelection;
  onViewChange: (v: RoutingViewKind) => void;
  onToggleSend: (inputId: string, busId: BusId) => void;
  onSendGainChange: (inputId: string, busId: BusId, v: number) => void;
  onSendMuted: (inputId: string, busId: BusId, muted: boolean) => void;
  onSelectInput: (id: string) => void;
  onSelectBus: (id: BusId) => void;
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
  onViewChange,
  onToggleSend,
  onSendGainChange,
  onSendMuted,
  onSelectInput,
  onSelectBus,
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
            onToggleSend={onToggleSend}
            onSendGainChange={onSendGainChange}
            onSendMuted={onSendMuted}
            onSelectInput={onSelectInput}
            onSelectBus={onSelectBus}
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
        <FlowIcon size={14} />
        <span>Flow</span>
      </button>
      <button
        role="tab"
        aria-selected={view === "nodes"}
        className={`${styles.toggleBtn} ${view === "nodes" ? styles.toggleBtnActive : ""}`}
        onClick={() => onChange("nodes")}
      >
        <ChainIcon size={14} />
        <span>Nodes</span>
      </button>
      <button
        role="tab"
        aria-selected={view === "matrix"}
        className={`${styles.toggleBtn} ${view === "matrix" ? styles.toggleBtnActive : ""}`}
        onClick={() => onChange("matrix")}
      >
        <GridIcon size={14} />
        <span>Matrix</span>
      </button>
    </div>
  );
}
