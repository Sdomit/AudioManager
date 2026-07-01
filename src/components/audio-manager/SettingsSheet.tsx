import { useEffect, useState } from "react";

import type { DeviceInfo } from "../../types/engine";
import type { Density } from "./types";
import styles from "./SettingsSheet.module.css";

interface SettingsSheetProps {
  open: boolean;
  onClose: () => void;
  density: Density;
  onDensityChange: (d: Density) => void;
  theme: "dark" | "light";
  onThemeChange: (t: "dark" | "light") => void;
  /** Cached capture devices from AudioManager's device poll (#feature9). */
  inputDevices: DeviceInfo[];
  /** Cached playback devices from AudioManager's device poll. */
  outputDevices: DeviceInfo[];
}

type Tab = "devices" | "cable" | "appearance" | "about";

const TABS: { id: Tab; label: string }[] = [
  { id: "devices", label: "Audio devices" },
  { id: "cable", label: "Virtual cable" },
  { id: "appearance", label: "Appearance" },
  { id: "about", label: "About" },
];

/** Heuristic: names that look like a virtual-audio cable / loopback endpoint. */
const CABLE_RE = /(cable|vb-audio|voicemeeter|audiomanager|virtual)/i;

/**
 * App settings (#feature9). Replaces the previously-inert top-bar gear button
 * with a tabbed sheet: Audio devices, Virtual cable, Appearance, About.
 *
 * v1 is intentionally lean — device selection still happens per bus/input in
 * the mixer; this surface lists what the engine sees (from AudioManager's
 * already-cached device poll, so opening the sheet costs no extra IPC), gathers
 * the virtual-cable status, exposes the density preference, and shows build
 * info. Rendered as a modal overlay (same affordance as the phone pairing sheet).
 */
export function SettingsSheet({
  open,
  onClose,
  density,
  onDensityChange,
  theme,
  onThemeChange,
  inputDevices,
  outputDevices,
}: SettingsSheetProps) {
  const [tab, setTab] = useState<Tab>("devices");

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const cables = [...inputDevices, ...outputDevices].filter((d) =>
    CABLE_RE.test(d.name),
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      className={styles.overlay}
      onMouseDown={onClose}
    >
      <div className={styles.sheet} onMouseDown={(e) => e.stopPropagation()}>
        <header className={styles.header}>
          <strong className={styles.title}>Settings</strong>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className={styles.close}
          >
            ×
          </button>
        </header>

        <nav role="tablist" aria-label="Settings sections" className={styles.tabs}>
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`${styles.tab} ${tab === t.id ? styles.tabActive : ""}`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div role="tabpanel" className={styles.panel}>
          {tab === "devices" && (
            <section>
              <DeviceList
                title={`Inputs (${inputDevices.length})`}
                devices={inputDevices}
              />
              <DeviceList
                title={`Outputs (${outputDevices.length})`}
                devices={outputDevices}
              />
              <p className={`${styles.muted} ${styles.spaced}`}>
                Pick the device for a bus or input directly in the mixer — this
                list shows everything the audio engine can see.
              </p>
            </section>
          )}

          {tab === "cable" && (
            <section>
              <h3 className={styles.sectionTitle}>Virtual audio cable</h3>
              {cables.length > 0 ? (
                <>
                  <p className={styles.subtle}>Detected virtual cable endpoints:</p>
                  <ul className={styles.list}>
                    {cables.map((c) => (
                      <li key={c.id}>{c.name}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className={styles.subtle}>
                  No virtual cable detected. Install one (e.g. the bundled
                  AudioManager Virtual Cable / VB-CABLE) to route a bus into other
                  apps, then assign it to a bus output in the mixer.
                </p>
              )}
            </section>
          )}

          {tab === "appearance" && (
            <section>
              <h3 className={styles.sectionTitle}>Theme</h3>
              <select
                className={styles.select}
                value={theme}
                onChange={(e) => onThemeChange(e.target.value as "dark" | "light")}
                aria-label="Color theme"
              >
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>

              <h3 className={`${styles.sectionTitle} ${styles.spaced}`}>Density</h3>
              <select
                className={styles.select}
                value={density}
                onChange={(e) => onDensityChange(e.target.value as Density)}
                aria-label="Interface density"
              >
                <option value="comfortable">Comfortable</option>
                <option value="compact">Compact</option>
              </select>
              <p className={`${styles.muted} ${styles.spaced}`}>
                The title bar and meters follow the selected theme.
              </p>
            </section>
          )}

          {tab === "about" && (
            <section>
              <h3 className={styles.sectionTitle}>AudioManager</h3>
              <p className={styles.subtle}>
                A flexible audio router and mixer — route mics, system audio, and
                phones through buses with per-input DSP, monitoring, and recording.
              </p>
              <p className={`${styles.muted} ${styles.spaced}`}>
                <a
                  href="https://github.com/Sdomit/AudioManager"
                  target="_blank"
                  rel="noreferrer"
                  className={styles.link}
                >
                  github.com/Sdomit/AudioManager
                </a>
              </p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function DeviceList({ title, devices }: { title: string; devices: DeviceInfo[] }) {
  return (
    <div className={styles.deviceGroup}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      {devices.length === 0 ? (
        <p className={styles.muted}>None found.</p>
      ) : (
        <ul className={styles.deviceList}>
          {devices.map((d) => (
            <li key={d.id}>
              {d.name}
              {d.is_default && <span className={styles.dim}> · default</span>}
              <span className={styles.dimmer}>
                {" "}
                · {d.channels}ch · {Math.round(d.default_sample_rate / 1000)} kHz
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
