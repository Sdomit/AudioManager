import { useState } from "react";
import { launchAmvcInstaller, queryAmvcHelper } from "../../utils/amvc";
import styles from "./CableNotice.module.css";

interface CableNoticeProps {
  onDismiss: () => void;
}

type ActionState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "done"; label: string; disabled: boolean };

export function CableNotice({ onDismiss }: CableNoticeProps) {
  const [action, setAction] = useState<ActionState>({ phase: "idle" });

  async function handleAction() {
    if (action.phase === "checking") return;
    if (action.phase === "done" && action.disabled) return;

    setAction({ phase: "checking" });
    const result = await queryAmvcHelper().catch(() => ({
      kind: "unavailable" as const,
      reason: "query failed",
    }));

    if (result.kind === "unavailable") {
      setAction({ phase: "done", label: "Helper not found", disabled: true });
      return;
    }

    if (result.status === "needs-reboot") {
      setAction({ phase: "done", label: "Reboot required", disabled: true });
      return;
    }

    // not-installed, needs-repair, installed-degraded → launch installer
    setAction({ phase: "idle" });
    launchAmvcInstaller().catch(() => {
      setAction({ phase: "done", label: "Launch failed", disabled: true });
    });
  }

  const btnLabel =
    action.phase === "checking"
      ? "Checking…"
      : action.phase === "done"
      ? action.label
      : "Install / Repair";

  const btnDisabled =
    action.phase === "checking" ||
    (action.phase === "done" && action.disabled);

  return (
    <div className={styles.notice} role="status" aria-label="AudioManager Virtual Cable notice">
      <span className={styles.message}>
        Install the AudioManager Virtual Cable to enable branded routing.
      </span>
      <div className={styles.actions}>
        <button
          className={styles.actionBtn}
          onClick={() => void handleAction()}
          disabled={btnDisabled}
        >
          {btnLabel}
        </button>
        <button className={styles.dismissBtn} aria-label="Dismiss notice" onClick={onDismiss}>
          ×
        </button>
      </div>
    </div>
  );
}
