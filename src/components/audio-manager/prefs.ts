/**
 * Frontend-only app preferences (#settings-expand). Persisted to localStorage,
 * applied to the `.audioManager` root element. The audio engine never sees
 * these — they are pure presentation (accent color, motion). Density lives in
 * engine state and is handled separately.
 */

const LS_PREFS = "am.appPrefs.v1";

export interface AppPrefs {
  /** Accent hex (e.g. "#3B82F6"), or "" to keep the default token red. */
  accent: string;
  /** Force the reduced-motion kill switch on regardless of the OS setting. */
  reduceMotion: boolean;
}

export const DEFAULT_PREFS: AppPrefs = { accent: "", reduceMotion: false };

/** Accent swatches offered in Appearance. First entry ("") = default token. */
export const ACCENT_SWATCHES: { value: string; label: string }[] = [
  { value: "", label: "Default" },
  { value: "#F59E0B", label: "Amber" },
  { value: "#22C55E", label: "Green" },
  { value: "#3B82F6", label: "Blue" },
  { value: "#8B5CF6", label: "Violet" },
  { value: "#EC4899", label: "Pink" },
];

export function loadPrefs(): AppPrefs {
  try {
    const raw = localStorage.getItem(LS_PREFS);
    if (!raw) return { ...DEFAULT_PREFS };
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<AppPrefs>) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(p: AppPrefs): void {
  try {
    localStorage.setItem(LS_PREFS, JSON.stringify(p));
  } catch {
    /* ignore quota / private-mode failures */
  }
}

/**
 * Apply prefs to the root element. Accent overrides the five `--am-accent*`
 * tokens for every descendant via inline custom properties (derivatives are
 * computed with color-mix so one pick recolors the whole shell). reduceMotion
 * toggles a data attribute that base.css uses as a manual motion kill switch.
 */
export function applyPrefs(root: HTMLElement, p: AppPrefs): void {
  const s = root.style;
  if (p.accent) {
    s.setProperty("--am-accent", p.accent);
    s.setProperty("--am-accent-hover", `color-mix(in srgb, ${p.accent} 70%, white)`);
    s.setProperty("--am-accent-active", `color-mix(in srgb, ${p.accent} 80%, black)`);
    s.setProperty("--am-accent-muted", `color-mix(in srgb, ${p.accent} 16%, transparent)`);
    s.setProperty("--am-accent-ring", `color-mix(in srgb, ${p.accent} 40%, transparent)`);
  } else {
    for (const v of [
      "--am-accent",
      "--am-accent-hover",
      "--am-accent-active",
      "--am-accent-muted",
      "--am-accent-ring",
    ]) {
      s.removeProperty(v);
    }
  }
  root.dataset.reduceMotion = p.reduceMotion ? "true" : "false";
}
