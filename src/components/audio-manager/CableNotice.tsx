import styles from "./CableNotice.module.css";

interface CableNoticeProps {
  onInstallRepair: () => void;
  onDismiss: () => void;
}

export function CableNotice({ onInstallRepair, onDismiss }: CableNoticeProps) {
  return (
    <div className={styles.notice} role="status" aria-label="AudioManager Virtual Cable notice">
      <span className={styles.message}>
        Install the AudioManager Virtual Cable to enable branded routing.
      </span>
      <div className={styles.actions}>
        <button className={styles.actionBtn} onClick={onInstallRepair}>
          Install / Repair
        </button>
        <button className={styles.dismissBtn} aria-label="Dismiss notice" onClick={onDismiss}>
          ×
        </button>
      </div>
    </div>
  );
}
