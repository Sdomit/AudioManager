import { useEffect } from "react";
import { XIcon } from "./Icon";
import styles from "./HotkeyOverlay.module.css";

interface HotkeyOverlayProps {
  open: boolean;
  onClose: () => void;
}

interface HotkeyEntry {
  keys: string[];
  description: string;
}

interface HotkeyGroup {
  title: string;
  entries: HotkeyEntry[];
}

/**
 * Single source of truth for the keyboard map. Mirror this list when
 * adding a new hotkey to useHotkeys.
 */
const HOTKEY_GROUPS: HotkeyGroup[] = [
  {
    title: "Selection",
    entries: [
      { keys: ["1"], description: "Focus bus A1 (Monitor)" },
      { keys: ["2"], description: "Focus bus A2 (Speakers)" },
      { keys: ["3"], description: "Focus bus B1 (Stream)" },
      { keys: ["4"], description: "Focus bus B2 (Record)" },
      { keys: ["↑", "↓"], description: "Navigate inputs (when an input is selected)" },
      { keys: ["V"], description: "Toggle console / card view" },
    ],
  },
  {
    title: "Bus / input control",
    entries: [
      { keys: ["Space"], description: "Enable / disable selected bus" },
      { keys: ["M"], description: "Mute / unmute selected bus or input" },
      { keys: ["S"], description: "Solo selected input (mute all others); press again to unsolo" },
      { keys: ["↑", "↓"], description: "Nudge volume ±1% (when a bus is selected)" },
      { keys: ["Shift", "↑", "↓"], description: "Nudge volume ±5% (coarse)" },
    ],
  },
  {
    title: "Recording",
    entries: [
      { keys: ["R"], description: "Toggle master recording (every running bus)" },
    ],
  },
  {
    title: "Presets",
    entries: [
      { keys: ["Ctrl", "S"], description: "Save current preset…" },
    ],
  },
  {
    title: "App",
    entries: [
      { keys: ["?"], description: "Show this overlay" },
      { keys: ["Esc"], description: "Close overlays / dialogs" },
    ],
  },
];

export function HotkeyOverlay({ open, onClose }: HotkeyOverlayProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="hotkey-overlay-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.header}>
          <h2 id="hotkey-overlay-title" className={styles.title}>
            Keyboard shortcuts
          </h2>
          <button
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Close"
          >
            <XIcon size={14} />
          </button>
        </header>

        <div className={styles.body}>
          {HOTKEY_GROUPS.map((group) => (
            <section key={group.title} className={styles.group}>
              <h3 className={styles.groupTitle}>{group.title}</h3>
              <dl className={styles.entries}>
                {group.entries.map((entry) => (
                  <div key={entry.description} className={styles.entry}>
                    <dt className={styles.keys}>
                      {entry.keys.map((k, i) => (
                        <span key={`${k}-${i}`} className={styles.key}>
                          {k}
                        </span>
                      ))}
                    </dt>
                    <dd className={styles.description}>{entry.description}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>

        <footer className={styles.footer}>
          <span className={styles.footerHint}>
            Shortcuts pause while a text field is focused.
          </span>
        </footer>
      </div>
    </div>
  );
}
