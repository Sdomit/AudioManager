import { useCallback, useEffect, useState } from "react";
import { AlertIcon, InfoIcon, XIcon } from "./Icon";
import { queryAmvcHelper } from "../../utils/amvc";
import type { AmvcQueryResult } from "../../utils/amvc";
import styles from "./AmvcBanner.module.css";

const POLL_MS = 30_000;

export function AmvcBanner() {
  const [result, setResult] = useState<AmvcQueryResult | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const refresh = useCallback(() => {
    queryAmvcHelper().then(setResult).catch(() => setResult(null));
  }, []);

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  if (!result || dismissed) return null;
  if (result.kind === "unavailable") return null;

  const { status, names_aligned } = result;

  if (status === "installed-healthy" && names_aligned) return null;

  if (status === "installed-healthy" && !names_aligned) {
    return (
      <div className={`${styles.banner} ${styles.info}`} role="status">
        <span className={styles.icon}><InfoIcon size={14} /></span>
        <div className={styles.text}>
          <span>Virtual cable endpoint names are out of sync.</span>
          <span className={styles.detail}>Run <code>amvc-helper rename-endpoints</code> (elevated) to fix.</span>
        </div>
        <button className={styles.dismissBtn} onClick={() => setDismissed(true)} aria-label="Dismiss">
          <XIcon size={14} />
        </button>
      </div>
    );
  }

  if (status === "needs-reboot") {
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

  if (status === "installed-degraded" || status === "needs-repair") {
    return (
      <div className={`${styles.banner} ${styles.warning}`} role="alert">
        <span className={styles.icon}><AlertIcon size={14} /></span>
        <div className={styles.text}>
          <strong>
            {status === "installed-degraded"
              ? `Virtual cable degraded (${result.found}/${result.expected} endpoints)`
              : "Virtual cable not responding"}
          </strong>
          <span className={styles.detail}>Run <code>amvc-helper repair &lt;inf&gt; --execute</code> (elevated) to restore.</span>
        </div>
        <button className={styles.dismissBtn} onClick={() => setDismissed(true)} aria-label="Dismiss">
          <XIcon size={14} />
        </button>
      </div>
    );
  }

  if (status === "not-installed") {
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
