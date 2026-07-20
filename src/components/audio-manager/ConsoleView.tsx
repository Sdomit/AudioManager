import { MeterCanvas } from "./MeterCanvas";
import type { Bus, BusId, DetailSelection } from "./types";
import styles from "./ConsoleView.module.css";

interface Props {
  buses: Bus[];
  selection: DetailSelection;
  onSelectBus: (id: BusId) => void;
  onToggleMuted: (id: BusId) => void;
  onVolumeChange: (id: BusId, v: number) => void;
}

export function ConsoleView({
  buses,
  selection,
  onSelectBus,
  onToggleMuted,
  onVolumeChange,
}: Props) {
  return (
    <div className={styles.console} role="region" aria-label="Console view">
      {buses.map((bus) => (
        <Strip
          key={bus.id}
          bus={bus}
          selected={selection.kind === "bus" && selection.busId === bus.id}
          onSelect={() => onSelectBus(bus.id)}
          onToggleMuted={() => onToggleMuted(bus.id)}
          onVolumeChange={(v) => onVolumeChange(bus.id, v)}
        />
      ))}
    </div>
  );
}

function Strip({
  bus,
  selected,
  onSelect,
  onToggleMuted,
  onVolumeChange,
}: {
  bus: Bus;
  selected: boolean;
  onSelect: () => void;
  onToggleMuted: () => void;
  onVolumeChange: (v: number) => void;
}) {
  const accent = `var(--am-bus-${bus.id.toLowerCase()})`;
  const active = bus.state === "running" || bus.state === "clipping";

  return (
    <div
      className={`${styles.strip} ${selected ? styles.selected : ""}`}
      style={{ ["--strip-accent" as any]: accent }}
      onClick={onSelect}
      role="group"
      aria-label={`${bus.label} ${bus.id}`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className={styles.channelId} style={{ color: accent }}>
        {bus.id}
      </div>
      <div className={styles.channelLabel}>{bus.label}</div>

      <div className={`${styles.stateDot} ${styles[`dot_${bus.state}`]}`} aria-hidden />

      <div className={styles.meterWrap}>
        <MeterCanvas
          level={bus.level}
          width={20}
          height={160}
          variant="bus"
          orientation="vertical"
        />
      </div>

      <div className={styles.dbVal}>{active ? fmtDb(bus.level) : "—"}</div>

      <div className={styles.faderWrap} onClick={(e) => e.stopPropagation()}>
        <input
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={bus.volume}
          disabled={bus.state === "unconfigured" || bus.state === "error"}
          onChange={(e) => onVolumeChange(Number(e.target.value))}
          className={styles.fader}
          aria-label={`${bus.label} volume`}
        />
      </div>

      <div className={styles.volVal}>{fmtVol(bus.volume)}</div>

      <button
        className={`${styles.muteBtn} ${bus.muted ? styles.muteBtnActive : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleMuted();
        }}
        aria-pressed={bus.muted}
        title="Mute"
      >
        M
      </button>
    </div>
  );
}

function fmtDb(level: number): string {
  if (level < 0.001) return "-∞";
  const db = 20 * Math.log10(level);
  return db < -60 ? "-∞" : `${db.toFixed(0)}`;
}

function fmtVol(vol: number): string {
  if (vol < 0.001) return "-∞";
  // 0.75 = unity gain on the slider scale
  const db = 20 * Math.log10(vol / 0.75);
  return `${db.toFixed(0)} dB`;
}
