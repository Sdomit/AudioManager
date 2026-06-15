import { useEffect, useRef, useState } from "react";
import { XIcon } from "./Icon";
import {
  automixCreateGroup,
  automixDeleteGroup,
  automixListGroups,
  automixSetConfig,
  automixSetMembers,
} from "../../ipc/commands";
import type { AutomixConfig, AutomixGroupDef } from "../../types/engine";
import { suggestPhoneGroups } from "./automixSuggest";
import type { AudioInput } from "./types";
import styles from "./AutomixPanel.module.css";

/** Rolling level-history depth per phone input (~6 s at the 150 ms sample tick). */
const HISTORY_LEN = 40;
const SAMPLE_MS = 150;

interface AutomixPanelProps {
  open: boolean;
  /** Current inputs, used as the member-picker source. `id` is the device id
   *  the backend resolves to engine slots; `name` is the friendly label. */
  inputs: AudioInput[];
  onClose: () => void;
}

/** Tunable slider definitions for the per-group automix params. */
const PARAMS: {
  key: keyof Omit<AutomixConfig, "enabled">;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
}[] = [
  { key: "attack_ms", label: "Attack", min: 1, max: 500, step: 1, unit: "ms" },
  { key: "release_ms", label: "Release", min: 10, max: 2000, step: 10, unit: "ms" },
  { key: "floor_db", label: "Floor", min: -90, max: 0, step: 1, unit: "dB" },
  { key: "noise_floor_db", label: "Gate", min: -90, max: 0, step: 1, unit: "dB" },
];

/**
 * Right-side drawer for the live sound gate (Feature B). Create automix groups
 * of co-located inputs (typically phones); members share gain so the closest
 * mic dominates and duplicate captures of the same voice are suppressed.
 *
 * Self-contained: loads its own group list on open and mutates via the
 * `automix_*` IPC commands. Param edits update locally for responsiveness and
 * are pushed fire-and-forget; the backend re-resolves member device ids to each
 * running engine's input slots.
 */
