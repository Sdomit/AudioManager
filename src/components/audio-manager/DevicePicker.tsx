import { useEffect, useMemo, useState } from "react";

import * as ipc from "../../ipc/commands";
import type { DeviceInfo } from "../../types/engine";
import {
  getVirtualDeviceHint,
  isAudioManagerVirtualDevice,
  isLikelyVirtualAudioDevice,
} from "../../utils/devices";
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
}: DevicePickerProps) {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
    return [...list].sort((a, b) => {
      const aAm = isAudioManagerVirtualDevice(a.name);
      const bAm = isAudioManagerVirtualDevice(b.name);
      if (aAm !== bAm) return aAm ? -1 : 1;
      if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [devices, search, excludeIds]);

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
