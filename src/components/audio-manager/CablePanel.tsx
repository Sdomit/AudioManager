import { useEffect, useRef, useState } from "react";
import {
  applyAmvcRoutingPreset,
  launchAmvcInstaller,
  queryAmvcHelper,
  setAmvcDeviceEnabled,
} from "../../utils/amvc";
import type { AmvcQueryResult } from "../../types/engine";
import { listBuses } from "../../ipc/commands";
import { onDevicesChanged } from "../../ipc/events";
import {
  AMVC_ALL_DEVICE_NAMES,
  findAmvcConflicts,
  mapAmvcEndpointAssignments,
  type BusDeviceAssignment,
} from "../../utils/amvcPresets";
import styles from "./CablePanel.module.css";

interface CablePanelProps {
  /** Query the helper when the host sheet opens; idle while closed. */
  open: boolean;
}

type Tone = "ok" | "warn" | "neutral" | "error";

export function CablePanel({ open }: CablePanelProps) {
  const [result, setResult] = useState<AmvcQueryResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [togglingDevice, setTogglingDevice] = useState(false);
  const [applying, setApplying] = useState(false);
  const [assignments, setAssignments] = useState<BusDeviceAssignment[]>([]);
  const busyRef = useRef(false);

  // Which bus is on which AMVC endpoint. Failure (e.g. outside a Tauri
  // webview) degrades to "no tags" instead of breaking the panel.
  async function refreshAssignments() {
    try {
      const buses = await listBuses();
      setAssignments(
        buses.map((b) => ({ busId: b.id, deviceId: b.output_device })),
      );
    } catch {
      setAssignments([]);
    }
  }

  async function recheck() {
    if (busyRef.current) return;
    busyRef.current = true;
    setChecking(true);
    try {
      const r = await queryAmvcHelper().catch(
        (): AmvcQueryResult => ({ kind: "unavailable", reason: "query failed" }),
      );
      setResult(r);
      await refreshAssignments();
    } finally {
      setChecking(false);
      busyRef.current = false;
    }
  }

  async function install() {
    if (busyRef.current) return;
    busyRef.current = true;
    setInstalling(true);
    try {
      await launchAmvcInstaller();
    } catch {
      // Surface via the next re-check; the helper may be absent.
    } finally {
      busyRef.current = false;
    }
  }

  async function toggleDevice(enable: boolean) {
    if (busyRef.current) return;
    busyRef.current = true;
    setTogglingDevice(true);
    try {
      await setAmvcDeviceEnabled(enable);
      await recheck();
    } catch {
      // Error surface via re-check status.
    } finally {
      setTogglingDevice(false);
      busyRef.current = false;
    }
  }

  async function applyPreset() {
    if (busyRef.current) return;
    busyRef.current = true;
    setApplying(true);
    try {
      await applyAmvcRoutingPreset();
      await refreshAssignments();
    } catch {
      // Bus state is re-pulled on the next re-check / hotplug event.
    } finally {
      setApplying(false);
      busyRef.current = false;
    }
  }

  // Query once each time the sheet transitions to open.
  useEffect(() => {
    if (open) void recheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Hotplug: cable endpoints arriving or leaving change both the health
  // readout and the assignment tags — re-check automatically while open.
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onDevicesChanged(() => void recheck()).then((un) => {
      if (disposed) un();
      else unlisten = un;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const detected = new Set(
    result?.kind === "ok" ? result.detected.map((n) => n.toLowerCase()) : [],
  );

  const deviceEnabled: boolean | undefined =
    result?.kind === "ok" ? result.device_enabled : undefined;
  const endpointBuses = mapAmvcEndpointAssignments(assignments);
  const conflicts = findAmvcConflicts(assignments);

  let tone: Tone = "neutral";
  let headline = "Checking…";
  let detail = "";
  let showInstall = false;
  let installLabel = "Install";

  if (result?.kind === "unavailable") {
    tone = "neutral";
    headline = "Optional add-on";
    detail =
      "Branded virtual cable ships separately. AudioManager routes through any virtual audio device — install a third-party cable such as VB-Cable to send audio between apps.";
  } else if (result?.kind === "ok") {
    const { status, found, expected } = result;

    // Device marked disabled (ConfigFlags bit 0 set). evaluate() returns
    // needs-repair when found=0, so check device_enabled before the status switch.
    // Distinguish pre-reboot (endpoints still running) from post-reboot (gone).
    if (result.device_enabled === false && result.driver_in_store) {
      tone = "warn";
      if (result.found > 0) {
        headline = "Disable pending reboot";
        detail = "Endpoints will be hidden from Windows Sound after next reboot.";
      } else {
        headline = "Disabled";
        detail = "Driver installed — endpoints hidden from Windows Sound settings.";
      }
    } else {
      switch (status) {
        case "installed-healthy":
          tone = "ok";
          headline = "Connected";
          detail = `All ${expected} endpoints present.`;
          break;
        case "needs-reboot":
          tone = "warn";
          headline = "Reboot required";
          detail = "The cable is installed but needs a system reboot to finish.";
          break;
        case "installed-degraded":
        case "needs-repair":
          tone = "warn";
          headline = status === "needs-repair" ? "Needs repair" : "Degraded";
          detail = `${found} of ${expected} endpoints present.`;
          showInstall = true;
          installLabel = "Repair";
          break;
        case "not-installed":
        default:
          tone = "neutral";
          headline = "Not installed";
          detail = "Install the AudioManager Virtual Cable to enable branded routing.";
          showInstall = true;
          installLabel = "Install";
          break;
      }
    }
  }

  const healthy = result?.kind === "ok" && result.status === "installed-healthy";

  return (
    <section className={`${styles.panel} ${styles[`tone_${tone}`]}`} aria-label="Virtual cable status">
      <div className={styles.head}>
        <span className={`${styles.dot} ${styles[`dot_${tone}`]}`} aria-hidden />
        <div className={styles.headText}>
          <div className={styles.headline}>AudioManager Virtual Cable — {headline}</div>
          {detail && <div className={styles.detail}>{detail}</div>}
        </div>
      </div>

      <ul className={styles.endpoints}>
        {AMVC_ALL_DEVICE_NAMES.map((name) => {
          const live = detected.has(name.toLowerCase());
          const buses = endpointBuses.get(name) ?? [];
          return (
            <li key={name} className={live ? styles.epLive : styles.epMissing}>
              <span className={styles.epDot} aria-hidden />
              {name.replace(/^AudioManager /, "")}
              {buses.length > 0 && (
                <span
                  className={`${styles.epTag} ${buses.length > 1 ? styles.epTagConflict : ""}`}
                >
                  {buses.join(" + ")}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {conflicts.length > 0 && (
        <div className={styles.conflictNote} role="note">
          {conflicts
            .map((c) => `${c.buses.join(" and ")} share ${c.endpoint.replace(/^AudioManager /, "")}`)
            .join("; ")}
          {" — apps on that cable hear both mixes."}
        </div>
      )}

      <div className={styles.actions}>
        {showInstall && (
          <button
            className={styles.primaryBtn}
            onClick={() => void install()}
            disabled={installing || checking}
          >
            {installing ? "Installing…" : installLabel}
          </button>
        )}
        {deviceEnabled === true && result?.kind === "ok" && result.status === "installed-healthy" && (
          <button
            className={styles.secondaryBtn}
            onClick={() => void toggleDevice(false)}
            disabled={togglingDevice || checking}
            title="Hide all AMVC endpoints from Windows Sound settings (requires reboot to apply)"
          >
            {togglingDevice ? "Disabling…" : "Disable from Windows"}
          </button>
        )}
        {deviceEnabled === false && (
          <button
            className={styles.primaryBtn}
            onClick={() => void toggleDevice(true)}
            disabled={togglingDevice || checking}
            title="Show AMVC endpoints in Windows Sound settings"
          >
            {togglingDevice ? "Enabling…" : "Enable in Windows"}
          </button>
        )}
        {healthy && (
          <button
            className={styles.primaryBtn}
            onClick={() => void applyPreset()}
            disabled={applying || checking}
          >
            {applying ? "Routing…" : "Auto-route buses"}
          </button>
        )}
        <button
          className={styles.secondaryBtn}
          onClick={() => void recheck()}
          disabled={checking}
        >
          {checking ? "Checking…" : "Re-check"}
        </button>
      </div>
    </section>
  );
}