export function AutomixPanel({ open, inputs, onClose }: AutomixPanelProps) {
  const [groups, setGroups] = useState<AutomixGroupDef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[][]>([]);

  // Latest props/state read by the sampling interval without re-subscribing.
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const historyRef = useRef<Record<string, number[]>>({});

  useEffect(() => {
    if (!open) return;
    automixListGroups()
      .then(setGroups)
      .catch((e) => setError(String(e)));
  }, [open]);

  // Auto-suggest (B3): while open, sample each phone input's live meter level
  // into a rolling history and propose co-located groups by level correlation.
  // Suggestions are non-binding — surfaced as a banner the user confirms.
  useEffect(() => {
    if (!open) {
      historyRef.current = {};
      setSuggestions([]);
      return;
    }
    const tick = () => {
      const phones = inputsRef.current.filter((i) => i.kind === "phone");
      const present = new Set(phones.map((p) => p.id));
      const hist = historyRef.current;
      // Drop history for inputs that went away.
      for (const id of Object.keys(hist)) {
        if (!present.has(id)) delete hist[id];
      }
      for (const p of phones) {
        const series = hist[p.id] ?? [];
        series.push(p.level);
        if (series.length > HISTORY_LEN) series.shift();
        hist[p.id] = series;
      }
      // Only suggest phones not already in a group.
      const grouped = new Set(groupsRef.current.flatMap((g) => g.members));
      const candidates = phones.map((p) => p.id).filter((id) => !grouped.has(id));
      setSuggestions(suggestPhoneGroups(hist, candidates));
    };
    const handle = window.setInterval(tick, SAMPLE_MS);
    return () => window.clearInterval(handle);
  }, [open]);

  if (!open) return null;

  const nameFor = (id: string) => inputs.find((i) => i.id === id)?.name ?? id;

  const acceptSuggestion = (ids: string[]) => {
    const label = `Room (${ids.map(nameFor).join(" + ")})`;
    automixCreateGroup(label.slice(0, 60))
      .then((g) => {
        // Show the new group immediately; the chain below fills in members and
        // enables it, then the final setGroups reconciles with the server list.
        setGroups((prev) => [...prev, g]);
        return automixSetMembers(g.id, ids).then(() =>
          automixSetConfig(g.id, { ...g.config, enabled: true }),
        );
      })
      .then(setGroups)
      .catch((e) => setError(String(e)));
  };

  const run = (p: Promise<AutomixGroupDef[]>) => {
    p.then(setGroups).catch((e) => setError(String(e)));
  };

  const onCreate = () => {
    const name = window.prompt("Name this automix group (e.g. “Table mics”):", "Room");
    if (!name) return;
    automixCreateGroup(name)
      .then((g) => setGroups((prev) => [...prev, g]))
      .catch((e) => setError(String(e)));
  };

  const toggleMember = (group: AutomixGroupDef, deviceId: string) => {
    const members = group.members.includes(deviceId)
      ? group.members.filter((m) => m !== deviceId)
      : [...group.members, deviceId];
    setGroups((prev) =>
      prev.map((g) => (g.id === group.id ? { ...g, members } : g)),
    );
    run(automixSetMembers(group.id, members));
  };

  const patchConfig = (group: AutomixGroupDef, patch: Partial<AutomixConfig>, commit: boolean) => {
    const config = { ...group.config, ...patch };
    setGroups((prev) =>
      prev.map((g) => (g.id === group.id ? { ...g, config } : g)),
    );
    if (commit) {
      automixSetConfig(group.id, config).then(setGroups).catch((e) => setError(String(e)));
    }
  };

  return (
    <div className={styles.backdrop} onClick={onClose} role="presentation">
      <aside
        className={styles.drawer}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="automix-panel-title"
      >
        <header className={styles.header}>
          <h2 id="automix-panel-title" className={styles.title}>
            Live Sound Gate
          </h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <XIcon size={14} />
          </button>
        </header>

        <p className={styles.intro}>
          Group co-located mics (e.g. several phones at one table). Within a group
          their gains are shared so the closest/loudest mic stays open and the
          others are turned down &mdash; killing echo and the same voice bleeding
          into multiple inputs.
        </p>

        {error && <div className={styles.error}>{error}</div>}

        {suggestions.map((ids) => (
          <div key={ids.join("|")} className={styles.suggestion}>
            <span className={styles.suggestionText}>
              These mics seem to be in the same room:{" "}
              <strong>{ids.map(nameFor).join(", ")}</strong>. Group them so only
              the closest one passes audio?
            </span>
            <button className={styles.suggestionBtn} onClick={() => acceptSuggestion(ids)}>
              Group them
            </button>
          </div>
        ))}

        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>
            Groups <span className={styles.count}>{groups.length}</span>
          </div>
          <button className={styles.createBtn} onClick={onCreate}>
            + New group
          </button>
        </div>

        {groups.length === 0 ? (
          <div className={styles.empty}>
            No automix groups yet. Create one, then tick the inputs that share a
            room.
          </div>
        ) : (
          <ul className={styles.groupList}>
            {groups.map((group) => (
              <li key={group.id} className={styles.group}>
                <div className={styles.groupHead}>
                  <label className={styles.enableToggle}>
                    <input
                      type="checkbox"
                      checked={group.config.enabled}
                      onChange={(e) =>
                        patchConfig(group, { enabled: e.target.checked }, true)
                      }
                    />
                    <span className={styles.groupName}>{group.name}</span>
                  </label>
                  <button
                    className={styles.deleteBtn}
                    onClick={() => {
                      if (window.confirm(`Delete automix group "${group.name}"?`)) {
                        run(automixDeleteGroup(group.id));
                      }
                    }}
                    aria-label={`Delete ${group.name}`}
                  >
                    <XIcon size={12} />
                  </button>
                </div>

                <div className={styles.subTitle}>Members</div>
                {inputs.length === 0 ? (
                  <div className={styles.hint}>No inputs available.</div>
                ) : (
                  <div className={styles.members}>
                    {inputs.map((input) => (
                      <label key={input.id} className={styles.memberRow}>
                        <input
                          type="checkbox"
                          checked={group.members.includes(input.id)}
                          onChange={() => toggleMember(group, input.id)}
                        />
                        <span className={styles.memberId} title={input.id}>
                          {input.name}
                        </span>
                      </label>
                    ))}
                  </div>
                )}

                <div className={styles.subTitle}>Tuning</div>
                {PARAMS.map((p) => (
                  <div key={p.key} className={styles.paramRow}>
                    <span className={styles.paramLabel}>{p.label}</span>
                    <input
                      className={styles.slider}
                      type="range"
                      min={p.min}
                      max={p.max}
                      step={p.step}
                      value={group.config[p.key]}
                      onChange={(e) =>
                        patchConfig(group, { [p.key]: Number(e.target.value) }, false)
                      }
                      onPointerUp={(e) =>
                        patchConfig(
                          group,
                          { [p.key]: Number((e.target as HTMLInputElement).value) },
                          true,
                        )
                      }
                      // Keyboard arrow keys fire change/keyup but never
                      // pointerup, so commit here too or the edit never reaches
                      // the backend.
                      onKeyUp={(e) =>
                        patchConfig(
                          group,
                          { [p.key]: Number((e.target as HTMLInputElement).value) },
                          true,
                        )
                      }
                    />
                    <span className={styles.paramValue}>
                      {group.config[p.key]}
                      {p.unit}
                    </span>
                  </div>
                ))}
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}
