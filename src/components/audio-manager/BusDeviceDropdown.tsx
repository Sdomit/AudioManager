import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, width: 0 });

  const computePos = () => {
    if (triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      setMenuPos({ top: r.bottom + 4, left: r.left, width: r.width });
    }
  };

  useEffect(() => {
    if (!open) return;
    computePos();
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
      const target = e.target as Node;
      const inRoot = rootRef.current?.contains(target);
      const inMenu = (document.getElementById("bus-device-menu-portal") as HTMLElement | null)?.contains(target);
      if (!inRoot && !inMenu) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onScroll = () => { computePos(); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  const choose = (id: string | null) => {
    onSelect(id);
    setOpen(false);
  };

  const menu = open
    ? createPortal(
        <div
          id="bus-device-menu-portal"
          className={styles.menu}
          style={{ position: "fixed", top: menuPos.top, left: menuPos.left, width: menuPos.width }}
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
        </div>,
        document.body
      )
    : null;

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        ref={triggerRef}
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
      {menu}
    </div>
  );
}

function extractMessage(e: unknown): string {
  if (typeof e === "object" && e !== null && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}
