import {
  iconForKind,
  iconForBusRole,
  MuteIcon,
  HeadphonesIcon,
  XIcon,
  PlusIcon,
} from "./Icon";
import { InputDspControls } from "./DspControls";
import { StereoMeter } from "./StereoMeter";
import { RecordButton } from "./RecordButton";
import type {
  ActiveRecording,
  AudioInput,
  Bus,
  BusId,
  DspConfig,
  Send,
  TapSpec,
} from "./types";
import { gainToDb } from "./units";
import type { DeviceInfo } from "../../types/engine";
import styles from "./InputDetail.module.css";

interface InputDetailProps {
  input: AudioInput;
  buses: Bus[];
  sends: Send[];
  activeRecordings: ActiveRecording[];
  onGainChange: (v: number) => void;
  onMuteToggle: () => void;
  onMonitorToggle: () => void;
  onRemove: () => void;
  onToggleSend: (busId: BusId) => void;
  onSendGainChange: (busId: BusId, v: number) => void;
  onSendMuted: (busId: BusId, muted: boolean) => void;
  onDspChange: (dsp: DspConfig) => void;
  onApplyStreamVoice: () => void;
  onStartRecording: (spec: TapSpec) => void;
  onStopRecording: (id: string) => void;
  /** Available capture devices for the "Change source" picker (#feature7). */
  inputDevices: DeviceInfo[];
  /** Set/clear this input's display label (#feature8); null reverts. */
  onRename: (label: string | null) => void;
  /** Swap this input's device, preserving its config (#feature7). */
  onReplaceSource: (newDeviceId: string) => void;
}

/**
 * Detail view for a selected input.
 *
 * Shows:
 *  - Source identification (name, device, kind)
 *  - Live meter
 *  - Master gain + mute
 *  - Per-bus send list: enable/disable + per-send gain + per-send mute
 */
