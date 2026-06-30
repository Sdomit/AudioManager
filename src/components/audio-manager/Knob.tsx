import { useCallback, useRef } from "react";
import styles from "./Knob.module.css";

interface KnobProps {
  /** Current value, 0..1. */
  value: number;
  onChange: (v: number) => void;
  /** Caption under the knob (device name). */
  label: string;
  /** Big readout above the label, e.g. "72%". */
  valueLabel: string;
  ariaLabel?: string;
  /** CSS color for the arc + indicator. Defaults to the app accent. */
  accent?: string;
  /** Muted state — dims the arc and lights the center mute glyph. */
  muted?: boolean;
  /** Press the center of the knob to toggle mute. */
  onMuteToggle?: () => void;
  disabled?: boolean;
  /** Dial diameter in px. Default 104. */
  size?: number;
}

// 270° sweep with the 90° gap centred at the bottom (6 o'clock).
const R = 42;
const C = 2 * Math.PI * R;
const ARC = 0.75;
const ARC_LEN = ARC * C;
const START_DEG = 135;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function indicator(value: number): { x: number; y: number } {
  const rad = ((START_DEG + clamp01(value) * 270) * Math.PI) / 180;
  return { x: 50 + R * Math.cos(rad), y: 50 + R * Math.sin(rad) };
}

/**
 * Rotary knob: drag the ring (or wheel / arrow keys) to set volume; press the
 * center to mute. Visual is a knob, behavior is a slider (`role="slider"`), so
 * it stays precise + accessible + touch-friendly.
 */
export function Knob({
  value,
  onChange,
  label,
  valueLabel,
  ariaLabel,
  accent,
  muted = false,
  onMuteToggle,
  disabled = false,
  size = 104,
}: KnobProps) {
  const drag = useRef<{ startY: number; startValue: number } | null>(null);
  const v = clamp01(value);
  const ind = indicator(v);
  const color = muted ? "var(--am-text-tertiary)" : accent ?? "var(--am-accent)";

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (disabled) return;
      e.preventDefault();
      (e.target as Element).setPointerCapture?.(e.pointerId);
      drag.current = { startY: e.clientY, startValue: v };
    },
    [disabled, v],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const span = e.shiftKey ? 480 : 160; // px for full travel; Shift = fine
      onChange(clamp01(d.startValue + (d.startY - e.clientY) / span));
    },
    [onChange],
  );

  const endDrag = useCallback((e: React.PointerEvent) => {
    drag.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  }, []);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (disabled) return;
      const step = e.shiftKey ? 0.05 : 0.02;
      onChange(clamp01(v + (e.deltaY < 0 ? step : -step)));
    },
    [disabled, onChange, v],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (disabled) return;
      if (e.key === "Enter" || e.key === " ") {
        if (onMuteToggle) {
          e.preventDefault();
          onMuteToggle();
        }
        return;
      }
      const fine = e.shiftKey ? 0.05 : 0.01;
      let next: number | null = null;
      if (e.key === "ArrowUp" || e.key === "ArrowRight") next = v + fine;
      else if (e.key === "ArrowDown" || e.key === "ArrowLeft") next = v - fine;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = 1;
      if (next === null) return;
      e.preventDefault();
      onChange(clamp01(next));
    },
    [disabled, onChange, onMuteToggle, v],
  );

  return (
    <div className={styles.knob} style={{ width: size }}>
      <div
        className={styles.dialWrap}
        style={{ width: size, height: size }}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={ariaLabel ?? label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(v * 100)}
        aria-valuetext={muted ? `muted, ${valueLabel}` : valueLabel}
        aria-disabled={disabled}
        data-disabled={disabled || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
      >
        <svg viewBox="0 0 100 100" className={styles.dial} aria-hidden>
          <circle
            cx={50}
            cy={50}
            r={R}
            className={styles.track}
            strokeDasharray={`${ARC_LEN} ${C}`}
            transform="rotate(135 50 50)"
          />
          {!muted && (
            <circle
              cx={50}
              cy={50}
              r={R}
              fill="none"
              stroke={color}
              strokeWidth={7}
              strokeLinecap="round"
              strokeDasharray={`${v * ARC_LEN} ${C}`}
              transform="rotate(135 50 50)"
            />
          )}
          <circle cx={ind.x} cy={ind.y} r={4.5} fill={color} />
        </svg>

        {/* Center mute zone — press to mute; stops the ring drag from starting. */}
        <button
          type="button"
          className={`${styles.muteZone} ${muted ? styles.muted : ""}`}
          style={{ width: size * 0.52, height: size * 0.52 }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            if (!disabled) onMuteToggle?.();
          }}
          disabled={disabled || !onMuteToggle}
          aria-pressed={muted}
          aria-label={muted ? `Unmute ${label}` : `Mute ${label}`}
          title={muted ? "Muted — press to unmute" : "Press to mute"}
        >
          <span className={styles.muteGlyph}>{muted ? "🔇" : "🔊"}</span>
        </button>
      </div>

      <span className={`${styles.readout} ${muted ? styles.readoutMuted : ""}`}>
        {muted ? "Muted" : valueLabel}
      </span>
      <span className={styles.label} title={label}>
        {label}
      </span>
    </div>
  );
}
