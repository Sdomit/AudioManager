import { useState } from "react";
import { iconForBusRole, iconForKind } from "./Icon";
import type { AudioInput, Bus, BusId, DetailSelection, Send } from "./types";
import { gainToDb } from "./units";
import styles from "./MatrixView.module.css";

interface MatrixViewProps {
  buses: Bus[];
  inputs: AudioInput[];
  sends: Send[];
  selection: DetailSelection;
  onToggleSend: (inputId: string, busId: BusId) => void;
  onSendGainChange: (inputId: string, busId: BusId, v: number) => void;
  onSelectInput: (id: string) => void;
  onSelectBus: (id: BusId) => void;
}

/**
 * Power user view. Inputs × Buses grid. Cells are toggle dots.
 * Hovering a cell pops the per-send gain control inline.
 */
export function MatrixView({
  buses,
  inputs,
  sends,
  selection,
  onToggleSend,
  onSendGainChange,
  onSelectInput,
  onSelectBus,
}: MatrixViewProps) {
  const [hoverCell, setHoverCell] = useState<string | null>(null);

  const sendMap = new Map<string, Send>();
  sends.forEach((s) => sendMap.set(`${s.inputId}|${s.busId}`, s));

  const isInputHighlighted = (id: string) =>
    selection.kind === "input" && selection.inputId === id;
  const isBusHighlighted = (id: BusId) =>
    selection.kind === "bus" && selection.busId === id;

  return (
    <div className={styles.wrap}>
      <table className={styles.matrix} role="grid">
        <thead>
          <tr>
            <th className={styles.cornerCell} />
            {buses.map((bus) => (
              <th
                key={bus.id}
                className={`${styles.busHeader} ${
                  isBusHighlighted(bus.id) ? styles.busHeaderActive : ""
                }`}
                onClick={() => onSelectBus(bus.id)}
                style={{ ["--bus-accent" as any]: `var(--am-bus-${bus.id.toLowerCase()})` }}
              >
                <div className={styles.busHeaderInner}>
                  <span className={styles.busHeaderIcon}>{iconForBusRole(bus.role)}</span>
                  <span className={styles.busHeaderLabel}>{bus.label}</span>
                  <span className={styles.busHeaderId}>{bus.id}</span>
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {inputs.map((input) => (
            <tr
              key={input.id}
              className={isInputHighlighted(input.id) ? styles.rowActive : ""}
            >
              <th
                className={styles.inputHeader}
                onClick={() => onSelectInput(input.id)}
                scope="row"
              >
                <span className={styles.inputHeaderIcon} aria-hidden>
                  {iconForKind(input.kind)}
                </span>
                <span className={styles.inputHeaderName}>{input.name}</span>
              </th>
              {buses.map((bus) => {
                const cellId = `${input.id}|${bus.id}`;
                const send = sendMap.get(cellId);
                const enabled = !!send?.enabled;
                const trimmed = enabled && send && Math.abs(send.gain - 0.75) > 0.02;
                const isHover = hoverCell === cellId;
                return (
                  <td
                    key={bus.id}
                    className={`${styles.cell} ${enabled ? styles.cellOn : ""} ${
                      isHover ? styles.cellHover : ""
                    }`}
                    style={{ ["--bus-accent" as any]: `var(--am-bus-${bus.id.toLowerCase()})` }}
                    onMouseEnter={() => setHoverCell(cellId)}
                    onMouseLeave={() => setHoverCell((id) => (id === cellId ? null : id))}
                    onClick={() => onToggleSend(input.id, bus.id)}
                    role="gridcell"
                    aria-label={`${input.name} to ${bus.label}, ${enabled ? "on" : "off"}`}
                    aria-pressed={enabled}
                  >
                    <div className={styles.cellInner}>
                      <span
                        className={`${styles.dot} ${enabled ? styles.dotOn : ""} ${
                          trimmed ? styles.dotTrimmed : ""
                        }`}
                      />
                    </div>
                    {isHover && enabled && send && (
                      <div className={styles.gainPop} onClick={(e) => e.stopPropagation()}>
                        <div className={styles.gainPopLabel}>
                          Send {gainToDb(send.gain)}
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.001}
                          value={send.gain}
                          onChange={(e) =>
                            onSendGainChange(input.id, bus.id, Number(e.target.value))
                          }
                          className={styles.gainPopSlider}
                          style={{ accentColor: `var(--am-bus-${bus.id.toLowerCase()})` }}
                          aria-label="Send gain"
                        />
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <div className={styles.legend}>
        <span className={styles.legendItem}>
          <span className={`${styles.dot} ${styles.dotOn}`} /> send on
        </span>
        <span className={styles.legendItem}>
          <span className={`${styles.dot} ${styles.dotOn} ${styles.dotTrimmed}`} /> send on, gain trimmed
        </span>
        <span className={styles.legendItem}>
          <span className={styles.dot} /> off
        </span>
        <span className={styles.legendHint}>Hover a cell to adjust send gain</span>
      </div>
    </div>
  );
}
