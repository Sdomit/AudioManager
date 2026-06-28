import { BusDeviceDropdown } from "./BusDeviceDropdown";
import { iconForBusRole, AlertIcon, MuteIcon, MoreIcon, PowerIcon } from "./Icon";
import { MeterCanvas } from "./MeterCanvas";
import { Pill } from "./Pill";
import { SpectrumAnalyzer } from "./SpectrumAnalyzer";
import type { Bus } from "./types";
import styles from "./BusCard.module.css";

interface BusCardProps {
  bus: Bus;
  selected: boolean;
  onSelect: () => void;
  onToggleEnabled: () => void;
  onToggleMuted: () => void;
  onVolumeChange: (v: number) => void;
  /** Assign/change/unassign the bus output device inline. Pass null to unassign. */
  onSelectDevice: (deviceId: string | null) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  meterWidth?: number;
}

/**
 * One bus card. All visual states live here:
 *   idle | running | silent | clipping | error | unconfigured
 *
 * Layout (top to bottom):
 *   • role label + state pill
 *   • bus ID + device name
 *   • meter + numeric dB
 *   • (optional) error message
 *   • volume slider
 *   • actions: enable, mute, more
 */
export function BusCard({
  bus,
  selected,
  onSelect,
  onToggleEnabled,
  onToggleMuted,
  onVolumeChange,
  onSelectDevice,
  onContextMenu,
  meterWidth = 260,
}: BusCardProps) {
  const accentColor = `var(--am-bus-${bus.id.toLowerCase()})`;
  const accentMuted = `var(--am-bus-${bus.id.toLowerCase()}-muted)`;

  return (
    <div
      className={`${styles.card} ${selected ? styles.selected : ""} ${styles[`state_${bus.state}`]}`}
      style={{
        ["--bus-accent" as any]: accentColor,
        ["--bus-accent-muted" as any]: accentMuted,
      }}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      role="group"
      aria-label={ariaLabelForBus(bus)}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      data-bus-id={bus.id}
    >
      {/* Top row: role + state pill */}
      <div className={styles.headerRow}>
        <div className={styles.titleGroup}>
          <span className={styles.roleIcon} style={{ color: accentColor }}>
            {iconForBusRole(bus.role)}
          </span>
          <span className={styles.role}>{bus.label}</span>
          <span className={styles.busId}>{bus.id}</span>
        </div>
        <StatePill state={bus.state} />
      </div>

      {/* Device row — inline dropdown to select/change the output device */}
      <div className={styles.deviceRow} onClick={(e) => e.stopPropagation()}>
        <BusDeviceDropdown
          busLabel={bus.label}
          currentDevice={bus.device}
          onSelect={onSelectDevice}
        />
      </div>

      {/* Meter + dB */}
      <div className={styles.meterRow}>
        <MeterCanvas level={bus.level} width={meterWidth} height={5} />
        <div className={styles.dbReadout}>
          {bus.state === "running" || bus.state === "clipping"
            ? levelToDb(bus.level)
            : "—"}
        </div>
      </div>

      {/* RMS + LUFS-M — only when loudness data is flowing */}
      {bus.loudness && (bus.state === "running" || bus.state === "clipping") && (
        <div className={styles.loudnessRow}>
          <span>
            <span className={styles.loudnessLabel}>RMS</span>
            {fmtLoudnessDb(bus.loudness.rms_db)}
          </span>
          <span>
            <span className={styles.loudnessLabel}>LUFS-M</span>
            {bus.loudness.lufs_momentary.toFixed(1)}
          </span>
        </div>
      )}

      {/* Spectrum analyzer — only when audio is flowing */}
      {(bus.state === "running" || bus.state === "clipping") && (
        <SpectrumAnalyzer busId={bus.id} width={meterWidth} />
      )}

      {/* Error message (only if errored) */}
      {bus.state === "error" && (
        <div className={styles.errorRow}>
          <AlertIcon size={14} />
          <span>{bus.error ?? "Device error"}</span>
        </div>
      )}

      {/* Volume slider */}
      <div className={styles.volumeRow}>
        <span className={styles.volLabel}>VOL</span>
        <VolumeSlider
          value={bus.volume}
          onChange={onVolumeChange}
          disabled={bus.state === "unconfigured" || bus.state === "error"}
          accent={accentColor}
        />
        <div className={styles.volumeReadout}>{volumeToDb(bus.volume)}</div>
      </div>

      {/* Actions */}
      <div className={styles.actionsRow}>
        <button
          className={`${styles.actionBtn} ${bus.enabled ? styles.actionActive : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleEnabled();
          }}
          disabled={bus.state === "error" || bus.state === "unconfigured"}
          aria-pressed={bus.enabled}
          title={
            bus.state === "unconfigured"
              ? "Select an output device first"
              : bus.enabled
                ? "Disable bus"
                : "Enable bus"
          }
        >
          <PowerIcon size={14} />
          <span>{bus.enabled ? "Enabled" : "Enable"}</span>
        </button>
        <button
          className={`${styles.actionBtn} ${bus.muted ? styles.actionMuted : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleMuted();
          }}
          aria-pressed={bus.muted}
          title={bus.muted ? "Unmute" : "Mute"}
        >
          <MuteIcon size={14} />
          <span>{bus.muted ? "Muted" : "Mute"}</span>
        </button>
        <button
          className={styles.moreBtn}
          onClick={(e) => e.stopPropagation()}
          aria-label="More options"
        >
          <MoreIcon size={16} />
        </button>
      </div>
    </div>
  );
}

