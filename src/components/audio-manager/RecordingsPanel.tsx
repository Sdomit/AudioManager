import { useEffect, useState } from "react";
import * as ipc from "../../ipc/commands";
import type { RecordFormat } from "../../types/engine";
import { AlertIcon, RecordIcon, XIcon } from "./Icon";
import { ElapsedTime } from "./RecordButton";
import type { ActiveRecording, RecordingFile, TapSpec } from "./types";
import styles from "./RecordingsPanel.module.css";

interface RecordingsPanelProps {
  open: boolean;
  active: ActiveRecording[];
  files: RecordingFile[];
  recordingsDir: string | null;
  onClose: () => void;
  onStopRecording: (id: string) => void;
  onStopAll: () => void;
  onOpenFolder: () => void;
  onSetDir: (path: string) => void;
  onDelete: (path: string) => void;
  onRefresh: () => void;
}

/**
 * Right-side drawer listing active + past recordings.
 *
 *   - Active section: live size/dropped counters, per-row stop button.
 *   - Files section: WAV files on disk, click to open folder or delete.
 *   - Settings: change the recordings directory and bit-depth format.
 *
 * Files are NOT auto-played in-app (no decoder linked) — clicking just
 * opens the OS folder. Cross-platform via tauri-plugin-opener.
 */
export function RecordingsPanel({
  open,
  active,
  files,
  recordingsDir,
  onClose,
  onStopRecording,
  onStopAll,
  onOpenFolder,
  onSetDir,
  onDelete,
  onRefresh,
}: RecordingsPanelProps) {
  const [editingDir, setEditingDir] = useState(false);
  const [dirDraft, setDirDraft] = useState("");
  const [format, setFormat] = useState<RecordFormat>("float32");

  useEffect(() => {
    if (!open) return;
    ipc.getRecorderSettings().then((s) => setFormat(s.format)).catch(() => {});
  }, [open]);

  if (!open) return null;

  function handleFormatChange(f: RecordFormat) {
    setFormat(f);
    ipc.setRecorderFormat(f).catch(() => {});
  }

  return (
    <div className={styles.backdrop} onClick={onClose} role="presentation">
      <aside
        className={styles.drawer}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rec-panel-title"
      >
        <header className={styles.header}>
          <h2 id="rec-panel-title" className={styles.title}>
            <RecordIcon size={16} />
            <span>Recordings</span>
          </h2>
          <div className={styles.headerActions}>
            <button className={styles.refreshBtn} onClick={onRefresh} title="Refresh">
              ↻
            </button>
            <button
              className={styles.closeBtn}
              onClick={onClose}
              aria-label="Close"
            >
              <XIcon size={14} />
            </button>
          </div>
        </header>

        {/* Active recordings */}
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div className={styles.sectionTitle}>
              Active <span className={styles.count}>{active.length}</span>
            </div>
            {active.length > 0 && (
              <button className={styles.stopAllBtn} onClick={onStopAll}>
                Stop all
              </button>
            )}
          </div>
          {active.length === 0 ? (
            <div className={styles.empty}>
              No active recordings. Press a REC button on any input, bus, or
              the top bar to start.
            </div>
          ) : (
            <ul className={styles.activeList}>
              {active.map((r) => (
                <li key={r.id} className={styles.activeRow}>
                  <span className={styles.recDot} aria-hidden />
                  <div className={styles.activeText}>
                    <div className={styles.activeLabel}>{specLabel(r.spec)}</div>
                    <div className={styles.activeMeta}>
                      <span className={styles.metaItem}>
                        <ElapsedTime startedAtMs={r.started_at_unix_ms} />
                      </span>
                      <span className={styles.metaItem}>
                        {formatBytes(r.bytes_written)}
                      </span>
                      <span className={styles.metaItem}>
                        {r.channels}ch · {r.sample_rate / 1000}k ·{" "}
                        {formatLabel(r.format)}
                      </span>
                      {r.dropped_samples > 0 && (
                        <span className={styles.metaWarn}>
                          <AlertIcon size={10} /> {r.dropped_samples} dropped
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    className={styles.stopBtn}
                    onClick={() => onStopRecording(r.id)}
                    title="Stop this recording"
                    aria-label="Stop"
                  >
                    ■
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Settings */}
        <section className={styles.section}>
          <div className={styles.sectionTitle}>Output folder</div>
          {editingDir ? (
            <div className={styles.dirEdit}>
              <input
                type="text"
                value={dirDraft}
                onChange={(e) => setDirDraft(e.target.value)}
                className={styles.dirInput}
                placeholder="C:\\Users\\…\\recordings"
                autoFocus
              />
              <button
                className={styles.dirSave}
                onClick={() => {
                  if (dirDraft.trim()) {
                    onSetDir(dirDraft.trim());
                    setEditingDir(false);
                  }
                }}
              >
                Save
              </button>
              <button
                className={styles.dirCancel}
                onClick={() => setEditingDir(false)}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className={styles.dirRow}>
              <span className={styles.dirPath} title={recordingsDir ?? ""}>
                {recordingsDir ?? "(default app data)"}
              </span>
              <button
                className={styles.dirActionBtn}
                onClick={() => {
                  setDirDraft(recordingsDir ?? "");
                  setEditingDir(true);
                }}
              >
                Change…
              </button>
              <button className={styles.dirActionBtn} onClick={onOpenFolder}>
                Open
              </button>
            </div>
          )}

          <div className={styles.formatRow}>
            <label className={styles.formatLabel} htmlFor="rec-format">
              Format
            </label>
            <select
              id="rec-format"
              className={styles.formatSelect}
              value={format}
              onChange={(e) => handleFormatChange(e.target.value as RecordFormat)}
            >
              <option value="float32">32-bit float WAV</option>
              <option value="int24">24-bit PCM WAV</option>
              <option value="int16">16-bit PCM WAV</option>
            </select>
          </div>
        </section>

        {/* Past recordings */}
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div className={styles.sectionTitle}>
              Files <span className={styles.count}>{files.length}</span>
            </div>
          </div>
          {files.length === 0 ? (
            <div className={styles.empty}>No recordings on disk yet.</div>
          ) : (
            <ul className={styles.fileList}>
              {files.map((f) => (
                <li key={f.file_path} className={styles.fileRow}>
                  <div className={styles.fileText}>
                    <div className={styles.fileName}>{f.name}</div>
                    <div className={styles.fileMeta}>
                      <span>{formatBytes(f.size_bytes)}</span>
                      <span>{formatRelative(f.modified_unix_ms)}</span>
                    </div>
                  </div>
                  <button
                    className={styles.deleteBtn}
                    onClick={() => {
                      const ok = window.confirm(
                        `Delete recording "${f.name}"? This cannot be undone.`,
                      );
                      if (ok) onDelete(f.file_path);
                    }}
                    title="Delete file"
                    aria-label={`Delete ${f.name}`}
                  >
                    <XIcon size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
    </div>
  );
}

function specLabel(spec: TapSpec): string {
  switch (spec.kind) {
    case "input_pre":
      return `Input · ${spec.device_id} (pre)`;
    case "input_post":
      return `Input · ${spec.device_id} → ${spec.bus_id} (post)`;
    case "bus_out":
      return `Bus · ${spec.bus_id}`;
  }
}

function formatLabel(f: RecordFormat): string {
  switch (f) {
    case "float32": return "32f";
    case "int24":   return "24i";
    case "int16":   return "16i";
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatRelative(unixMs: number): string {
  const diff = Date.now() - unixMs;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(unixMs).toLocaleDateString();
}
