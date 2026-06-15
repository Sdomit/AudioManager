import { useMemo, useState } from "react";
import { InputRow } from "./InputRow";
import { PlusIcon, SearchIcon } from "./Icon";
import type { AudioInput, DetailSelection } from "./types";
import styles from "./InputList.module.css";

interface InputListProps {
  inputs: AudioInput[];
  selection: DetailSelection;
  onSelectInput: (id: string) => void;
  onMuteInput: (id: string) => void;
  onMonitorInput: (id: string) => void;
  onInputGainChange: (id: string, v: number) => void;
  onAddInput: () => void;
}

/**
 * Left column: scrollable list of inputs with a search/filter at the top
 * and an "Add input" button at the bottom.
 */
export function InputList({
  inputs,
  selection,
  onSelectInput,
  onMuteInput,
  onMonitorInput,
  onInputGainChange,
  onAddInput,
}: InputListProps) {
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return inputs;
    return inputs.filter(
      (i) => i.name.toLowerCase().includes(q) || i.device.toLowerCase().includes(q),
    );
  }, [filter, inputs]);

  const empty = inputs.length === 0;

  return (
    <section className={styles.list} aria-label="Inputs">
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h2 className={styles.title}>Inputs</h2>
          <span className={styles.count}>{inputs.length}</span>
        </div>
        <div className={styles.searchBox}>
          <SearchIcon size={14} />
          <input
            type="text"
            placeholder="Search inputs…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className={styles.searchInput}
            aria-label="Filter inputs"
          />
        </div>
      </header>

      <div className={styles.rows} role="listbox" aria-label="Audio inputs">
        {empty ? (
          <EmptyState onAddInput={onAddInput} />
        ) : filtered.length === 0 ? (
          <div className={styles.noResults}>
            No inputs match "{filter}".
          </div>
        ) : (
          filtered.map((input) => (
            <InputRow
              key={input.id}
              input={input}
              selected={selection.kind === "input" && selection.inputId === input.id}
              onSelect={() => onSelectInput(input.id)}
              onToggleMute={() => onMuteInput(input.id)}
              onToggleMonitor={() => onMonitorInput(input.id)}
              onGainChange={(v) => onInputGainChange(input.id, v)}
            />
          ))
        )}
      </div>

      <footer className={styles.footer}>
        <button className={styles.addBtn} onClick={onAddInput}>
          <PlusIcon size={14} />
          <span>Add input</span>
        </button>
      </footer>
    </section>
  );
}

function EmptyState({ onAddInput }: { onAddInput: () => void }) {
  return (
    <div className={styles.empty}>
      <div className={styles.emptyArt} aria-hidden>
        <svg viewBox="0 0 64 64" width="64" height="64">
          <rect x="20" y="6" width="24" height="36" rx="12" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M12 32a20 20 0 0 0 40 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M32 52v8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </div>
      <h3 className={styles.emptyTitle}>No inputs yet</h3>
      <p className={styles.emptyHint}>
        Add your first input — a mic, an app, or a system source — to start routing audio.
      </p>
      <button className={styles.emptyAction} onClick={onAddInput}>
        <PlusIcon size={14} />
        <span>Add your first input</span>
      </button>
    </div>
  );
}
