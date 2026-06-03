import { useRef, useState } from "react";
import { launchAmvcInstaller, queryAmvcHelper } from "../../utils/amvc";
import styles from "./CableNotice.module.css";

interface CableNoticeProps {
  onDismiss: () => void;
  /** Re-poll device lists (e.g. after the installer has run, or to clear a stale notice). */
  onRecheck: () => void;
}

type ActionState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "installing" }
  | { phase: "done"; label: string };

export function CableNotice({ onDismiss, onRecheck }: CableNoticeProps) {
  const [action, setAction] = useState<ActionState>({ phase: "idle" });
  // Synchronous re-entry guard. The `disabled` attribute blocks clicks once a
  // re-render commits, but two clicks fired in the same tick both capture the
  // stale "idle" closure; this ref closes that window so the installer can
  // never be spawned twice.
  const busyRef = useRef(false);

  async function handleAction() {
    if (busyRef.current || action.phase !== "idle") return;
    busyRef.current = true;
    try {
      setAction({ phase: "checking" });
      const result = await queryAmvcHelper().catch(() => ({
        kind: "unavailable" as const,
        reason: "query failed",
      }));

      if (result.kind === "unavailable") {
        setAction({ phase: "done", label: "Helper not found" });
        return;
      }

      if (result.status === "needs-reboot") {
        setAction({ phase: "done", label: "Reboot required" });
        return;
      }

      if (result.status === "installed-healthy") {
        // Driver is actually present and healthy — the notice is stale.
        // Re-poll devices so it dismisses itself; never run the installer.
        setAction({ phase: "idle" });
        onRecheck();
        return;
      }

      // not-installed / needs-repair / installed-degraded → run the installer,
      // then hold in "installing" so the button stays disabled. The installer
      // runs in the background (and may require a reboot), so completion can't
      // be detected automatically — the user re-checks explicitly.
      try {
        await launchAmvcInstaller();
        setAction({ phase: "installing" });
      } catch {
        setAction({ phase: "done", label: "Launch failed" });
      }
    } finally {
      busyRef.current = false;
    }
  }

  const primaryLabel =
    action.phase === "checking"
      ? "Checking…"
      : action.phase === "installing"
      ? "Installing…"
      : action.phase === "done"
      ? action.label
      : "Install / Repair";

  return (
    <div className={styles.notice} role="status" aria-label="AudioManager Virtual Cable notice">
      <span className={styles.message}>
        Install the AudioManager Virtual Cable to enable branded routing.
      </span>
      <div className={styles.actions}>
        <button
          className={styles.actionBtn}
          onClick={() => void handleAction()}
          disabled={action.phase !== "idle"}
        >
          {primaryLabel}
        </button>
        {action.phase === "installing" && (
          <button className={styles.actionBtn} onClick={onRecheck}>
            Re-check
          </button>
        )}
        <button className={styles.dismissBtn} aria-label="Dismiss notice" onClick={onDismiss}>
          ×
        </button>
      </div>
    </div>
  );
}
