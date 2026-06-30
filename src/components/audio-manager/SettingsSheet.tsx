import { useEffect, useRef, useState } from "react";

import type {
  DeviceInfo,
  PhonePairedDevice,
  PhoneServerStatus,
  RecordFormat,
  RecorderSettings,
} from "../../types/engine";
import {
  getAutostart,
  getRecorderSettings,
  openRecordingsFolder,
  phoneForget,
  phoneListPaired,
  phoneServerStatus,
  setAutostart,
  setRecorderFormat,
} from "../../ipc/commands";
import { HOTKEY_GROUPS } from "./HotkeyOverlay";
import { ACCENT_SWATCHES, type AppPrefs } from "./prefs";
import type { Density } from "./types";
import styles from "./SettingsSheet.module.css";

interface SettingsSheetProps {
  open: boolean;
  onClose: () => void;
  density: Density;
  onDensityChange: (d: Density) => void;
  prefs: AppPrefs;
  onPrefsChange: (p: AppPrefs) => void;
  /** Open the existing phone-pairing sheet (QR + accept flow). */
  onOpenPhonePairing: () => void;
  /** Cached capture devices from AudioManager's device poll (#feature9). */
  inputDevices: DeviceInfo[];
  /** Cached playback devices from AudioManager's device poll. */
  outputDevices: DeviceInfo[];
}

type Tab =
  | "devices"
  | "recording"
  | "appearance"
  | "hotkeys"
  | "connectivity"
  | "general"
  | "about";

const TABS: { id: Tab; label: string }[] = [
  { id: "devices", label: "Devices" },
  { id: "recording", label: "Recording" },
  { id: "appearance", label: "Appearance" },
  { id: "hotkeys", label: "Hotkeys" },
  { id: "connectivity", label: "Connectivity" },
  { id: "general", label: "General" },
  { id: "about", label: "About" },
];

/** Heuristic: names that look like a virtual-audio cable / loopback endpoint. */
const CABLE_RE = /(cable|vb-audio|voicemeeter|audiomanager|virtual)/i;

/** localStorage keys that hold the node-graph layout — wiped by "Reset layout". */
const LAYOUT_KEYS = [
  "am.nodePositions.v2",
  "am.nodePositions.inputs",
  "am.nodePositions.buses",
  "am.nodeView.viewport",
  "am.nodeGroups.v1",
  "am.floatingFx.v1",
  "am.nodeLocalEdges.v1",
];

/**
 * App settings. Tabbed modal: Devices, Recording, Appearance, Hotkeys,
 * Connectivity (virtual cable + phone remote), General (startup + data),
 * and About. Reuses AudioManager's cached device poll so opening costs no
 * extra IPC; per-tab data (recorder settings, phone status, autostart) is
 * lazy-loaded the first time its tab is shown.
 */
export function SettingsSheet({
  open,
  onClose,
  density,
  onDensityChange,
  prefs,
  onPrefsChange,
  onOpenPhonePairing,
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
            <DevicesTab inputDevices={inputDevices} outputDevices={outputDevices} />
          )}
          {tab === "recording" && <RecordingTab open={open} />}
          {tab === "appearance" && (
            <AppearanceTab
              density={density}
              onDensityChange={onDensityChange}
              prefs={prefs}
              onPrefsChange={onPrefsChange}
            />
          )}
          {tab === "hotkeys" && <HotkeysTab />}
          {tab === "connectivity" && (
            <ConnectivityTab cables={cables} onOpenPhonePairing={onOpenPhonePairing} />
          )}
          {tab === "general" && <GeneralTab />}
          {tab === "about" && <AboutTab />}
        </div>
      </div>
    </div>
  );
}

function DevicesTab({
  inputDevices,
  outputDevices,
}: {
  inputDevices: DeviceInfo[];
  outputDevices: DeviceInfo[];
}) {
  const defIn = inputDevices.find((d) => d.is_default);
  const defOut = outputDevices.find((d) => d.is_default);
  return (
    <section>
      <DeviceList title={`Inputs (${inputDevices.length})`} devices={inputDevices} />
      <DeviceList title={`Outputs (${outputDevices.length})`} devices={outputDevices} />
      <h3 className={styles.sectionTitle}>Engine</h3>
      <ul className={styles.list}>
        <li>
          Default input:{" "}
          {defIn ? `${defIn.name} · ${Math.round(defIn.default_sample_rate / 1000)} kHz` : "—"}
        </li>
        <li>
          Default output:{" "}
          {defOut ? `${defOut.name} · ${Math.round(defOut.default_sample_rate / 1000)} kHz` : "—"}
        </li>
      </ul>
      <p className={`${styles.muted} ${styles.spaced}`}>
        Pick the device for a bus or input directly in the mixer — this list
        shows everything the audio engine can see. Per-bus buffer size lives on
        each bus in the mixer.
      </p>
    </section>
  );
}

