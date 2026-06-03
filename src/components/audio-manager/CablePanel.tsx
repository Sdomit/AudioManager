import { useEffect, useRef, useState } from "react";
import { launchAmvcInstaller, queryAmvcHelper } from "../../utils/amvc";
import type { AmvcQueryResult } from "../../types/engine";
import { AMVC_ALL_DEVICE_NAMES } from "../../utils/amvcPresets";
import styles from "./CablePanel.module.css";

interface CablePanelProps {
  /** Query the helper when the host sheet opens; idle while closed. */
  open: boolean;
}

type Tone = "ok" | "warn" | "neutral" | "error";

export function CablePanel({ open }: CablePanelProps) {
  const [result, setResult] = useState<AmvcQueryResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const busyRef = useRef(false);

  async function recheck() {
    if (busyRef.current) return;
    busyRef.current = true;
    setChecking(true);
    try {
      const r = await queryAmvcHelper().catch(
        (): AmvcQueryResult => ({ kind: "unavailable", reason: "query failed" }),
      );
      setResult(r);
    } finally {
      setChecking(false);
      busyRef.current = false;
    }
  }

  async function install() {
    if (busyRef.current) return;
    busyRef.current = true;
    setInstalling(true);
    try {
      await launchAmvcInstaller();
    } catch {
      // Surface via the next re-check; the helper may be absent.
    } finally {
      busyRef.current = false;
    }
  }

  // Query once each time the sheet transitions to open.
  useEffect(() => {
    if (open) void recheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const detected = new Set(
    result?.kind === "ok" ? result.detected.map((n) => n.toLowerCase()) : [],
  );

  let tone: Tone = "neutral";
  let headline = "Checking…";
  let detail = "";
  let showInstall = false;
  let installLabel = "Install";

  if (result?.kind === "unavailable") {
    tone = "neutral";
    headline = "Helper not found";
    detail =
      "Install the AudioManager Virtual Cable. Its helper (amvc-helper) was not detected on this system.";
  } else if (result?.kind === "ok") {
    const { status, found, expected } = result;
    switch (status) {
      case "installed-healthy":
        tone = "ok";
        headline = "Connected";
        detail = `All ${expected} endpoints present.`;
        break;
      case "needs-reboot":
        tone = "warn";
        headline = "Reboot required";
        detail = "The cable is installed but needs a system reboot to finish.";
        break;
      case "installed-degraded":
      case "needs-repair":
        tone = "warn";
        headline = status === "needs-repair" ? "Needs repair" : "Degraded";
        detail = `${found} of ${expected} endpoints present.`;
        showInstall = true;
        installLabel = "Repair";
        break;
      case "not-installed":
      default:
        tone = "neutral";
        headline = "Not installed";
        detail = "Install the AudioManager Virtual Cable to enable branded routing.";
        showInstall = true;
        installLabel = "Install";
        break;
    }
  }

  return (
    <section className={`${styles.panel} ${styles[`tone_${tone}`]}`} aria-label="Virtual cable status">
      <div className={styles.head}>
        <span className={`${styles.dot} ${styles[`dot_${tone}`]}`} aria-hidden />
        <div className={styles.headText}>
          <div className={styles.headline}>AudioManager Virtual Cable — {headline}</div>
          {detail && <div className={styles.detail}>{detail}</div>}
        </div>
      </div>

      <ul className={styles.endpoints}>
        {AMVC_ALL_DEVICE_NAMES.map((name) => {
          const live = detected.has(name.toLowerCase());
          return (
            <li key={name} className={live ? styles.epLive : styles.epMissing}>
              <span className={styles.epDot} aria-hidden />
              {name.replace(/^AudioManager /, "")}
            </li>
          );
        })}
      </ul>

      <div className={styles.actions}>
        {showInstall && (
          <button
            className={styles.primaryBtn}
            onClick={() => void install()}
            disabled={installing || checking}
          >
            {installing ? "Installing…" : installLabel}
          </button>
        )}
        <button
          className={styles.secondaryBtn}
          onClick={() => void recheck()}
          disabled={checking}
        >
          {checking ? "Checking…" : "Re-check"}
        </button>
      </div>
    </section>
  );
}
