import {
  iconForBusRole,
  iconForKind,
  AlertIcon,
  MuteIcon,
  PowerIcon,
  ChevronRightIcon,
} from "./Icon";
import { BusLimiterControls } from "./DspControls";
import { BUFFER_SIZE_OPTIONS } from "./dspDefaults";
import { MeterCanvas } from "./MeterCanvas";
import { Pill } from "./Pill";
import { RecordButton } from "./RecordButton";
import type {
  ActiveRecording,
  AudioInput,
  Bus,
  LimiterConfig,
  Send,
  TapSpec,
} from "./types";
import { gainToDb, levelToDb, volumeToDb } from "./units";
import styles from "./BusDetail.module.css";

interface BusDetailProps {
  bus: Bus;
  routedInputs: { input: AudioInput; send: Send }[];
  activeRecordings: ActiveRecording[];
  onVolumeChange: (v: number) => void;
  onToggleEnabled: () => void;
  onToggleMuted: () => void;
  onPickDevice: () => void;
  onSelectInput: (id: string) => void;
  onBufferSizeChange: (frames: number | null) => void;
  onLimiterChange: (limiter: LimiterConfig) => void;
  onStartRecording: (spec: TapSpec) => void;
  onStopRecording: (id: string) => void;
}

/**
 * Detail view for a selected bus.
 *
 * Shows:
 *  - Bus identification (role, ID, device)
 *  - Live meter + dB
 *  - Volume + master controls
 *  - List of inputs currently routed here (click to jump to that input's detail)
 *  - Error state w/ action
 */
