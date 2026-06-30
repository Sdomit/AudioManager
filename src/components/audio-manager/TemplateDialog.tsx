import { useState } from "react";
import { XIcon } from "./Icon";
import { DEVICE_TEMPLATES } from "./templates";
import type { DeviceTemplate } from "./templates";
import styles from "./TemplateDialog.module.css";

interface Props {
  open: boolean;
  onClose: () => void;
  onApply: (template: DeviceTemplate) => Promise<void>;
}

export function TemplateDialog({ open, onClose, onApply }: Props) {
  const [applying, setApplying] = useState<string | null>(null);

  if (!open) return null;

  const handleApply = async (t: DeviceTemplate) => {
    setApplying(t.id);
    try {
      await onApply(t);
      onClose();
    } finally {
      setApplying(null);
    }
  };

  return (
    <div className={styles.backdrop} onClick={onClose} role="dialog" aria-modal="true" aria-label="Start from template">
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <header className={styles.header}>
          <h2 className={styles.title}>Start from template</h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <XIcon size={14} />
          </button>
        </header>

        <p className={styles.hint}>
          Applies bus names and gain staging. Assign output devices after.
        </p>

        <div className={styles.grid}>
          {DEVICE_TEMPLATES.map((t) => (
            <div key={t.id} className={styles.card}>
              <div className={styles.cardName}>{t.name}</div>
              <p className={styles.cardDesc}>{t.description}</p>
              <ul className={styles.busList}>
                {t.buses.map((b) => (
                  <li key={b.id} className={styles.busItem}>
                    <span className={styles.busId}>{b.id}</span>
                    <span className={styles.busName}>{b.name}</span>
                    <span className={styles.busVol}>{Math.round(b.volume * 100)}%</span>
                  </li>
                ))}
              </ul>
              <button
                className={styles.applyBtn}
                onClick={() => void handleApply(t)}
                disabled={applying !== null}
              >
                {applying === t.id ? "Applying…" : "Apply"}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
