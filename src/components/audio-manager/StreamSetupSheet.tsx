import { useEffect } from "react";
import { CablePanel } from "./CablePanel";
import { AlertIcon, CheckIcon, ChevronRightIcon, XIcon } from "./Icon";
import type { StreamSetupStep } from "./types";
import styles from "./StreamSetupSheet.module.css";

interface StreamSetupSheetProps {
  open: boolean;
  steps: StreamSetupStep[];
  onClose: () => void;
}

/**
 * Slide-in sheet from the right showing a live checklist of the streaming
 * workflow. Non-blocking — the rest of the UI remains visible behind it.
 */
export function StreamSetupSheet({ open, steps, onClose }: StreamSetupSheetProps) {
  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const completedCount = steps.filter((s) => s.status === "ok").length;
  const totalCount = steps.length;
  const progress = (completedCount / totalCount) * 100;

  return (
    <>
      {open && <div className={styles.backdrop} onClick={onClose} aria-hidden />}
      <aside
        className={`${styles.sheet} ${open ? styles.sheetOpen : ""}`}
        role="dialog"
        aria-modal="false"
        aria-labelledby="stream-setup-title"
        aria-hidden={!open}
      >
        <header className={styles.header}>
          <div>
            <div className={styles.eyebrow}>Stream setup</div>
            <h2 id="stream-setup-title" className={styles.title}>
              Going live in {totalCount - completedCount} steps
            </h2>
          </div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close stream setup">
            <XIcon size={16} />
          </button>
        </header>

        <div className={styles.progressTrack}>
          <div className={styles.progressFill} style={{ width: `${progress}%` }} />
        </div>
        <div className={styles.progressLabel}>
          {completedCount} of {totalCount} ready
        </div>

        <CablePanel open={open} />

        <div className={styles.steps}>
          {steps.map((step, idx) => (
            <StepItem key={step.id} step={step} index={idx + 1} />
          ))}
        </div>

        <footer className={styles.footer}>
          <p className={styles.footerHint}>
            Need help with OBS, Discord, or Zoom?
          </p>
          <div className={styles.captureGuides}>
            <CaptureGuide title="OBS Studio" detail="CABLE Output as input" />
            <CaptureGuide title="Discord" detail="Disable AGC/NS/EC" />
            <CaptureGuide title="Zoom" detail="Use Original Sound" />
          </div>
        </footer>
      </aside>
    </>
  );
}

function StepItem({ step, index }: { step: StreamSetupStep; index: number }) {
  return (
    <div className={`${styles.step} ${styles[`step_${step.status}`]}`}>
      <div className={styles.stepIndicator} aria-hidden>
        <StepIcon status={step.status} index={index} />
      </div>
      <div className={styles.stepBody}>
        <div className={styles.stepTitle}>{step.title}</div>
        <div className={styles.stepDetail}>{step.detail}</div>
        {step.actionLabel && step.status !== "ok" && (
          <button className={styles.stepAction}>
            {step.actionLabel}
            <ChevronRightIcon size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

function StepIcon({ status, index }: { status: StreamSetupStep["status"]; index: number }) {
  switch (status) {
    case "ok":      return <CheckIcon size={14} />;
    case "warning": return <AlertIcon size={14} />;
    case "error":   return <AlertIcon size={14} />;
    case "pending":
    default:        return <span className={styles.stepNumber}>{index}</span>;
  }
}

function CaptureGuide({ title, detail }: { title: string; detail: string }) {
  return (
    <button className={styles.captureGuide}>
      <div className={styles.captureGuideText}>
        <div className={styles.captureGuideTitle}>{title}</div>
        <div className={styles.captureGuideDetail}>{detail}</div>
      </div>
      <ChevronRightIcon size={14} />
    </button>
  );
}
