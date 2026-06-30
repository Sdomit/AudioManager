import { useEffect, useRef, useState, type ReactNode } from "react";

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
import {
  AppIcon,
  ChainIcon,
  CheckIcon,
  GridIcon,
  InfoIcon,
  RecordIcon,
  SettingsIcon,
  SpeakerIcon,
  XIcon,
  type IconProps,
} from "./Icon";
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

const TABS: { id: Tab; label: string; icon: (p: IconProps) => ReactNode }[] = [
  { id: "devices", label: "Devices", icon: SpeakerIcon },
  { id: "recording", label: "Recording", icon: RecordIcon },
  { id: "appearance", label: "Appearance", icon: AppIcon },
  { id: "hotkeys", label: "Hotkeys", icon: GridIcon },
  { id: "connectivity", label: "Connectivity", icon: ChainIcon },
  { id: "general", label: "General", icon: SettingsIcon },
  { id: "about", label: "About", icon: InfoIcon },
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
 * App settings. Sidebar-nav modal: Devices, Recording, Appearance, Hotkeys,
 * Connectivity (virtual cable + phone remote), General (startup + data), and
 * About. Reuses AudioManager's cached device poll so opening costs no extra
 * IPC; per-tab data (recorder settings, phone status, autostart) is lazy-loaded
 * the first time its tab is shown.
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
          <SettingsIcon size={15} />
          <strong className={styles.title}>Settings</strong>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className={styles.close}
          >
            <XIcon size={15} />
          </button>
        </header>

        <div className={styles.body}>
          <nav role="tablist" aria-label="Settings sections" className={styles.sidebar}>
            {TABS.map((t) => {
              const TabIcon = t.icon;
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTab(t.id)}
                  className={`${styles.navItem} ${active ? styles.navItemActive : ""}`}
                >
                  <span className={styles.navIcon}>
                    <TabIcon size={15} />
                  </span>
                  {t.label}
                </button>
              );
            })}
          </nav>

          <div role="tabpanel" className={styles.content}>
            {tab === "devices" && (
              <DevicesTab inputDevices={inputDevices} outputDevices={outputDevices} />
            )}
            {tab === "recording" && <RecordingTab />}
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
    </div>
  );
}

/* ── Shared building blocks ─────────────────────────────────────────────── */

