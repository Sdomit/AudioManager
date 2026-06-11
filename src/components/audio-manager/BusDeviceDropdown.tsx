import { useEffect, useRef, useState } from "react";

import * as ipc from "../../ipc/commands";
import type { DeviceInfo } from "../../types/engine";
import { compareDevicesForPicker } from "../../utils/amvcPresets";
import styles from "./BusDeviceDropdown.module.css";

interface BusDeviceDropdownProps {
  busLabel: string;
  currentDevice: string | null;
  /** Pass null to unassign. */
  onSelect: (deviceId: string | null) => void;
}

/**
 * Inline output-device picker for a bus card. Click the trigger to open a
 * popover of output devices and select one — no modal round-trip. Output
 * devices are fetched each time the menu opens so freshly plugged/unplugged
 * devices show up.
 */
export function BusDeviceDropdown({
  busLabel,
  currentDevice,
  onSelect,
}: BusDeviceDropdownProps) {
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    ipc
      .listOutputDevices()
      .then((items) => {
        if (cancelled) return;
        setDevices([...items].sort(compareDevicesForPicker));
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
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = (id: string | null) => {
    onSelect(id);
    setOpen(false);
  };

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={styles.trigger}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={currentDevice ?? "Select output device"}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <span className={currentDevice ? styles.deviceName : styles.deviceMissing}>
          {currentDevice ?? "Select output device"}
        </span>
        <span className={styles.chevron} aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <div
          className={styles.menu}
          role="listbox"
          aria-label={`Output device for ${busLabel}`}
          onClick={(e) => e.stopPropagation()}
        >
          {loading && <div className={styles.msg}>Loading devices…</div>}
          {error && <div className={styles.errorMsg}>Error: {error}</div>}
          {!loading && !error && devices.length === 0 && (
            <div className={styles.msg}>No output devices.</div>
          )}
          {!loading &&
            !error &&
            devices.map((d) => {
              const selected = d.id === currentDevice;
              return (
                <button
                  key={d.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`${styles.item} ${selected ? styles.selected : ""}`}
                  onClick={() => choose(d.id)}
                >
                  <span className={styles.itemName}>{d.name}</span>
                  <span className={styles.itemMeta}>
                    {d.default_sample_rate} Hz · {d.channels}ch
                    {d.is_default ? " · default" : ""}
                  </span>
                </button>
              );
            })}
          {currentDevice && (
            <button
              type="button"
              className={styles.unassign}
              onClick={() => choose(null)}
            >
              Unassign device
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function extractMessage(e: unknown): string {
  if (typeof e === "object" && e !== null && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}
