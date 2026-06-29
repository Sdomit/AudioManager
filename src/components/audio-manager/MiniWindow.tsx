import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { MiniPanel } from "./MiniPanel";
import styles from "./MiniWindow.module.css";

const noop = () => {};

/**
 * Standalone content for the always-on-top mini window (the `#mini` route).
 * Endpoint-only — it controls the OS default speaker/mic, so it needs no app
 * state and runs no mixer poll. A custom drag titlebar replaces the chrome
 * (the window has `decorations: false`).
 */
export function MiniWindow() {
  return (
    <div className={styles.root}>
      <div className={styles.titlebar} data-tauri-drag-region>
        <span className={styles.title}>Mini Controller</span>
        <button
          type="button"
          className={styles.close}
          onClick={() => void getCurrentWebviewWindow().hide()}
          aria-label="Close mini controller"
          title="Close (reopen from the app or hotkey)"
        >
          ×
        </button>
      </div>
      <MiniPanel
        variant="window"
        endpointOnly
        buses={[]}
        inputs={[]}
        setBusVolume={noop}
        setBusMuted={noop}
        setInputGain={noop}
        setInputMuted={noop}
      />
    </div>
  );
}