/* ── State pill ─────────────────────────────────────────────────────────── */

function StatePill({ state }: { state: Bus["state"] }) {
  switch (state) {
    case "running":      return <Pill tone="success">Live</Pill>;
    case "clipping":     return <Pill tone="danger">Clip</Pill>;
    case "silent":       return <Pill tone="warning">Silent</Pill>;
    case "error":        return <Pill tone="danger" icon={<AlertIcon size={10} />}>Error</Pill>;
    case "unconfigured": return <Pill tone="neutral">No device</Pill>;
    case "idle":
    default:             return <Pill tone="neutral">Idle</Pill>;
  }
}

/* ── Volume slider ──────────────────────────────────────────────────────── */

function VolumeSlider({
  value,
  onChange,
  disabled,
  accent,
}: {
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  accent: string;
}) {
  return (
    <div className={`${styles.slider} ${disabled ? styles.sliderDisabled : ""}`}>
      <input
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className={styles.sliderInput}
        style={{ ["--slider-accent" as any]: accent }}
        aria-label="Bus volume"
      />
      <div
        className={styles.sliderFill}
        style={{ width: `${value * 100}%`, background: accent }}
        aria-hidden
      />
      <div
        className={styles.sliderThumb}
        style={{ left: `${value * 100}%` }}
        aria-hidden
      />
    </div>
  );
}

/* ── Formatting helpers ─────────────────────────────────────────────────── */

function ariaLabelForBus(bus: Bus): string {
  const stateText = {
    running: "running",
    clipping: "clipping",
    silent: "running but no inputs routed",
    error: `error${bus.error ? `, ${bus.error}` : ""}`,
    unconfigured: "no device selected",
    idle: "idle",
  }[bus.state];
  const parts = [bus.label, bus.id, stateText];
  if (bus.state === "running" || bus.state === "clipping") {
    parts.push(`level ${levelToDb(bus.level)}`);
  }
  return parts.join(", ");
}

function fmtLoudnessDb(db: number): string {
  if (db <= -70) return "-∞";
  return `${db.toFixed(0)} dB`;
}

function levelToDb(level: number): string {
  if (level < 0.001) return "-∞ dB";
  const db = 20 * Math.log10(level);
  if (db < -60) return "-∞ dB";
  return `${db.toFixed(0)} dB`;
}

function volumeToDb(vol: number): string {
  if (vol < 0.001) return "-∞ dB";
  // Treat 0.75 ≈ 0 dB unity
  const db = (vol - 0.75) * 80;
  if (db < -60) return "-∞ dB";
  return `${db > 0 ? "+" : ""}${db.toFixed(0)} dB`;
}
