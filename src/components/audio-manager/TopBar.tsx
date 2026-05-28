import { useState } from "react";
import {
  BroadcastIcon,
  ChevronDownIcon,
  RecordIcon,
  SettingsIcon,
} from "./Icon";
import type { Density, Preset, StreamSetupStep } from "./types";
import styles from "./TopBar.module.css";

interface TopBarProps {
  presets: Preset[];
  loadedPresetId: string | null;
  density: Density;
  streamSetupSteps: StreamSetupStep[];
  onLoadPreset: (id: string) => void;
  onSavePreset: () => void;
  onDensityChange: (d: Density) => void;
  onOpenStreamSetup: () => void;
}

/**
 * Top bar: wordmark, preset menu, stream health pill, density toggle, settings.
 */
export function TopBar({
  presets,
  loadedPresetId,
  density,
  streamSetupSteps,
  onLoadPreset,
  onSavePreset,
  onDensityChange,
  onOpenStreamSetup,
}: TopBarProps) {
  const loaded = presets.find((p) => p.id === loadedPresetId);
  const streamHealth = computeStreamHealth(streamSetupSteps);

  return (
    <header className={styles.bar} role="banner">
      <div className={styles.left}>
        <Wordmark />
      </div>

      <div className={styles.center}>
        <PresetMenu
          presets={presets}
          loaded={loaded}
          onLoad={onLoadPreset}
          onSave={onSavePreset}
        />
      </div>

      <div className={styles.right}>
        <button
          className={`${styles.streamPill} ${styles[`streamPill_${streamHealth.tone}`]}`}
          onClick={onOpenStreamSetup}
          aria-label="Open stream setup"
        >
          <BroadcastIcon size={14} />
          <span className={styles.streamPillLabel}>Stream</span>
          <span className={styles.streamPillDot} aria-hidden />
          {streamHealth.pending > 0 && (
            <span className={styles.streamPillCount}>{streamHealth.pending}</span>
          )}
        </button>

        <DensityToggle density={density} onChange={onDensityChange} />

        <button className={styles.iconBtn} aria-label="Settings">
          <SettingsIcon size={16} />
        </button>
      </div>
    </header>
  );
}

/* ── Wordmark ───────────────────────────────────────────────────────────── */

function Wordmark() {
  return (
    <div className={styles.wordmark}>
      <span className={styles.wordmarkDot} aria-hidden>
        <RecordIcon size={14} />
      </span>
      <span className={styles.wordmarkText}>AudioManager</span>
    </div>
  );
}

/* ── Preset menu ────────────────────────────────────────────────────────── */

function PresetMenu({
  presets,
  loaded,
  onLoad,
  onSave,
}: {
  presets: Preset[];
  loaded?: Preset;
  onLoad: (id: string) => void;
  onSave: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className={styles.presetMenu}>
      <button
        className={styles.presetButton}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span className={styles.presetLabel}>Preset</span>
        <span className={styles.presetName}>
          {loaded?.name ?? "No preset loaded"}
        </span>
        <ChevronDownIcon size={14} />
      </button>
      {open && (
        <>
          <div className={styles.menuBackdrop} onClick={() => setOpen(false)} aria-hidden />
          <div className={styles.menuPanel} role="menu">
            <div className={styles.menuHeader}>Load preset</div>
            {presets.length === 0 ? (
              <div className={styles.menuEmpty}>No presets yet.</div>
            ) : (
              presets.map((p) => (
                <button
                  key={p.id}
                  role="menuitem"
                  className={`${styles.menuItem} ${p.id === loaded?.id ? styles.menuItemActive : ""}`}
                  onClick={() => {
                    onLoad(p.id);
                    setOpen(false);
                  }}
                >
                  <span className={styles.menuItemName}>{p.name}</span>
                  {p.version === 1 && (
                    <span className={styles.menuV1}>v1</span>
                  )}
                </button>
              ))
            )}
            <div className={styles.menuDivider} />
            <button
              role="menuitem"
              className={styles.menuItem}
              onClick={() => {
                onSave();
                setOpen(false);
              }}
            >
              <span className={styles.menuItemName}>Save current as…</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ── Density toggle ─────────────────────────────────────────────────────── */

function DensityToggle({
  density,
  onChange,
}: {
  density: Density;
  onChange: (d: Density) => void;
}) {
  return (
    <div className={styles.densityToggle} role="group" aria-label="Density">
      <button
        className={`${styles.densityBtn} ${density === "comfortable" ? styles.densityBtnActive : ""}`}
        onClick={() => onChange("comfortable")}
        title="Comfortable density"
        aria-pressed={density === "comfortable"}
      >
        Cozy
      </button>
      <button
        className={`${styles.densityBtn} ${density === "compact" ? styles.densityBtnActive : ""}`}
        onClick={() => onChange("compact")}
        title="Compact density"
        aria-pressed={density === "compact"}
      >
        Compact
      </button>
    </div>
  );
}

/* ── Stream health helper ───────────────────────────────────────────────── */

function computeStreamHealth(steps: StreamSetupStep[]): {
  tone: "ok" | "warning" | "error" | "pending";
  pending: number;
} {
  let pending = 0;
  let warning = false;
  let error = false;
  for (const s of steps) {
    if (s.status === "ok") continue;
    if (s.status === "error") error = true;
    if (s.status === "warning") warning = true;
    pending++;
  }
  if (error) return { tone: "error", pending };
  if (warning) return { tone: "warning", pending };
  if (pending > 0) return { tone: "pending", pending };
  return { tone: "ok", pending: 0 };
}
