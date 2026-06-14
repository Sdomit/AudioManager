import {
  iconForKind,
  iconForBusRole,
  MuteIcon,
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
import styles from "./InputDetail.module.css";

/** Compact pan readout: "C" at center, "L 42" / "R 80" off-center. */
function panLabel(pan: number): string {
  if (Math.abs(pan) < 0.01) return "C";
  const pct = Math.round(Math.abs(pan) * 100);
  return pan < 0 ? `L ${pct}` : `R ${pct}`;
}

interface InputDetailProps {
  input: AudioInput;
  buses: Bus[];
  sends: Send[];
  activeRecordings: ActiveRecording[];
  onGainChange: (v: number) => void;
  onMuteToggle: () => void;
  onRemove: () => void;
  onToggleSend: (busId: BusId) => void;
  onSendGainChange: (busId: BusId, v: number) => void;
  onSendMuted: (busId: BusId, muted: boolean) => void;
  onDspChange: (dsp: DspConfig) => void;
  onApplyStreamVoice: () => void;
  onStartRecording: (spec: TapSpec) => void;
  onStopRecording: (id: string) => void;
  /** When true, hide the in-panel DSP chain — node view edits fx via canvas. */
  inputOnly?: boolean;
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
  onRemove,
  onToggleSend,
  onSendGainChange,
  onSendMuted,
  onDspChange,
  onApplyStreamVoice,
  onStartRecording,
  onStopRecording,
  inputOnly,
}: InputDetailProps) {
  const sendMap = new Map<BusId, Send>();
  sends.forEach((s) => sendMap.set(s.busId, s));

  // Stereo image (#feature3): pan positions the signal between L/R; mono folds
  // a stereo source so both channels carry the same content. Both mutate the
  // existing DspConfig.stereo block and flow through the live onDspChange path.
  const stereo = input.dsp.stereo;
  const updateStereo = (patch: Partial<typeof stereo>) =>
    onDspChange({ ...input.dsp, stereo: { ...stereo, ...patch } });
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

      {/* Stereo image: pan + mono (#feature3). Shown only in node view, where
          the DSP chain — and its full Stereo editor in InputDspControls — is
          hidden. The normal detail view edits pan/mono/width there instead, so
          we don't render a second, partial stereo editor for the same state. */}
      {inputOnly && (
        <section className={styles.section}>
          <div className={styles.sectionTitle}>Stereo</div>
        <div className={styles.gainRow}>
          <span className={styles.gainLabel}>Pan</span>
          <div className={styles.gainSliderWrap}>
            <input
              type="range"
              min={-1}
              max={1}
              step={0.01}
              value={stereo.pan}
              onChange={(e) => updateStereo({ pan: Number(e.target.value) })}
              onDoubleClick={() => updateStereo({ pan: 0 })}
              className={styles.nativeSlider}
              style={{ accentColor: "var(--am-accent)" }}
              aria-label="Pan: left / right balance"
            />
          </div>
          <span className={styles.gainReadout}>{panLabel(stereo.pan)}</span>
        </div>
        <div className={styles.masterActions}>
          <button
            className={`${styles.muteBtn} ${stereo.mono ? styles.muteBtnActive : ""}`}
            onClick={() => updateStereo({ mono: !stereo.mono })}
            aria-pressed={stereo.mono}
            title={stereo.mono ? "Switch to stereo" : "Fold to mono (both channels)"}
          >
            <span>{stereo.mono ? "Mono" : "Stereo"}</span>
          </button>
          <button
            className={styles.muteBtn}
            onClick={() => updateStereo({ pan: 0 })}
            disabled={Math.abs(stereo.pan) < 0.001}
            title="Center pan"
          >
            <span>Center</span>
          </button>
        </div>
        </section>
      )}

      {/* DSP chain (hidden in node view — fx are edited on the canvas). */}
      {!inputOnly && (
        <section className={styles.section}>
          <div className={styles.sectionTitle}>Processing (DSP)</div>
          <InputDspControls
            dsp={input.dsp}
            onChange={onDspChange}
            onStreamVoice={onApplyStreamVoice}
          />
        </section>
      )}

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
