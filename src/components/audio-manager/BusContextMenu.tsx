import { useEffect } from "react";
import type { Bus, BusRole } from "./types";
import styles from "./BusContextMenu.module.css";

interface BusContextMenuProps {
  target: Bus;
  defaultRole: BusRole;
  x: number;
  y: number;
  onRename: () => void;
  onPickDevice: () => void;
  onSetRole: (role: BusRole | null) => void;
  onClose: () => void;
}

const ROLE_OPTIONS: { value: BusRole; label: string }[] = [
  { value: "monitor", label: "Monitor (headphones)" },
  { value: "speakers", label: "Speakers" },
  { value: "stream", label: "Stream" },
  { value: "record", label: "Record" },
];

/**
 * Right-click menu for a bus card. Lets the user rename the bus
 * (backend write), change the device, or override the bus's visual
 * role (icon + accent color, persisted client-side).
 *
 * Bus IDs (A1/A2/B1/B2) and the four-bus count remain fixed.
 */
export function BusContextMenu({
  target,
  defaultRole,
  x,
  y,
  onRename,
  onPickDevice,
  onSetRole,
  onClose,
}: BusContextMenuProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div
        className={styles.backdrop}
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
        aria-hidden
      />
      <div
        className={styles.menu}
        role="menu"
        aria-label={`${target.label} (${target.id}) actions`}
        style={{ left: x, top: y }}
      >
        <button
          role="menuitem"
          className={styles.item}
          onClick={onRename}
        >
          Rename bus…
        </button>
        <button
          role="menuitem"
          className={styles.item}
          onClick={onPickDevice}
        >
          {target.device ? "Change device…" : "Pick device…"}
        </button>

        <div className={styles.divider} />
        <div className={styles.sectionLabel}>Role</div>
        {ROLE_OPTIONS.map((r) => {
          const active = target.role === r.value;
          const isDefault = r.value === defaultRole;
          return (
            <button
              key={r.value}
              role="menuitemradio"
              aria-checked={active}
              className={`${styles.item} ${active ? styles.itemActive : ""}`}
              onClick={() => onSetRole(isDefault ? null : r.value)}
            >
              <span className={styles.check}>{active ? "✓ " : ""}</span>
              {r.label}
              {isDefault && <span className={styles.defaultTag}>default</span>}
            </button>
          );
        })}
      </div>
    </>
  );
}