export function InputDetail({
  input,
  buses,
  sends,
  activeRecordings,
  onGainChange,
  onMuteToggle,
  onMonitorToggle,
  onRemove,
  onToggleSend,
  onSendGainChange,
  onSendMuted,
  onDspChange,
  onApplyStreamVoice,
  onStartRecording,
  onStopRecording,
  inputDevices,
  onRename,
  onReplaceSource,
}: InputDetailProps) {
  const sendMap = new Map<BusId, Send>();
  sends.forEach((s) => sendMap.set(s.busId, s));

  const preSpec: TapSpec = { kind: "input_pre", device_id: input.id };
  // Pre-gain capture is only possible while at least one bus engine has
  // this input loaded (it taps inside the bus engine's output callback).
  const anyEngineRunning = buses.some(
    (b) =>
      (b.state === "running" || b.state === "clipping") &&
      sends.some((s) => s.busId === b.id && s.enabled),
  );

  return (
    <div className={styles.wrap}>
      {/* Header */}
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.kindIcon} aria-hidden>
            {iconForKind(input.kind)}
          </span>
          <div className={styles.headerText}>
            <div className={styles.eyebrow}>Input</div>
            <h3 className={styles.title}>{input.name}</h3>
          </div>
        </div>
        <button
          className={styles.removeBtn}
          onClick={onRemove}
          aria-label={`Remove ${input.name}`}
          title="Remove input"
        >
          <XIcon size={14} />
        </button>
      </header>

      <div className={styles.deviceRow}>
        <span className={styles.deviceLabel}>Device</span>
        <span className={styles.deviceName} title={input.device}>
          {input.device}
        </span>
      </div>

      {/* Source: rename (#feature8) + swap device (#feature7). */}
      <section className={styles.section}>
        <div className={styles.sectionTitle}>Source</div>
        <div className={styles.gainRow}>
          <span className={styles.gainLabel}>Name</span>
          <input
            // Remount per input so defaultValue tracks the selected input.
            key={input.id}
            type="text"
            defaultValue={input.name}
            placeholder="Display name"
            aria-label="Rename input"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== input.name) onRename(v.length ? v : null);
            }}
            style={{
              flex: 1,
              minWidth: 0,
              padding: "4px 8px",
              borderRadius: 6,
              border: "1px solid var(--am-border, rgba(255,255,255,0.14))",
              background: "var(--am-surface-2, rgba(255,255,255,0.06))",
              color: "inherit",
              fontSize: 12,
            }}
          />
        </div>
        <div className={styles.gainRow}>
          <span className={styles.gainLabel}>Change</span>
          <select
            value=""
            aria-label="Change source device"
            onChange={(e) => {
              if (e.target.value) onReplaceSource(e.target.value);
            }}
            style={{
              flex: 1,
              minWidth: 0,
              padding: "4px 8px",
              borderRadius: 6,
              border: "1px solid var(--am-border, rgba(255,255,255,0.14))",
              background: "var(--am-surface-2, rgba(255,255,255,0.06))",
              color: "inherit",
              fontSize: 12,
            }}
          >
            <option value="">Change source…</option>
            {inputDevices
              .filter((d) => d.id !== input.id)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
          </select>
        </div>
      </section>

      {/* Meter */}
      <div className={styles.meterBlock}>
        <StereoMeter
          levelL={input.levelL}
          levelR={input.levelR}
          level={input.level}
          channels={input.channels}
          width={300}
          height={16}
          peakHold
          variant="input"
        />
      </div>

      {/* Master controls */}
      <section className={styles.section}>
        <div className={styles.sectionTitle}>Master</div>
        <div className={styles.gainRow}>
          <span className={styles.gainLabel}>Gain</span>
          <div className={styles.gainSliderWrap}>
            <input
              type="range"
              min={0}
              max={1}
              step={0.001}
              value={input.gain}
              onChange={(e) => onGainChange(Number(e.target.value))}
              className={styles.nativeSlider}
              style={{ accentColor: "var(--am-accent)" }}
              aria-label="Master gain"
            />
          </div>
          <span className={styles.gainReadout}>{gainToDb(input.gain)}</span>
        </div>
        <div className={styles.masterActions}>
          <button
            className={`${styles.muteBtn} ${input.muted ? styles.muteBtnActive : ""}`}
            onClick={onMuteToggle}
            aria-pressed={input.muted}
          >
            <MuteIcon size={14} />
            <span>{input.muted ? "Muted" : "Mute"}</span>
          </button>
          <button
            className={`${styles.muteBtn} ${input.monitor ? styles.muteBtnActive : ""}`}
            onClick={onMonitorToggle}
            aria-pressed={!!input.monitor}
            title="Monitor: hear this input on the monitor bus (A1) without enabling the speaker send"
          >
            <HeadphonesIcon size={14} />
            <span>{input.monitor ? "Monitoring" : "Monitor"}</span>
          </button>
          <RecordButton
            spec={preSpec}
            active={activeRecordings}
            onStart={onStartRecording}
            onStop={onStopRecording}
            disabled={!anyEngineRunning}
            title="Record pre-gain (dry input)"
            size={14}
          />
        </div>
      </section>

      {/* Per-input effect chain (#feature4): edited here in every view. In the
          node canvas, clicking an input or its FX badge selects it and opens
          this panel — pan / mono / width live in the Stereo block below. */}
      <section className={styles.section}>
        <div className={styles.sectionTitle}>Processing (DSP)</div>
        <InputDspControls
          dsp={input.dsp}
          onChange={onDspChange}
          onStreamVoice={onApplyStreamVoice}
        />
      </section>

      {/* Sends */}
      <section className={styles.section}>
        <div className={styles.sectionTitle}>Sends</div>
        <div className={styles.sendsList}>
          {buses.map((bus) => {
            const send = sendMap.get(bus.id);
            const enabled = !!send?.enabled;
            return (
              <div
                key={bus.id}
                className={`${styles.sendRow} ${enabled ? styles.sendRowOn : ""}`}
                style={{
                  ["--bus-accent" as any]: `var(--am-bus-${bus.id.toLowerCase()})`,
                  ["--bus-accent-muted" as any]: `var(--am-bus-${bus.id.toLowerCase()}-muted)`,
                }}
              >
                <div className={styles.sendHeader}>
                  <button
                    className={styles.sendToggle}
                    onClick={() => onToggleSend(bus.id)}
                    aria-pressed={enabled}
                    title={enabled ? `Remove send to ${bus.label}` : `Add send to ${bus.label}`}
                  >
                    <span className={styles.sendBusIcon} aria-hidden>
                      {iconForBusRole(bus.role)}
                    </span>
                    <span className={styles.sendBusLabel}>{bus.label}</span>
                    <span className={styles.sendBusId}>{bus.id}</span>
                    <span className={styles.sendStatus}>
                      {enabled ? <span className={styles.dotOn} /> : <PlusIcon size={11} />}
                    </span>
                  </button>
                </div>
                {enabled && send && (
                  <div className={styles.sendControls}>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.001}
                      value={send.gain}
                      onChange={(e) => onSendGainChange(bus.id, Number(e.target.value))}
                      className={styles.sendSlider}
                      style={{ accentColor: `var(--am-bus-${bus.id.toLowerCase()})` }}
                      aria-label={`Send to ${bus.label} gain`}
                    />
                    <span className={styles.sendGain}>{gainToDb(send.gain)}</span>
                    <button
                      className={`${styles.sendMute} ${send.muted ? styles.sendMuteActive : ""}`}
                      onClick={() => onSendMuted(bus.id, !send.muted)}
                      aria-pressed={send.muted}
                      title={send.muted ? "Unmute send" : "Mute send"}
                    >
                      <MuteIcon size={12} />
                    </button>
                    <RecordButton
                      spec={{
                        kind: "input_post",
                        device_id: input.id,
                        bus_id: bus.id,
                      }}
                      active={activeRecordings}
                      onStart={onStartRecording}
                      onStop={onStopRecording}
                      disabled={
                        !(bus.state === "running" || bus.state === "clipping")
                      }
                      title={`Record ${input.name} → ${bus.label} (post-gain)`}
                      size={12}
                      compact
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
