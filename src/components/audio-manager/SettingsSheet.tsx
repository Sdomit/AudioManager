import { useEffect, useState } from "react";

import * as ipc from "../../ipc/commands";
import type { DeviceInfo } from "../../types/engine";
import type { Density } from "./types";

interface SettingsSheetProps {
  open: boolean;
  onClose: () => void;
  density: Density;
  onDensityChange: (d: Density) => void;
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
 * the mixer; this surface lists what the engine sees, gathers the virtual-cable
 * status, exposes the density preference, and shows build info. Rendered as a
 * modal overlay (same affordance as the phone pairing sheet).
 */
export function SettingsSheet({
  open,
  onClose,
  density,
  onDensityChange,
}: SettingsSheetProps) {
  const [tab, setTab] = useState<Tab>("devices");
  const [inputs, setInputs] = useState<DeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<DeviceInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Refresh device lists whenever the sheet opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([ipc.listInputDevices(), ipc.listOutputDevices()])
      .then(([ins, outs]) => {
        if (cancelled) return;
        setInputs(ins);
        setOutputs(outs);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  const cables = [...inputs, ...outputs].filter((d) => CABLE_RE.test(d.name));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.45)",
      }}
      onMouseDown={onClose}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: "min(560px, 92vw)",
          maxHeight: "82vh",
          overflow: "auto",
          background: "var(--am-surface, #1b1d23)",
          color: "var(--am-text, #e8e8ea)",
          border: "1px solid var(--am-border, rgba(255,255,255,0.12))",
          borderRadius: 12,
          boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 18px",
            borderBottom: "1px solid var(--am-border, rgba(255,255,255,0.1))",
          }}
        >
          <strong style={{ fontSize: 15 }}>Settings</strong>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            style={{
              background: "none",
              border: "none",
              color: "inherit",
              fontSize: 20,
              cursor: "pointer",
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </header>

        <nav
          role="tablist"
          aria-label="Settings sections"
          style={{
            display: "flex",
            gap: 4,
            padding: "10px 14px 0",
            flexWrap: "wrap",
          }}
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              style={{
                padding: "6px 12px",
                borderRadius: 8,
                border: "1px solid transparent",
                background:
                  tab === t.id
                    ? "var(--am-accent, #4f8cff)"
                    : "var(--am-surface-2, rgba(255,255,255,0.06))",
                color: tab === t.id ? "#000" : "inherit",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div role="tabpanel" style={{ padding: 18, fontSize: 13, lineHeight: 1.5 }}>
          {tab === "devices" && (
            <section>
              {loading && <p>Loading devices…</p>}
              {error && (
                <p style={{ color: "var(--am-meter-clip, #ef4444)" }}>
                  Could not list devices: {error}
                </p>
              )}
              {!loading && !error && (
                <>
                  <DeviceList title={`Inputs (${inputs.length})`} devices={inputs} />
                  <DeviceList title={`Outputs (${outputs.length})`} devices={outputs} />
                  <p style={{ opacity: 0.6, marginTop: 12 }}>
                    Pick the device for a bus or input directly in the mixer —
                    this list shows everything the audio engine can see.
                  </p>
                </>
              )}
            </section>
          )}

          {tab === "cable" && (
            <section>
              <h3 style={{ margin: "0 0 8px", fontSize: 13 }}>Virtual audio cable</h3>
              {cables.length > 0 ? (
                <>
                  <p style={{ opacity: 0.8 }}>Detected virtual cable endpoints:</p>
                  <ul style={{ margin: "6px 0", paddingLeft: 18 }}>
                    {cables.map((c) => (
                      <li key={c.id}>{c.name}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <p style={{ opacity: 0.8 }}>
                  No virtual cable detected. Install one (e.g. the bundled
                  AudioManager Virtual Cable / VB-CABLE) to route a bus into other
                  apps, then assign it to a bus output in the mixer.
                </p>
              )}
            </section>
          )}

          {tab === "appearance" && (
            <section>
              <h3 style={{ margin: "0 0 8px", fontSize: 13 }}>Density</h3>
              <div style={{ display: "flex", gap: 8 }}>
                {(["comfortable", "compact"] as Density[]).map((d) => (
                  <button
                    key={d}
                    onClick={() => onDensityChange(d)}
                    aria-pressed={density === d}
                    style={{
                      padding: "6px 14px",
                      borderRadius: 8,
                      border: `1px solid ${density === d ? "var(--am-accent, #4f8cff)" : "var(--am-border, rgba(255,255,255,0.14))"}`,
                      background:
                        density === d
                          ? "var(--am-accent, #4f8cff)"
                          : "var(--am-surface-2, rgba(255,255,255,0.06))",
                      color: density === d ? "#000" : "inherit",
                      cursor: "pointer",
                      textTransform: "capitalize",
                    }}
                  >
                    {d}
                  </button>
                ))}
              </div>
              <p style={{ opacity: 0.6, marginTop: 12 }}>
                Meter colors and theme follow the app's CSS variables.
              </p>
            </section>
          )}

          {tab === "about" && (
            <section>
              <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>AudioManager</h3>
              <p style={{ opacity: 0.85 }}>
                A flexible audio router and mixer — route mics, system audio, and
                phones through buses with per-input DSP, monitoring, and recording.
              </p>
              <p style={{ opacity: 0.6, marginTop: 12 }}>
                <a
                  href="https://github.com/Sdomit/AudioManager"
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "var(--am-accent, #4f8cff)" }}
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
    <div style={{ marginBottom: 14 }}>
      <h3 style={{ margin: "0 0 6px", fontSize: 13 }}>{title}</h3>
      {devices.length === 0 ? (
        <p style={{ opacity: 0.6 }}>None found.</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {devices.map((d) => (
            <li key={d.id}>
              {d.name}
              {d.is_default && (
                <span style={{ opacity: 0.55 }}> · default</span>
              )}
              <span style={{ opacity: 0.45 }}>
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
