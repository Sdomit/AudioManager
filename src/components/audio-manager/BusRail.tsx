import { BusCard } from "./BusCard";
import { ConsoleView } from "./ConsoleView";
import type { Bus, BusId, DetailSelection } from "./types";
import styles from "./BusRail.module.css";

interface BusRailProps {
  buses: Bus[];
  selection: DetailSelection;
  onSelectBus: (id: BusId) => void;
  onToggleEnabled: (id: BusId) => void;
  onToggleMuted: (id: BusId) => void;
  onVolumeChange: (id: BusId, v: number) => void;
  /** Assign/change/unassign a bus output device inline. Pass null to unassign. */
  onSelectDevice: (id: BusId, deviceId: string | null) => void;
  /** Open the right-click context menu for a bus card. */
  onContextMenu?: (id: BusId, x: number, y: number) => void;
  /** Card grid vs console faders. Toggled from the top bar. */
  viewMode: "card" | "console";
  /** Float the console above the routing workspace instead of reserving a rail. */
  floating?: boolean;
}

/**
 * Horizontal rail of four bus cards.
 *
 * A small gap visually groups A1/A2 (monitoring) and B1/B2 (broadcast).
 */
export function BusRail({
  buses,
  selection,
  onSelectBus,
  onToggleEnabled,
  onToggleMuted,
  onVolumeChange,
  onSelectDevice,
  onContextMenu,
  viewMode,
  floating = false,
}: BusRailProps) {
  const a = buses.filter((b) => b.id.startsWith("A"));
  const b = buses.filter((b) => b.id.startsWith("B"));

  return (
    <div
      className={`${styles.rail} ${floating ? styles.consoleFloating : ""}`}
      role="region"
      aria-label="Output buses"
    >
      {viewMode === "console" ? (
        <ConsoleView
          buses={buses}
          selection={selection}
          onSelectBus={onSelectBus}
          onToggleMuted={onToggleMuted}
          onVolumeChange={onVolumeChange}
        />
      ) : (
        <>
          <BusGroup label="Monitoring">
            {a.map((bus) => (
              <BusCard
                key={bus.id}
                bus={bus}
                selected={selection.kind === "bus" && selection.busId === bus.id}
                onSelect={() => onSelectBus(bus.id)}
                onToggleEnabled={() => onToggleEnabled(bus.id)}
                onToggleMuted={() => onToggleMuted(bus.id)}
                onVolumeChange={(v) => onVolumeChange(bus.id, v)}
                onSelectDevice={(deviceId) => onSelectDevice(bus.id, deviceId)}
                onContextMenu={
                  onContextMenu
                    ? (e) => {
                        e.preventDefault();
                        onContextMenu(bus.id, e.clientX, e.clientY);
                      }
                    : undefined
                }
              />
            ))}
          </BusGroup>
          <div className={styles.divider} aria-hidden />
          <BusGroup label="Broadcast">
            {b.map((bus) => (
              <BusCard
                key={bus.id}
                bus={bus}
                selected={selection.kind === "bus" && selection.busId === bus.id}
                onSelect={() => onSelectBus(bus.id)}
                onToggleEnabled={() => onToggleEnabled(bus.id)}
                onToggleMuted={() => onToggleMuted(bus.id)}
                onVolumeChange={(v) => onVolumeChange(bus.id, v)}
                onSelectDevice={(deviceId) => onSelectDevice(bus.id, deviceId)}
                onContextMenu={
                  onContextMenu
                    ? (e) => {
                        e.preventDefault();
                        onContextMenu(bus.id, e.clientX, e.clientY);
                      }
                    : undefined
                }
              />
            ))}
          </BusGroup>
        </>
      )}
    </div>
  );
}

function BusGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.group}>
      <span className={styles.groupLabel} aria-hidden>
        {label}
      </span>
      <div className={styles.groupCards}>{children}</div>
    </div>
  );
}
