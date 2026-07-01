import {
  iconForBusRole,
  iconForKind,
  AlertIcon,
  MuteIcon,
  VolumeIcon,
  PowerIcon,
  ChevronRightIcon,
} from "./Icon";
import { BusEqControls, BusLimiterControls } from "./DspControls";
import { b1ProtectLimiter, BUFFER_SIZE_OPTIONS } from "./dspDefaults";
import { MeterCanvas } from "./MeterCanvas";
import { Pill } from "./Pill";
import { RecordButton } from "./RecordButton";
import type {
  ActiveRecording,
  AudioInput,
  Bus,
  EqConfig,
  LimiterConfig,
  LoudnessSnapshot,
  LoudnessVerdict,
  Send,
  TapSpec,
} from "./types";
import { gainToDb, levelToDb, volumeToDb } from "./units";
import styles from "./BusDetail.module.css";

/** Named latency presets (#35), shown as a segmented picker. Maps to the
 *  backend LatencyMode → buffer_size_frames. */
const LATENCY_MODES: ReadonlyArray<{ mode: string; label: string }> = [
  { mode: "stable", label: "Stable" },
  { mode: "low", label: "Low" },
  { mode: "ultra-low", label: "Ultra-low" },
];

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
  onLatencyModeChange: (mode: string) => void;
  onEqChange: (eq: EqConfig) => void;
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
  onLatencyModeChange,
  onEqChange,
  onLimiterChange,
  onStartRecording,
  onStopRecording,
}: BusDetailProps) {
  const accent = `var(--am-bus-${bus.id.toLowerCase()})`;
  const accentMuted = `var(--am-bus-${bus.id.toLowerCase()}-muted)`;
  const busOutSpec: TapSpec = { kind: "bus_out", bus_id: bus.id };
  const engineRunning = bus.state === "running" || bus.state === "clipping";
  // B1 is the stream bus (#33). "Protection" == its final limiter armed at
  // -1 dBFS — derived straight from the limiter state, no separate flag.
  const isStreamBus = bus.id === "B1";
  const protectionArmed = bus.limiter.enabled;
  const toggleProtection = () =>
    onLimiterChange(
      protectionArmed ? { ...bus.limiter, enabled: false } : b1ProtectLimiter(),
    );

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
        <div className={styles.headerPills}>
          {isStreamBus &&
            (protectionArmed ? (
              <Pill tone="success">Protected</Pill>
            ) : (
              <Pill tone="warning">Unprotected</Pill>
            ))}
          <StatePill state={bus.state} />
        </div>
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

      {/* Streaming loudness meters (#38) */}
      {engineRunning && bus.loudness && <LoudnessPanel loudness={bus.loudness} />}

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
            className={`${styles.actionBtn} ${bus.enabled ? styles.actionEnabled : ""}`}
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
            {bus.muted ? <MuteIcon size={14} /> : <VolumeIcon size={14} />}
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
          <span className={styles.procLabel}>Latency</span>
          <div style={{ display: "flex", gap: 4 }} role="group" aria-label="Latency mode">
            {LATENCY_MODES.map((m) => {
              const active = bus.latencyMode === m.mode;
              return (
                <button
                  key={m.mode}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onLatencyModeChange(m.mode)}
                  style={{
                    padding: "4px 10px",
                    fontSize: 12,
                    fontWeight: 600,
                    borderRadius: 6,
                    cursor: "pointer",
                    border: "1px solid var(--am-border-default)",
                    background: active ? "var(--am-accent, #2563eb)" : "transparent",
                    color: active ? "#fff" : "var(--am-text-secondary)",
                  }}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>
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
            {bus.bufferSizeFrames != null &&
              !BUFFER_SIZE_OPTIONS.some(
                (o) => o.value === bus.bufferSizeFrames,
              ) && (
                <option value={bus.bufferSizeFrames}>
                  {bus.bufferSizeFrames} frames (current)
                </option>
              )}
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
        {isStreamBus && (
          <div className={styles.procRow}>
            <span className={styles.procLabel}>Protection</span>
            <button
              className={`${styles.actionBtn} ${protectionArmed ? styles.actionActive : ""}`}
              onClick={toggleProtection}
              aria-pressed={protectionArmed}
              title="Final limiter at -1 dBFS — guarantees the stream feed never clips"
            >
              {protectionArmed ? "Protected (-1 dB)" : "Protect"}
            </button>
          </div>
        )}
        <BusEqControls eq={bus.eq} onChange={onEqChange} />
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

const VERDICT_META: Record<LoudnessVerdict, { label: string; color: string }> = {
  no_signal: { label: "No signal", color: "var(--am-text-tertiary)" },
  too_quiet: { label: "Too quiet", color: "var(--am-warning)" },
  healthy: { label: "Healthy", color: "var(--am-success)" },
  too_hot: { label: "Too hot", color: "var(--am-meter-clip)" },
};

/** Floored levels (≤ -70 dB) read as -∞ rather than a misleading number. */
function fmtLoud(v: number): string {
  return v <= -69.5 ? "−∞" : v.toFixed(1);
}

function LoudnessStat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span
        style={{
          fontSize: "var(--am-text-11)",
          color: "var(--am-text-tertiary)",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: "var(--am-font-mono)",
          fontSize: "var(--am-text-14)",
          color: "var(--am-text-primary)",
        }}
      >
        {value}
        <span style={{ fontSize: "var(--am-text-11)", color: "var(--am-text-tertiary)", marginLeft: 3 }}>
          {unit}
        </span>
      </span>
    </div>
  );
}

/** Streaming loudness readout (#38): RMS / LUFS / true peak + verdict badge. */
function LoudnessPanel({ loudness }: { loudness: LoudnessSnapshot }) {
  const verdict = VERDICT_META[loudness.verdict];
  return (
    <section className={styles.section}>
      <div className={styles.sectionTitle}>Loudness</div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <LoudnessStat label="Short" value={fmtLoud(loudness.lufs_short)} unit="LUFS" />
        <LoudnessStat label="Momentary" value={fmtLoud(loudness.lufs_momentary)} unit="LUFS" />
        <LoudnessStat label="RMS" value={fmtLoud(loudness.rms_db)} unit="dBFS" />
        <LoudnessStat label="True peak" value={fmtLoud(loudness.true_peak_db)} unit="dBTP" />
      </div>
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 10px",
          borderRadius: 999,
          background: `color-mix(in srgb, ${verdict.color} 16%, transparent)`,
          color: verdict.color,
          fontSize: "var(--am-text-12)",
          fontWeight: 600,
        }}
      >
        <span style={{ width: 7, height: 7, borderRadius: 999, background: verdict.color }} />
        {verdict.label}
      </div>
    </section>
  );
}
