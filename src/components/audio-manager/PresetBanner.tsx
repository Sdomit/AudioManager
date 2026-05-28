import { InfoIcon, XIcon } from "./Icon";
import type { Preset } from "./types";
import styles from "./PresetBanner.module.css";

interface PresetBannerProps {
  preset: Preset;
  onDismiss: () => void;
}

/**
 * Notification banner shown after a preset is loaded.
 *
 * Reminds the user that buses are NOT auto-started, per the safe-load
 * policy. Stays visible until dismissed.
 */
export function PresetBanner({ preset, onDismiss }: PresetBannerProps) {
  return (
    <div className={styles.banner} role="status">
      <span className={styles.icon}>
        <InfoIcon size={14} />
      </span>
      <div className={styles.text}>
        <strong>Loaded preset "{preset.name}"</strong>
        <span className={styles.detail}>
          Routing and gains are restored, but buses are off for safety.{" "}
          <strong>Enable buses</strong> when you're ready.
        </span>
      </div>
      <button
        className={styles.dismissBtn}
        onClick={onDismiss}
        aria-label="Dismiss preset banner"
      >
        <XIcon size={14} />
      </button>
    </div>
  );
}