function RecordingTab({ open }: { open: boolean }) {
  const [settings, setSettings] = useState<RecorderSettings | null>(null);

  useEffect(() => {
    if (!open) return;
    getRecorderSettings()
      .then(setSettings)
      .catch(() => {});
  }, [open]);

  const onFormat = (format: RecordFormat) => {
    setSettings((s) => (s ? { ...s, format } : s));
    setRecorderFormat(format).catch(() => {});
  };

  return (
    <section>
      <h3 className={styles.sectionTitle}>Format</h3>
      <div className={styles.densityRow}>
        {(["float32", "int24", "int16"] as RecordFormat[]).map((f) => (
          <button
            key={f}
            onClick={() => onFormat(f)}
            aria-pressed={settings?.format === f}
            className={`${styles.densityBtn} ${
              settings?.format === f ? styles.densityBtnActive : ""
            }`}
          >
            {formatLabel(f)}
          </button>
        ))}
      </div>

      <h3 className={`${styles.sectionTitle} ${styles.spaced}`}>Recordings folder</h3>
      <p className={styles.subtle}>{settings?.recordings_dir ?? "…"}</p>
      <button
        className={styles.actionBtn}
        onClick={() => void openRecordingsFolder()}
      >
        Open folder
      </button>
      <p className={`${styles.muted} ${styles.spaced}`}>
        New recordings are written here as WAV in the selected bit depth. 32-bit
        float is loss-free for editing; 16-bit PCM is smallest.
      </p>
    </section>
  );
}

function AppearanceTab({
  density,
  onDensityChange,
  prefs,
  onPrefsChange,
}: {
  density: Density;
  onDensityChange: (d: Density) => void;
  prefs: AppPrefs;
  onPrefsChange: (p: AppPrefs) => void;
}) {
  return (
    <section>
      <h3 className={styles.sectionTitle}>Density</h3>
      <div className={styles.densityRow}>
        {(["comfortable", "compact"] as Density[]).map((d) => (
          <button
            key={d}
            onClick={() => onDensityChange(d)}
            aria-pressed={density === d}
            className={`${styles.densityBtn} ${
              density === d ? styles.densityBtnActive : ""
            }`}
          >
            {d}
          </button>
        ))}
      </div>

      <h3 className={`${styles.sectionTitle} ${styles.spaced}`}>Accent color</h3>
      <div className={styles.swatchRow}>
        {ACCENT_SWATCHES.map((sw) => {
          const active = prefs.accent === sw.value;
          return (
            <button
              key={sw.value || "default"}
              title={sw.label}
              aria-label={sw.label}
              aria-pressed={active}
              onClick={() => onPrefsChange({ ...prefs, accent: sw.value })}
              className={`${styles.swatch} ${active ? styles.swatchActive : ""}`}
              style={{ background: sw.value || "var(--am-accent, #EF4444)" }}
            />
          );
        })}
      </div>

      <h3 className={`${styles.sectionTitle} ${styles.spaced}`}>Motion</h3>
      <label className={styles.toggleRow}>
        <input
          type="checkbox"
          checked={prefs.reduceMotion}
          onChange={(e) =>
            onPrefsChange({ ...prefs, reduceMotion: e.target.checked })
          }
        />
        Reduce motion (disable panel animations)
      </label>
      <p className={`${styles.muted} ${styles.spaced}`}>
        Meter colors follow the accent. Real-time meters keep animating — they
        convey live data.
      </p>
    </section>
  );
}

