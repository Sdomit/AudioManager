import { StereoMeter } from "./StereoMeter";
import { MuteIcon, iconForKind } from "./Icon";
import type { AudioInput } from "./types";
import styles from "./InputRow.module.css";

interface InputRowProps {
  input: AudioInput;
  selected: boolean;
  onSelect: () => void;
  onToggleMute: () => void;
  onGainChange: (v: number) => void;
}

/**
 * One input row in the InputList.
 *
 * Compact: icon + name + small meter + mute toggle.
 * Per-input gain is editable inline via a thin slider strip under the name
 * (visible on hover/selected), with the full gain control in the detail panel.
 */
export function InputRow({
  input,
  selected,
  onSelect,
  onToggleMute,
  onGainChange,
}: InputRowProps) {
  return (
    <div
      className={`${styles.row} ${selected ? styles.selected : ""} ${input.muted ? styles.muted : ""}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      role="option"
      tabIndex={0}
      aria-selected={selected}
      aria-label={
        input.muted
          ? `${input.name}, muted, gain ${Math.round(input.gain * 100)} percent`
          : `${input.name}, gain ${Math.round(input.gain * 100)} percent, level ${Math.round(input.level * 100)} percent`
      }
      data-input-id={input.id}
    >
      <span className={styles.kindIcon} aria-hidden>
        {iconForKind(input.kind)}
      </span>

      <div className={styles.main}>
        <div className={styles.nameRow}>
          <span className={styles.name}>{input.name}</span>
          <span className={styles.deviceName} title={input.device}>
            {input.device}
          </span>
        </div>
        <div className={styles.meterRow}>
          <StereoMeter
            levelL={input.levelL}
            levelR={input.levelR}
            level={input.level}
            channels={input.channels}
            width={170}
            height={10}
            variant="input"
            peakHold={false}
          />
          <div className={styles.gainContainer}>
            <input
              type="range"
              min={0}
              max={1}
              step={0.001}
              value={input.gain}
              onChange={(e) => onGainChange(Number(e.target.value))}
              onClick={(e) => e.stopPropagation()}
              className={styles.gainSlider}
              aria-label={`${input.name} gain`}
            />
            <div className={styles.gainFill} style={{ width: `${input.gain * 100}%` }} aria-hidden />
          </div>
        </div>
      </div>

      <button
        className={`${styles.muteBtn} ${input.muted ? styles.muteBtnActive : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleMute();
        }}
        aria-pressed={input.muted}
        aria-label={input.muted ? `Unmute ${input.name}` : `Mute ${input.name}`}
        title={input.muted ? "Unmute" : "Mute"}
      >
        <MuteIcon size={14} />
      </button>
    </div>
  );
}
