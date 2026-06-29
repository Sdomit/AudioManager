import { useCallback, useRef } from "react";
import styles from "./Knob.module.css";

interface KnobProps {
  /** Current value, 0..1. */
  value: number;
  onChange: (v: number) => void;
  /** Caption under the knob. */
  label: string;
  /** Right-hand readout, e.g. "72%" or "-6 dB". */
  valueLabel: string;
  ariaLabel?: string;
  /** CSS color for the arc + indicator. Defaults to the app accent. */
  accent?: string;
  disabled?: boolean;
  /** Diameter in px. Default 72. */
  size?: number;
}

// 270° sweep with the 90° gap centred at the bottom (6 o'clock).
const R = 40;
const C = 2 * Math.PI * R; // circumference
const ARC = 0.75; // fraction of the circle that is live (270°)
const ARC_LEN = ARC * C;
const START_DEG = 135; // value 0 sits at 7:30

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function indicator(value: number): { x: number; y: number } {
  const rad = ((START_DEG + clamp01(value) * 270) * Math.PI) / 180;
  return { x: 50 + R * Math.cos(rad), y: 50 + R * Math.sin(rad) };
}

/**
 * A rotary knob that behaves like a slider: vertical drag, wheel, and arrow
 * keys all change the value, and it exposes `role="slider"` for a11y / touch.
 * Visual only — mute and target-picking live in the parent panel.
 */
export function Knob({
  value,
  onChange,
  label,
  valueLabel,
  ariaLabel,
  accent,
  disabled = false,
  size = 72,
}: KnobProps) {
  const drag = useRef<{ startY: number; startValue: number } | null>(null);
  const v = clamp01(value);
  const ind = indicator(v);
  const color = accent ?? "var(--am-accent)";

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
      // Up = louder. Full travel over ~160px; Shift = fine.
      const span = e.shiftKey ? 480 : 160;
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
    [disabled, onChange, v],
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
        aria-valuetext={valueLabel}
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
          {/* track */}
          <circle
            cx={50}
            cy={50}
            r={R}
            className={styles.track}
            strokeDasharray={`${ARC_LEN} ${C}`}
            transform="rotate(135 50 50)"
          />
          {/* value arc */}
          <circle
            cx={50}
            cy={50}
            r={R}
            fill="none"
            stroke={color}
            strokeWidth={8}
            strokeLinecap="round"
            strokeDasharray={`${v * ARC_LEN} ${C}`}
            transform="rotate(135 50 50)"
          />
          {/* indicator dot */}
          <circle cx={ind.x} cy={ind.y} r={5} fill={color} />
        </svg>
        <span className={styles.readout}>{valueLabel}</span>
      </div>
      <span className={styles.label} title={label}>
        {label}
      </span>
    </div>
  );
}
