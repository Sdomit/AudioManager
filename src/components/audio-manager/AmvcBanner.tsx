import { useCallback, useEffect, useState } from "react";
import { AlertIcon, InfoIcon, XIcon } from "./Icon";
import { queryAmvcHelper } from "../../utils/amvc";
import type { AmvcQueryResult } from "../../utils/amvc";
import { amvcRenameToBusNames } from "../../ipc/commands";
import styles from "./AmvcBanner.module.css";

const POLL_MS = 30_000;
const DEFAULT_BUS_NAMES = ["A1 Monitor", "A2 Speakers", "B1 Stream", "B2 Record"] as const;

interface AmvcBannerProps {
  /** Current bus names in A1/A2/B1/B2 order. Falls back to defaults when absent. */
  busNames?: readonly string[];
}

export function AmvcBanner({ busNames }: AmvcBannerProps) {
  const [result, setResult] = useState<AmvcQueryResult | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    queryAmvcHelper().then(setResult).catch(() => setResult(null));
  }, []);

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const effective = (busNames && busNames.length >= 4) ? busNames : DEFAULT_BUS_NAMES;

  const handleRenameToBusNames = useCallback(async () => {
    setRenaming(true);
    setRenameError(null);
    try {
      await amvcRenameToBusNames(effective[0], effective[1], effective[2], effective[3]);
      refresh();
    } catch (e) {
      setRenameError(String(e));
    } finally {
      setRenaming(false);
    }
  }, [effective, refresh]);

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
          {renameError ? (
            <span className={styles.detail} style={{ color: "var(--am-error, #f87171)" }}>{renameError}</span>
          ) : (
            <span className={styles.detail}>
              <button className={styles.link} onClick={() => void handleRenameToBusNames()} disabled={renaming}>
                {renaming ? "Renaming…" : `Rename to bus names (${effective.slice(0, 4).join(", ")})`}
              </button>
            </span>
          )}
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

  // not-installed handled by CableNotice

  return null;
}