function Card({
  title,
  desc,
  children,
}: {
  title?: string;
  desc?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className={styles.card}>
      {title && <h3 className={styles.cardTitle}>{title}</h3>}
      {children}
      {desc && <p className={styles.cardDesc}>{desc}</p>}
    </section>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T | undefined;
  onChange: (v: T) => void;
}) {
  return (
    <div className={styles.segmented} role="group">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={`${styles.segItem} ${value === o.value ? styles.segItemActive : ""}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Switch({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
}) {
  return (
    <label className={`${styles.switchRow} ${disabled ? styles.switchDisabled : ""}`}>
      <input
        type="checkbox"
        className={styles.switchInput}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={styles.switchTrack} aria-hidden="true">
        <span className={styles.switchKnob} />
      </span>
      <span>{label}</span>
    </label>
  );
}

/* ── Tabs ───────────────────────────────────────────────────────────────── */

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
    <>
      <Card title={`Inputs (${inputDevices.length})`}>
        <DeviceList devices={inputDevices} />
      </Card>
      <Card title={`Outputs (${outputDevices.length})`}>
        <DeviceList devices={outputDevices} />
      </Card>
      <Card
        title="Engine"
        desc="Pick the device for a bus or input directly in the mixer — this list shows everything the engine sees. Per-bus buffer size lives on each bus."
      >
        <ul className={styles.kvList}>
          <li>
            <span className={styles.kvKey}>Default input</span>
            <span>
              {defIn
                ? `${defIn.name} · ${Math.round(defIn.default_sample_rate / 1000)} kHz`
                : "—"}
            </span>
          </li>
          <li>
            <span className={styles.kvKey}>Default output</span>
            <span>
              {defOut
                ? `${defOut.name} · ${Math.round(defOut.default_sample_rate / 1000)} kHz`
                : "—"}
            </span>
          </li>
        </ul>
      </Card>
    </>
  );
}

function RecordingTab() {
  const [settings, setSettings] = useState<RecorderSettings | null>(null);

  useEffect(() => {
    getRecorderSettings()
      .then(setSettings)
      .catch(() => {});
  }, []);

  const onFormat = (format: RecordFormat) => {
    setSettings((s) => (s ? { ...s, format } : s));
    setRecorderFormat(format).catch(() => {});
  };

  return (
    <>
      <Card
        title="Format"
        desc="WAV bit depth. 32-bit float is loss-free for editing; 16-bit PCM is smallest."
      >
        <Segmented
          value={settings?.format}
          onChange={onFormat}
          options={[
            { value: "float32", label: "32-bit float" },
            { value: "int24", label: "24-bit PCM" },
            { value: "int16", label: "16-bit PCM" },
          ]}
        />
      </Card>
      <Card title="Recordings folder">
        <p className={styles.path}>{settings?.recordings_dir ?? "…"}</p>
        <button className={styles.actionBtn} onClick={() => void openRecordingsFolder()}>
          Open folder
        </button>
      </Card>
    </>
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
    <>
      <Card title="Density">
        <Segmented
          value={density}
          onChange={onDensityChange}
          options={[
            { value: "comfortable", label: "Comfortable" },
            { value: "compact", label: "Compact" },
          ]}
        />
      </Card>

      <Card title="Accent color" desc="Recolors buttons, meters, and highlights.">
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
              >
                {active && <CheckIcon size={14} />}
              </button>
            );
          })}
        </div>
      </Card>

      <Card
        title="Motion"
        desc="Real-time meters keep animating regardless — they convey live data."
      >
        <Switch
          checked={prefs.reduceMotion}
          onChange={(reduceMotion) => onPrefsChange({ ...prefs, reduceMotion })}
          label="Reduce motion (disable panel animations)"
        />
      </Card>
    </>
  );
}

function HotkeysTab() {
  return (
    <>
      {HOTKEY_GROUPS.map((group) => (
        <Card key={group.title} title={group.title}>
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
        </Card>
      ))}
      <p className={styles.footnote}>Shortcuts pause while a text field is focused.</p>
    </>
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
    <>
      <Card title="Virtual audio cable">
        {cables.length > 0 ? (
          <ul className={styles.list}>
            {cables.map((c) => (
              <li key={c.id}>{c.name}</li>
            ))}
          </ul>
        ) : (
          <p className={styles.cardDesc}>
            No virtual cable detected. Install one (e.g. the bundled AudioManager
            Virtual Cable / VB-CABLE) to route a bus into other apps, then assign
            it to a bus output in the mixer.
          </p>
        )}
      </Card>

      <Card title="Phone remote">
        <ul className={styles.kvList}>
          <li>
            <span className={styles.kvKey}>Server</span>
            <span>
              {phone?.running ? `running · port ${phone.port ?? "?"}` : "stopped"}
              {phone?.running && !phone.reachable && (
                <span className={styles.error}> · port may be firewalled</span>
              )}
            </span>
          </li>
          {phone?.running && phone.lanIps.length > 0 && (
            <li>
              <span className={styles.kvKey}>LAN</span>
              <span>{phone.lanIps.join(", ")}</span>
            </li>
          )}
        </ul>
        {paired.length > 0 && (
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
        )}
        <button className={styles.actionBtn} onClick={onOpenPhonePairing}>
          Pair a device…
        </button>
      </Card>
    </>
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
      getAutostart().then(setAutostartState).catch(() => setAutostartState(null));
    });
  };

  const resetLayout = () => {
    if (
      !confirm(
        "Reset the node-graph layout? Positions, groups, and floating effects are cleared. Routing is unaffected.",
      )
    ) {
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
    <>
      <Card
        title="Startup"
        desc={
          autostart === null ? "Autostart is unavailable on this platform." : undefined
        }
      >
        <Switch
          checked={autostart === true}
          disabled={autostart === null}
          onChange={toggleAutostart}
          label="Launch AudioManager when I sign in"
        />
      </Card>

      <Card
        title="Data"
        desc="Export bundles your layout, presets list, and preferences as JSON. Importing overwrites matching keys and reloads."
      >
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
      </Card>
    </>
  );
}

function AboutTab() {
  return (
    <Card title="AudioManager">
      <p className={styles.subtle}>
        A flexible audio router and mixer — route mics, system audio, and phones
        through buses with per-input DSP, monitoring, and recording.
      </p>
      <p className={styles.cardDesc}>
        Advanced metering (RMS / LUFS ballistics) and global engine sample-rate /
        buffer control are on the roadmap.
      </p>
      <p className={styles.spaced}>
        <a
          href="https://github.com/Sdomit/AudioManager"
          target="_blank"
          rel="noreferrer"
          className={styles.link}
        >
          github.com/Sdomit/AudioManager
        </a>
      </p>
    </Card>
  );
}

function DeviceList({ devices }: { devices: DeviceInfo[] }) {
  if (devices.length === 0) return <p className={styles.cardDesc}>None found.</p>;
  return (
    <ul className={styles.deviceList}>
      {devices.map((d) => (
        <li key={d.id}>
          <span className={styles.deviceName}>{d.name}</span>
          {d.is_default && <span className={styles.badge}>default</span>}
          <span className={styles.deviceMeta}>
            {d.channels}ch · {Math.round(d.default_sample_rate / 1000)} kHz
          </span>
        </li>
      ))}
    </ul>
  );
}