export function BusDetail({
  bus,
  routedInputs,
  activeRecordings,
  onVolumeChange,
  onToggleEnabled,
  onToggleMuted,
  onPickDevice,
  onSelectInput,
  onBufferSizeChange,
  onLimiterChange,
  onStartRecording,
  onStopRecording,
}: BusDetailProps) {
  const accent = `var(--am-bus-${bus.id.toLowerCase()})`;
  const accentMuted = `var(--am-bus-${bus.id.toLowerCase()}-muted)`;
  const busOutSpec: TapSpec = { kind: "bus_out", bus_id: bus.id };
  const engineRunning = bus.state === "running" || bus.state === "clipping";

  return (
    <div
      className={styles.wrap}
      style={{
        ["--bus-accent" as any]: accent,
        ["--bus-accent-muted" as any]: accentMuted,
      }}
    >
      {/* Header */}
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.busIcon} aria-hidden>
            {iconForBusRole(bus.role)}
          </span>
          <div className={styles.headerText}>
            <div className={styles.eyebrow}>Bus · {bus.id}</div>
            <h3 className={styles.title}>{bus.label}</h3>
          </div>
        </div>
        <StatePill state={bus.state} />
      </header>

      {/* Device */}
      <button className={styles.deviceRow} onClick={onPickDevice}>
        <span className={styles.deviceLabel}>Output device</span>
        <span className={bus.device ? styles.deviceName : styles.deviceMissing}>
          {bus.device ?? "Click to pick a device"}
        </span>
        <ChevronRightIcon size={14} />
      </button>

      {/* Error */}
      {bus.state === "error" && (
        <div className={styles.errorBlock}>
          <AlertIcon size={14} />
          <span>{bus.error ?? "Device error"}</span>
          <button className={styles.errorAction} onClick={onPickDevice}>
            Re-pick
          </button>
        </div>
      )}

      {/* Meter */}
      <div className={styles.meterBlock}>
        <MeterCanvas level={bus.level} width={300} height={12} />
        <div className={styles.dbReadout}>
          {bus.state === "running" || bus.state === "clipping" ? levelToDb(bus.level) : "—"}
        </div>
      </div>

      {/* Master controls */}
      <section className={styles.section}>
        <div className={styles.sectionTitle}>Master</div>
        <div className={styles.volumeRow}>
          <span className={styles.volumeLabel}>Volume</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={bus.volume}
            onChange={(e) => onVolumeChange(Number(e.target.value))}
            className={styles.nativeSlider}
            style={{ accentColor: accent }}
            disabled={bus.state === "unconfigured" || bus.state === "error"}
            aria-label="Bus volume"
          />
          <span className={styles.volumeReadout}>{volumeToDb(bus.volume)}</span>
        </div>

        <div className={styles.actions}>
          <button
            className={`${styles.actionBtn} ${bus.enabled ? styles.actionActive : ""}`}
            onClick={onToggleEnabled}
            disabled={bus.state === "unconfigured" || bus.state === "error"}
            aria-pressed={bus.enabled}
          >
            <PowerIcon size={14} />
            <span>{bus.enabled ? "Enabled" : "Enable"}</span>
          </button>
          <button
            className={`${styles.actionBtn} ${bus.muted ? styles.actionMuted : ""}`}
            onClick={onToggleMuted}
            aria-pressed={bus.muted}
          >
            <MuteIcon size={14} />
            <span>{bus.muted ? "Muted" : "Mute"}</span>
          </button>
          <RecordButton
            spec={busOutSpec}
            active={activeRecordings}
            onStart={onStartRecording}
            onStop={onStopRecording}
            disabled={!engineRunning}
            title={`Record ${bus.label} output`}
            size={14}
          />
        </div>
      </section>

      {/* Processing — buffer size, dropout telemetry, final limiter */}
      <section className={styles.section}>
        <div className={styles.sectionTitle}>Processing</div>
        <div className={styles.procRow}>
          <span className={styles.procLabel}>Buffer size</span>
          <select
            className={styles.procSelect}
            value={bus.bufferSizeFrames ?? ""}
            onChange={(e) =>
              onBufferSizeChange(e.target.value === "" ? null : Number(e.target.value))
            }
            aria-label="Output buffer size"
          >
            {BUFFER_SIZE_OPTIONS.map((opt) => (
              <option key={opt.label} value={opt.value ?? ""}>
                {opt.label}
                {opt.value !== null ? " frames" : ""}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.procRow}>
          <span className={styles.procLabel}>Dropouts</span>
          <span
            className={styles.procStat}
            data-warn={bus.underruns + bus.overruns > 0 ? "" : undefined}
            title="Underruns (mixer outran capture) / overruns (capture outran mixer). Resets each poll."
          >
            {bus.underruns} under · {bus.overruns} over
          </span>
        </div>
        <BusLimiterControls limiter={bus.limiter} onChange={onLimiterChange} />
      </section>

      {/* Routed inputs */}
      <section className={styles.section}>
        <div className={styles.sectionHeaderRow}>
          <div className={styles.sectionTitle}>
            Routed inputs <span className={styles.sectionCount}>{routedInputs.length}</span>
          </div>
        </div>
        {routedInputs.length === 0 ? (
          <div className={styles.noRouted}>
            No inputs routed to this bus.
            <br />
            <span className={styles.noRoutedHint}>
              Use the routing matrix to send audio here.
            </span>
          </div>
        ) : (
          <ul className={styles.routedList}>
            {routedInputs.map(({ input, send }) => (
              <li
                key={input.id}
                className={styles.routedItem}
                onClick={() => onSelectInput(input.id)}
              >
                <span className={styles.routedIcon} aria-hidden>
                  {iconForKind(input.kind)}
                </span>
                <div className={styles.routedText}>
                  <div className={styles.routedName}>{input.name}</div>
                  <div className={styles.routedDevice}>{input.device}</div>
                </div>
                <span className={styles.routedGain}>{gainToDb(send.gain)}</span>
                <ChevronRightIcon size={14} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function StatePill({ state }: { state: Bus["state"] }) {
  switch (state) {
    case "running":      return <Pill tone="success">Live</Pill>;
    case "clipping":     return <Pill tone="danger">Clipping</Pill>;
    case "silent":       return <Pill tone="warning">Silent</Pill>;
    case "error":        return <Pill tone="danger" icon={<AlertIcon size={10} />}>Error</Pill>;
    case "unconfigured": return <Pill tone="neutral">No device</Pill>;
    case "idle":
    default:             return <Pill tone="neutral">Idle</Pill>;
  }
}
