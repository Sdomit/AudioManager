import { useEffect, useMemo, useState } from "react";

import * as ipc from "../../ipc/commands";
import type { AudioSessionInfo, DeviceInfo } from "../../types/engine";
import {
  getVirtualDeviceHint,
  isAudioManagerVirtualDevice,
  isLikelyVirtualAudioDevice,
} from "../../utils/devices";
import { compareDevicesForPicker } from "../../utils/amvcPresets";
import styles from "./DevicePicker.module.css";

export type DevicePickerKind = "input" | "output";

interface DevicePickerProps {
  open: boolean;
  kind: DevicePickerKind;
  title: string;
  subtitle?: string;
  currentDeviceId?: string | null;
  /** Pass null to clear / unassign. */
  onPick: (deviceId: string | null) => void;
  onClose: () => void;
  /** Show virtual-audio hints (e.g. for the B1 stream bus). */
  highlightVirtual?: boolean;
  /** Device IDs to hide from the list (e.g. already-added inputs). */
  excludeIds?: Set<string>;
  /** Device id to highlight as the suggested/recommended pick. */
  recommendedDeviceId?: string | null;
  /**
   * Input mode only: also offer loopback sources — "System sound"
   * (`sys:default`) and each app currently playing audio (`proc:<pid>`).
   * onPick receives the synthetic source id, which add_input accepts.
   */
  includeLoopbackSources?: boolean;
}

const SYS_LOOPBACK_ID = "sys:default";

interface LoopbackItem {
  id: string;
  name: string;
  meta: string;
}

export function DevicePicker({
  open,
  kind,
  title,
  subtitle,
  currentDeviceId = null,
  onPick,
  onClose,
  highlightVirtual = false,
  excludeIds,
  recommendedDeviceId = null,
  includeLoopbackSources = false,
}: DevicePickerProps) {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [sessions, setSessions] = useState<AudioSessionInfo[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const wantsLoopback = includeLoopbackSources && kind === "input";

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const fetcher =
      kind === "output" ? ipc.listOutputDevices : ipc.listInputDevices;
    fetcher()
      .then((items) => {
        if (cancelled) return;
        setDevices(items);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(extractMessage(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, kind]);

  // App sessions are best-effort: a failure here (e.g. non-Windows) must not
  // break the device picker, so it has its own fetch that only clears the
  // app list on error.
  useEffect(() => {
    if (!open || !wantsLoopback) {
      setSessions([]);
      return;
    }
    let cancelled = false;
    const load = () => {
      ipc
        .listAudioSessions()
        .then((items) => {
          if (!cancelled) setSessions(items);
        })
        .catch(() => {
          if (!cancelled) setSessions([]);
        });
    };
    load();
    // Re-poll while the picker is open so apps that start/stop playing after it
    // opened are reflected (and stale stopped apps drop off the list).
    const timer = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, wantsLoopback]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = devices;
    if (excludeIds && excludeIds.size > 0) {
      list = list.filter((d) => !excludeIds.has(d.id));
    }
    if (q) {
      list = list.filter((d) => d.name.toLowerCase().includes(q));
    }
    // AudioManager-branded devices sort first; within each tier, default then alpha.
    return [...list].sort(compareDevicesForPicker);
  }, [devices, search, excludeIds]);

  const loopbackItems = useMemo<LoopbackItem[]>(() => {
    if (!wantsLoopback) return [];
    const q = search.trim().toLowerCase();
    let list: LoopbackItem[] = [
      {
        id: SYS_LOOPBACK_ID,
        name: "System sound",
        meta: "Everything Windows is playing",
      },
      ...sessions.map((s) => ({
        id: s.source_id,
        name: s.name,
        meta: `App · PID ${s.pid}`,
      })),
    ];
    if (excludeIds && excludeIds.size > 0) {
      list = list.filter((it) => !excludeIds.has(it.id));
    }
    if (q) {
      list = list.filter((it) => it.name.toLowerCase().includes(q));
    }
    return list;
  }, [wantsLoopback, sessions, search, excludeIds]);

  if (!open) return null;

  return (
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <div>
            <h2 className={styles.title}>{title}</h2>
            {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
          </div>
          <button
            className={styles.close}
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className={styles.searchWrap}>
          <input
            autoFocus
            className={styles.search}
            type="text"
            placeholder="Search devices"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {error && <div className={styles.errorMsg}>Error: {error}</div>}

        {!error && loopbackItems.length > 0 && (
          <>
            <div className={styles.subtitle}>Capture an app or system sound</div>
            <ul className={styles.list} aria-label="Capture sources">
              {loopbackItems.map((it) => (
                <li key={it.id}>
                  <button
                    className={styles.item}
                    onClick={() => onPick(it.id)}
                  >
                    <div className={styles.itemMain}>
                      <div className={styles.itemName}>{it.name}</div>
                      <div className={styles.itemMeta}>{it.meta}</div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
            <div className={styles.subtitle}>Input devices</div>
          </>
        )}

        {!error && loading && (
          <div className={styles.empty}>Loading devices…</div>
        )}

        {!error && !loading && filtered.length === 0 && (
          <div className={styles.empty}>
            {devices.length === 0
              ? "No devices reported by the system."
              : "No matches."}
          </div>
        )}

        {!error && !loading && filtered.length > 0 && (
          <ul className={styles.list}>
            {filtered.map((device) => {
              const selected = device.id === currentDeviceId;
              const isAmvc = isAudioManagerVirtualDevice(device.name);
              const isRecommended = recommendedDeviceId != null && device.id === recommendedDeviceId;
              const isVirtual = isLikelyVirtualAudioDevice(device.name);
              const hint = (highlightVirtual || isAmvc) && isVirtual
                ? getVirtualDeviceHint(device.name)
                : null;
              let itemClass = styles.item;
              if (selected) itemClass += ` ${styles.selected}`;
              if (isAmvc) itemClass += ` ${styles.itemAmvc}`;
              return (
                <li key={device.id}>
                  <button
                    className={itemClass}
                    onClick={() => onPick(device.id)}
                  >
                    <div className={styles.itemMain}>
                      <div className={styles.itemName}>{device.name}</div>
                      <div className={styles.itemMeta}>
                        {device.default_sample_rate} Hz · {device.channels}ch
                        {device.is_default ? " · default" : ""}
                      </div>
                    </div>
                    <div className={styles.itemBadges}>
                      {isRecommended && (
                        <span className={styles.recommendedBadge}>Recommended</span>
                      )}
                      {hint && <span className={styles.itemHint}>{hint}</span>}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <div className={styles.footer}>
          {currentDeviceId && (
            <button
              className={styles.unassignBtn}
              onClick={() => onPick(null)}
            >
              Unassign
            </button>
          )}
          <button className={styles.cancelBtn} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function extractMessage(e: unknown): string {
  if (typeof e === "object" && e !== null && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}
