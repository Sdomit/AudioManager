import { useEffect, useRef, useState } from "react";
import { XIcon } from "./Icon";
import styles from "./PresetSaveDialog.module.css";

interface PresetSaveDialogProps {
  open: boolean;
  /** Pre-fill the name input (e.g. when renaming an existing preset). */
  initialName?: string;
  /** Existing preset names — used to warn on overwrite. */
  existingNames?: string[];
  title?: string;
  confirmLabel?: string;
  onConfirm: (name: string) => void;
  onClose: () => void;
}

/**
 * Modal name-input dialog for saving or renaming a preset.
 *
 * Save flow:  parent opens with no initialName → user types → Save calls
 *             onConfirm(name) which invokes ipc.savePreset(name).
 * Rename:     parent opens with initialName=oldName → user edits → Save
 *             calls onConfirm(newName) which save+delete in the parent.
 *
 * Esc closes. Empty / whitespace-only names disable Save.
 */
export function PresetSaveDialog({
  open,
  initialName = "",
  existingNames = [],
  title = "Save preset",
  confirmLabel = "Save",
  onConfirm,
  onClose,
}: PresetSaveDialogProps) {
  const [name, setName] = useState(initialName);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setName(initialName);
      // Autofocus + select after the modal mounts.
      const t = window.setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
      return () => window.clearTimeout(t);
    }
  }, [open, initialName]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const trimmed = name.trim();
  const isExisting =
    trimmed.length > 0 &&
    trimmed !== initialName &&
    existingNames.includes(trimmed);
  const canSave = trimmed.length > 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    onConfirm(trimmed);
  };

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="preset-save-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.header}>
          <h2 id="preset-save-title" className={styles.title}>
            {title}
          </h2>
          <button
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Close"
          >
            <XIcon size={14} />
          </button>
        </header>

        <form className={styles.body} onSubmit={handleSubmit}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Name</span>
            <input
              ref={inputRef}
              className={styles.input}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Stream — Twitch"
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          {isExisting && (
            <p className={styles.hint}>
              A preset named “{trimmed}” already exists. Saving will overwrite it.
            </p>
          )}

          <div className={styles.footer}>
            <button
              type="button"
              className={styles.cancelBtn}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={styles.saveBtn}
              disabled={!canSave}
            >
              {confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
