import { useEffect, useState } from "react";
import { AlertIcon, RecordIcon, XIcon } from "./Icon";
import { ElapsedTime } from "./RecordButton";
import type { ActiveRecording, RecordingFile, TapSpec } from "./types";
import styles from "./RecordingsPanel.module.css";

interface RecordingsPanelProps {
  open: boolean;
  active: ActiveRecording[];
  files: RecordingFile[];
  recordingsDir: string | null;
  /** Surfaced recording-action error to display inline as a dismissible banner. */
  errorMessage: string | null;
  onDismissError: () => void;
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
 *   - Settings: change the recordings directory.
 *
 * Files are NOT auto-played in-app (no decoder linked) — clicking just
 * opens the OS folder. Cross-platform via tauri-plugin-opener.
 */
export function RecordingsPanel({
  open,
  active,
  files,
  recordingsDir,
  errorMessage,
  onDismissError,
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

  // Auto-refresh file list every 5 s while the panel is open so a file
  // dropped to disk by an external process (or a recording that just
  // stopped) shows up without the user clicking Refresh manually.
  // Backend list_recording_files is a cheap fs read; 5 s is well under
  // any meter-rate cost.
  useEffect(() => {
    if (!open) return;
    const interval = window.setInterval(onRefresh, 5000);
    return () => window.clearInterval(interval);
  }, [open, onRefresh]);

  if (!open) return null;

  return (
    <div className={styles.backdrop} onClick={onClose} role="presentation">
      <aside
        className={styles.drawer}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rec-panel-title"
      >
        {errorMessage && (
          <div className={styles.errorBanner} role="alert">
            <AlertIcon size={14} />
            <span className={styles.errorBannerMsg}>{errorMessage}</span>
            <button
              type="button"
              className={styles.errorBannerClose}
              onClick={onDismissError}
              aria-label="Dismiss"
            >
              <XIcon size={12} />
            </button>
          </div>
        )}
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
                        {r.channels}ch · {r.sample_rate / 1000}k
                      </span>
                      {r.dropped_samples > 0 && (
                        <span className={styles.metaWarn}>
                          <AlertIcon size={10} /> {r.dropped_samples} dropped
                        </span>
                      )}
                    </div>
                    {r.error && (
                      <div className={styles.activeError} role="alert">
                        <AlertIcon size={10} /> {r.error}
                      </div>
                    )}
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
