import {
  iconForKind,
  iconForBusRole,
  MuteIcon,
  XIcon,
  PlusIcon,
} from "./Icon";
import { MeterCanvas } from "./MeterCanvas";
import type { AudioInput, Bus, BusId, Send } from "./types";
import styles from "./InputDetail.module.css";

interface InputDetailProps {
  input: AudioInput;
  buses: Bus[];
  sends: Send[];
  onGainChange: (v: number) => void;
  onMuteToggle: () => void;
  onRemove: () => void;
  onToggleSend: (busId: BusId) => void;
  onSendGainChange: (busId: BusId, v: number) => void;
  onSendMuted: (busId: BusId, muted: boolean) => void;
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
  onGainChange,
  onMuteToggle,
  onRemove,
  onToggleSend,
  onSendGainChange,
  onSendMuted,
}: InputDetailProps) {
  const sendMap = new Map<BusId, Send>();
  sends.forEach((s) => sendMap.set(s.busId, s));

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
        <MeterCanvas level={input.level} width={300} height={10} peakHold variant="input" />
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
        <button
          className={`${styles.muteBtn} ${input.muted ? styles.muteBtnActive : ""}`}
          onClick={onMuteToggle}
          aria-pressed={input.muted}
        >
          <MuteIcon size={14} />
          <span>{input.muted ? "Muted" : "Mute"}</span>
        </button>
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

function gainToDb(g: number): string {
  if (g < 0.001) return "-∞ dB";
  const db = (g - 0.75) * 80;
  return `${db > 0 ? "+" : ""}${db.toFixed(0)} dB`;
}
