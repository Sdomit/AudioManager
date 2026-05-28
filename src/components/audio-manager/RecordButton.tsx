import { useEffect, useRef, useState } from "react";
import { RecordIcon } from "./Icon";
import type { ActiveRecording, TapSpec } from "./types";
import styles from "./RecordButton.module.css";

interface RecordButtonProps {
  /** Spec to match against `activeRecordings`. When a match is found the
   *  button renders in the "armed" state with a live elapsed-time tooltip. */
  spec: TapSpec;
  active: ActiveRecording[];
  onStart: (spec: TapSpec) => void;
  onStop: (id: string) => void;
  /** 12-20 px. Defaults to 14. */
  size?: number;
  /** Tooltip text for the inactive state. */
  title?: string;
  /** Hide the button entirely when disabled (engine not running). */
  disabled?: boolean;
  /** Compact mode: no label, smaller padding. */
  compact?: boolean;
}

export function findRecording(
  active: ActiveRecording[],
  spec: TapSpec,
): ActiveRecording | null {
  return (
    active.find((r) => {
      const s = r.spec;
      if (s.kind !== spec.kind) return false;
      switch (spec.kind) {
        case "input_pre":
          return s.kind === "input_pre" && s.device_id === spec.device_id;
        case "input_post":
          return (
            s.kind === "input_post" &&
            s.device_id === spec.device_id &&
            s.bus_id === spec.bus_id
          );
        case "bus_out":
          return s.kind === "bus_out" && s.bus_id === spec.bus_id;
      }
    }) ?? null
  );
}

/**
 * Small REC button. Click toggles the recording for the given tap spec.
 * Renders red + pulsing when armed; ghost otherwise.
 */
export function RecordButton({
  spec,
  active,
  onStart,
  onStop,
  size = 14,
  title,
  disabled,
  compact,
}: RecordButtonProps) {
  const rec = findRecording(active, spec);
  const armed = !!rec;

  if (disabled && !armed) {
    return (
      <button
        type="button"
        className={`${styles.btn} ${styles.btnDisabled}`}
        disabled
        title={title ?? "Recording unavailable (engine stopped)"}
        aria-label="Record (unavailable)"
      >
        <RecordIcon size={size} />
      </button>
    );
  }

  return (
    <button
      type="button"
      className={`${styles.btn} ${armed ? styles.btnArmed : ""} ${compact ? styles.btnCompact : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        if (rec) onStop(rec.id);
        else onStart(spec);
      }}
      title={armed ? `Recording — click to stop` : title ?? "Start recording"}
      aria-label={armed ? "Stop recording" : "Start recording"}
      aria-pressed={armed}
    >
      <RecordIcon size={size} />
      {armed && !compact && <span className={styles.elapsedLabel}>
        <ElapsedTime startedAtMs={rec.started_at_unix_ms} />
      </span>}
    </button>
  );
}

/** Updates once per second. Format mm:ss or h:mm:ss. */
export function ElapsedTime({ startedAtMs }: { startedAtMs: number }) {
  const [now, setNow] = useState(() => Date.now());
  const ref = useRef(0);
  useEffect(() => {
    ref.current = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(ref.current);
  }, []);
  const secs = Math.max(0, Math.floor((now - startedAtMs) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return <>{h}:{m.toString().padStart(2, "0")}:{s.toString().padStart(2, "0")}</>;
  return <>{m.toString().padStart(2, "0")}:{s.toString().padStart(2, "0")}</>;
}
