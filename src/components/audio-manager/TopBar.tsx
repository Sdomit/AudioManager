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
  defaultPresetId: string | null;
  density: Density;
  streamSetupSteps: StreamSetupStep[];
  onLoadPreset: (id: string) => void;
  /** Open the save-preset dialog. Parent owns the dialog state. */
  onOpenSaveDialog: () => void;
  /** Open the rename-preset dialog for the given preset. */
  onRenamePreset: (id: string) => void;
  onDeletePreset: (id: string) => void;
  /** Pass null to clear the default. */
  onSetDefaultPreset: (id: string | null) => void;
  onDensityChange: (d: Density) => void;
  onOpenStreamSetup: () => void;
}

/**
 * Top bar: wordmark, preset menu, stream health pill, density toggle, settings.
 */
export function TopBar({
  presets,
  loadedPresetId,
  defaultPresetId,
  density,
  streamSetupSteps,
  onLoadPreset,
  onOpenSaveDialog,
  onRenamePreset,
  onDeletePreset,
  onSetDefaultPreset,
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
          defaultPresetId={defaultPresetId}
          onLoad={onLoadPreset}
          onSave={onOpenSaveDialog}
          onRename={onRenamePreset}
          onDelete={onDeletePreset}
          onSetDefault={onSetDefaultPreset}
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
  defaultPresetId,
  onLoad,
  onSave,
  onRename,
  onDelete,
  onSetDefault,
}: {
  presets: Preset[];
  loaded?: Preset;
  defaultPresetId: string | null;
  onLoad: (id: string) => void;
  onSave: () => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
  onSetDefault: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [ctxFor, setCtxFor] = useState<string | null>(null);
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const ctxTarget = ctxFor ? presets.find((p) => p.id === ctxFor) ?? null : null;
  const closeCtx = () => setCtxFor(null);

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
          <div
            className={styles.menuBackdrop}
            onClick={() => {
              closeCtx();
              setOpen(false);
            }}
            aria-hidden
          />
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
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setCtxFor(p.id);
                    setCtxPos({ x: e.clientX, y: e.clientY });
                  }}
                  title="Click to load, right-click for options"
                >
                  <span className={styles.menuItemName}>
                    {p.id === defaultPresetId && (
                      <span className={styles.menuStar} aria-label="Default preset" title="Default preset">
                        ★
                      </span>
                    )}
                    {p.name}
                  </span>
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

      {ctxTarget && (
        <PresetContextMenu
          target={ctxTarget}
          isDefault={ctxTarget.id === defaultPresetId}
          isLoaded={ctxTarget.id === loaded?.id}
          x={ctxPos.x}
          y={ctxPos.y}
          onLoad={() => {
            onLoad(ctxTarget.id);
            closeCtx();
            setOpen(false);
          }}
          onRename={() => {
            onRename(ctxTarget.id);
            closeCtx();
            setOpen(false);
          }}
          onDelete={() => {
            const ok = window.confirm(
              `Delete preset “${ctxTarget.name}”? This cannot be undone.`,
            );
            if (!ok) return;
            onDelete(ctxTarget.id);
            closeCtx();
            setOpen(false);
          }}
          onSetDefault={() => {
            onSetDefault(
              ctxTarget.id === defaultPresetId ? null : ctxTarget.id,
            );
            closeCtx();
          }}
          onClose={closeCtx}
        />
      )}
    </div>
  );
}

/* ── Preset right-click context menu ────────────────────────────────────── */

function PresetContextMenu({
  target,
  isDefault,
  isLoaded,
  x,
  y,
  onLoad,
  onRename,
  onDelete,
  onSetDefault,
  onClose,
}: {
  target: Preset;
  isDefault: boolean;
  isLoaded: boolean;
  x: number;
  y: number;
  onLoad: () => void;
  onRename: () => void;
  onDelete: () => void;
  onSetDefault: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className={styles.ctxBackdrop} onClick={onClose} aria-hidden />
      <div
        className={styles.ctxMenu}
        role="menu"
        aria-label={`Preset ${target.name} actions`}
        style={{ left: x, top: y }}
      >
        <button
          role="menuitem"
          className={styles.ctxItem}
          onClick={onLoad}
          disabled={isLoaded}
        >
          Load preset
        </button>
        <button role="menuitem" className={styles.ctxItem} onClick={onRename}>
          Rename…
        </button>
        <button role="menuitem" className={styles.ctxItem} onClick={onSetDefault}>
          {isDefault ? "Remove as default" : "Set as default"}
        </button>
        <div className={styles.ctxDivider} />
        <button
          role="menuitem"
          className={`${styles.ctxItem} ${styles.ctxItemDanger}`}
          onClick={onDelete}
        >
          Delete preset
        </button>
      </div>
    </>
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
