import type { ReactNode } from "react";
import styles from "./Pill.module.css";

export type PillTone = "neutral" | "success" | "warning" | "danger" | "info" | "accent";

interface PillProps {
  tone?: PillTone;
  icon?: ReactNode;
  children: ReactNode;
  size?: "sm" | "md";
}

/**
 * Small colored chip used for bus state, step status, etc.
 * Color + a leading dot/icon + a label. Never relies on color alone.
 */
export function Pill({ tone = "neutral", icon, size = "md", children }: PillProps) {
  return (
    <span
      className={`${styles.pill} ${styles[tone]} ${size === "sm" ? styles.sm : ""}`}
      role="status"
    >
      {icon ? (
        <span className={styles.icon} aria-hidden>
          {icon}
        </span>
      ) : (
        <span className={styles.dot} aria-hidden />
      )}
      <span className={styles.label}>{children}</span>
    </span>
  );
}