function HotkeysTab() {
  return (
    <section>
      {HOTKEY_GROUPS.map((group) => (
        <div key={group.title} className={styles.deviceGroup}>
          <h3 className={styles.sectionTitle}>{group.title}</h3>
          <dl className={styles.hotkeyList}>
            {group.entries.map((entry) => (
              <div key={entry.description} className={styles.hotkeyRow}>
                <dt className={styles.hotkeyKeys}>
                  {entry.keys.map((k, i) => (
                    <kbd key={`${k}-${i}`} className={styles.kbd}>
                      {k}
                    </kbd>
                  ))}
                </dt>
                <dd className={styles.hotkeyDesc}>{entry.description}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      <p className={styles.muted}>Shortcuts pause while a text field is focused.</p>
    </section>
  );
}

function ConnectivityTab({
  cables,
  onOpenPhonePairing,
}: {
  cables: DeviceInfo[];
  onOpenPhonePairing: () => void;
}) {
  const [phone, setPhone] = useState<PhoneServerStatus | null>(null);
  const [paired, setPaired] = useState<PhonePairedDevice[]>([]);

  const reload = () => {
    phoneServerStatus().then(setPhone).catch(() => {});
    phoneListPaired().then(setPaired).catch(() => {});
  };

  useEffect(reload, []);

  return (
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
          No virtual cable detected. Install one (e.g. the bundled AudioManager
          Virtual Cable / VB-CABLE) to route a bus into other apps, then assign
          it to a bus output in the mixer.
        </p>
      )}

      <h3 className={`${styles.sectionTitle} ${styles.spaced}`}>Phone remote</h3>
      <ul className={styles.list}>
        <li>
          Server: {phone?.running ? `running on port ${phone.port ?? "?"}` : "stopped"}
          {phone?.running && !phone.reachable && (
            <span className={styles.error}> · port may be firewalled</span>
          )}
        </li>
        {phone?.running && phone.lanIps.length > 0 && (
          <li className={styles.dim}>LAN: {phone.lanIps.join(", ")}</li>
        )}
      </ul>
      {paired.length > 0 && (
        <>
          <p className={styles.subtle}>Paired devices:</p>
          <ul className={styles.list}>
            {paired.map((d) => (
              <li key={d.id} className={styles.pairedRow}>
                <span>
                  {d.label}
                  {d.clientOs && <span className={styles.dim}> · {d.clientOs}</span>}
                </span>
                <button
                  className={styles.linkBtn}
                  onClick={() => phoneForget(d.id).then(reload).catch(() => {})}
                >
                  Forget
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <button className={styles.actionBtn} onClick={onOpenPhonePairing}>
        Pair a device…
      </button>
    </section>
  );
}

function GeneralTab() {
  const [autostart, setAutostartState] = useState<boolean | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getAutostart()
      .then(setAutostartState)
      .catch(() => setAutostartState(null));
  }, []);

  const toggleAutostart = (enabled: boolean) => {
    setAutostartState(enabled);
    setAutostart(enabled).catch(() => {
      // Revert on failure.
      getAutostart().then(setAutostartState).catch(() => setAutostartState(null));
    });
  };

  const resetLayout = () => {
    if (!confirm("Reset the node-graph layout? Positions, groups, and floating effects are cleared. Routing is unaffected.")) {
      return;
    }
    for (const k of LAYOUT_KEYS) localStorage.removeItem(k);
    window.location.reload();
  };

  const exportSettings = () => {
    const dump: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith("am.") || k.startsWith("am-"))) {
        dump[k] = localStorage.getItem(k) ?? "";
      }
    }
    const blob = new Blob([JSON.stringify(dump, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "audiomanager-settings.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const importSettings = (file: File) => {
    file
      .text()
      .then((txt) => {
        const data = JSON.parse(txt) as Record<string, string>;
        for (const [k, v] of Object.entries(data)) {
          if (k.startsWith("am.") || k.startsWith("am-")) localStorage.setItem(k, v);
        }
        window.location.reload();
      })
      .catch(() => alert("Could not read that settings file."));
  };

  return (
    <section>
      <h3 className={styles.sectionTitle}>Startup</h3>
      <label className={styles.toggleRow}>
        <input
          type="checkbox"
          checked={autostart === true}
          disabled={autostart === null}
          onChange={(e) => toggleAutostart(e.target.checked)}
        />
        Launch AudioManager when I sign in
      </label>
      {autostart === null && (
        <p className={styles.muted}>Autostart is unavailable on this platform.</p>
      )}

      <h3 className={`${styles.sectionTitle} ${styles.spaced}`}>Data</h3>
      <div className={styles.btnRow}>
        <button className={styles.actionBtn} onClick={exportSettings}>
          Export settings
        </button>
        <button className={styles.actionBtn} onClick={() => fileRef.current?.click()}>
          Import settings
        </button>
        <button className={styles.dangerBtn} onClick={resetLayout}>
          Reset layout
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) importSettings(f);
          e.target.value = "";
        }}
      />
      <p className={`${styles.muted} ${styles.spaced}`}>
        Export bundles your layout, presets list, and preferences as JSON.
        Importing overwrites matching keys and reloads.
      </p>
    </section>
  );
}

function AboutTab() {
  return (
    <section>
      <h3 className={styles.sectionTitle}>AudioManager</h3>
      <p className={styles.subtle}>
        A flexible audio router and mixer — route mics, system audio, and phones
        through buses with per-input DSP, monitoring, and recording.
      </p>
      <p className={`${styles.muted} ${styles.spaced}`}>
        Advanced metering (RMS / LUFS ballistics) and global engine sample-rate /
        buffer control are on the roadmap.
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

function formatLabel(f: RecordFormat): string {
  switch (f) {
    case "float32":
      return "32-bit float";
    case "int24":
      return "24-bit PCM";
    case "int16":
      return "16-bit PCM";
  }
}
