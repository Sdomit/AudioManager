import { iconForBusRole, iconForKind, PlusIcon, XIcon } from "./Icon";
import type { AudioInput, Bus, BusId, DetailSelection, Send } from "./types";
import styles from "./FlowView.module.css";

interface FlowViewProps {
  buses: Bus[];
  inputs: AudioInput[];
  sends: Send[];
  selection: DetailSelection;
  onToggleSend: (inputId: string, busId: BusId) => void;
  onSelectInput: (id: string) => void;
  onSelectBus: (id: BusId) => void;
}

/**
 * Beginner-friendly view. Each input is a row; sends are chip-style pills.
 * Active sends show as filled bus-colored chips with a small × to remove.
 * Inactive buses appear as faded "add" chips.
 */
export function FlowView({
  buses,
  inputs,
  sends,
  selection,
  onToggleSend,
  onSelectInput,
  onSelectBus: _onSelectBus,
}: FlowViewProps) {
  const sendMap = new Map<string, Send>();
  sends.forEach((s) => sendMap.set(`${s.inputId}|${s.busId}`, s));

  return (
    <div className={styles.flow}>
      {inputs.map((input) => (
        <FlowRow
          key={input.id}
          input={input}
          buses={buses}
          sendMap={sendMap}
          selected={selection.kind === "input" && selection.inputId === input.id}
          onToggleSend={onToggleSend}
          onSelectInput={onSelectInput}
        />
      ))}
    </div>
  );
}

function FlowRow({
  input,
  buses,
  sendMap,
  selected,
  onToggleSend,
  onSelectInput,
}: {
  input: AudioInput;
  buses: Bus[];
  sendMap: Map<string, Send>;
  selected: boolean;
  onToggleSend: (inputId: string, busId: BusId) => void;
  onSelectInput: (id: string) => void;
}) {
  return (
    <div
      className={`${styles.row} ${selected ? styles.rowSelected : ""}`}
      onClick={() => onSelectInput(input.id)}
    >
      <div className={styles.source}>
        <span className={styles.sourceIcon} aria-hidden>
          {iconForKind(input.kind)}
        </span>
        <div className={styles.sourceText}>
          <div className={styles.sourceName}>{input.name}</div>
          <div className={styles.sourceDevice} title={input.device}>
            {input.device}
          </div>
        </div>
      </div>

      <div className={styles.arrow} aria-hidden>
        <svg width="40" height="14" viewBox="0 0 40 14">
          <path d="M0 7h36" stroke="currentColor" strokeWidth="1.25" fill="none" />
          <path d="m32 3 5 4-5 4" stroke="currentColor" strokeWidth="1.25" fill="none" />
        </svg>
      </div>

      <div className={styles.chips}>
        {buses.map((bus) => {
          const send = sendMap.get(`${input.id}|${bus.id}`);
          const enabled = !!send?.enabled;
          return (
            <BusChip
              key={bus.id}
              bus={bus}
              enabled={enabled}
              onClick={(e) => {
                e.stopPropagation();
                onToggleSend(input.id, bus.id);
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

function BusChip({
  bus,
  enabled,
  onClick,
}: {
  bus: Bus;
  enabled: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      className={`${styles.chip} ${enabled ? styles.chipOn : styles.chipOff}`}
      onClick={onClick}
      style={{
        ["--bus-accent" as any]: `var(--am-bus-${bus.id.toLowerCase()})`,
        ["--bus-accent-muted" as any]: `var(--am-bus-${bus.id.toLowerCase()}-muted)`,
      }}
      aria-pressed={enabled}
      title={enabled ? `Remove ${bus.label} send` : `Add send to ${bus.label}`}
    >
      <span className={styles.chipIcon} aria-hidden>
        {iconForBusRole(bus.role)}
      </span>
      <span className={styles.chipLabel}>{bus.label}</span>
      <span className={styles.chipAction} aria-hidden>
        {enabled ? <XIcon size={11} /> : <PlusIcon size={11} />}
      </span>
    </button>
  );
}
