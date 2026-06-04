import { useCallback, useEffect, useState } from "react";
import { AlertIcon, InfoIcon, XIcon } from "./Icon";
import { amvcStatus, amvcRenameEndpoints } from "../../utils/amvc";
import type { AmvcStatus } from "../../utils/amvc";
import styles from "./AmvcBanner.module.css";

const POLL_MS = 30_000;

export function AmvcBanner() {
  const [status, setStatus] = useState<AmvcStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    amvcStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  if (!status || dismissed) return null;

  const { status: s, names_aligned } = status;

  if (s === "installed-healthy" && names_aligned) return null;

  const handleFixNames = async () => {
    setBusy(true);
    try {
      await amvcRenameEndpoints();
      refresh();
    } finally {
      setBusy(false);
    }
  };

  if (s === "installed-healthy" && !names_aligned) {
    return (
      <div className={`${styles.banner} ${styles.info}`} role="status">
        <span className={styles.icon}><InfoIcon size={14} /></span>
        <div className={styles.text}>
          <span>Virtual cable endpoint names are out of sync.</span>
          <button className={styles.link} onClick={handleFixNames} disabled={busy}>
            {busy ? "Fixing…" : "Fix names"}
          </button>
        </div>
        <button className={styles.dismissBtn} onClick={() => setDismissed(true)} aria-label="Dismiss">
          <XIcon size={14} />
        </button>
      </div>
    );
  }

  if (s === "needs-reboot") {
    return (
      <div className={`${styles.banner} ${styles.info}`} role="status">
        <span className={styles.icon}><InfoIcon size={14} /></span>
        <div className={styles.text}>
          <strong>Reboot required</strong>
          <span className={styles.detail}>Virtual cable driver installed — reboot to activate endpoints.</span>
        </div>
        <button className={styles.dismissBtn} onClick={() => setDismissed(true)} aria-label="Dismiss">
          <XIcon size={14} />
        </button>
      </div>
    );
  }

  if (s === "installed-degraded" || s === "needs-repair") {
    return (
      <div className={`${styles.banner} ${styles.warning}`} role="alert">
        <span className={styles.icon}><AlertIcon size={14} /></span>
        <div className={styles.text}>
          <strong>
            {s === "installed-degraded"
              ? `Virtual cable degraded (${status.found}/${status.expected} endpoints)`
              : "Virtual cable not responding"}
          </strong>
          <span className={styles.detail}>Run Repair to restore all endpoints.</span>
        </div>
        <button className={styles.dismissBtn} onClick={() => setDismissed(true)} aria-label="Dismiss">
          <XIcon size={14} />
        </button>
      </div>
    );
  }

  if (s === "not-installed") {
    return (
      <div className={`${styles.banner} ${styles.info}`} role="status">
        <span className={styles.icon}><InfoIcon size={14} /></span>
        <div className={styles.text}>
          <span>AudioManager virtual cable not installed.</span>
          <span className={styles.detail}>Routing and presets work without it.</span>
        </div>
        <button className={styles.dismissBtn} onClick={() => setDismissed(true)} aria-label="Dismiss">
          <XIcon size={14} />
        </button>
      </div>
    );
  }

  return null;
}
