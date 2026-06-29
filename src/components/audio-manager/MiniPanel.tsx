import { useCallback, useEffect, useRef, useState } from "react";
import { Knob } from "./Knob";
import {
  audioListEndpoints,
  audioSetDefaultEndpoint,
  audioGetEndpointVolume,
  audioSetEndpointVolume,
  audioSetEndpointMute,
} from "../../ipc/commands";
import type { EndpointInfo } from "../../types/engine";
import type { Bus, AudioInput, BusId } from "./types";
import {
  DEFAULT_KNOB_A,
  DEFAULT_KNOB_B,
  loadKnobTarget,
  saveKnobTarget,
  targetKey,
  targetLabel,
  type KnobTarget,
} from "./knobTarget";
import styles from "./MiniPanel.module.css";

interface MiniPanelProps {
  buses: Bus[];
  inputs: AudioInput[];
  setBusVolume: (id: BusId, volume: number) => void;
  setBusMuted: (id: BusId, muted: boolean) => void;
  setInputGain: (id: string, gain: number) => void;
  setInputMuted: (id: string, muted: boolean) => void;
  /** Compact chrome for the always-on-top window (MC-3). */
  variant?: "dock" | "window";
  /** Pop-out window mode: endpoint knobs only (default speaker/mic), no mixer
   *  target picker — so it needs no app state and runs no second mixer poll. */
  endpointOnly?: boolean;
}

interface Endpoints {
  render: EndpointInfo[];
  capture: EndpointInfo[];
}

const EMPTY_ENDPOINTS: Endpoints = { render: [], capture: [] };

function defaultId(list: EndpointInfo[]): string | null {
  return list.find((e) => e.is_default)?.id ?? null;
}

/** Resolve an endpoint knob's live device id (null target = OS default). */
function resolveEndpointId(t: KnobTarget, eps: Endpoints): string | null {
  if (t.kind !== "endpoint") return null;
  if (t.deviceId) return t.deviceId;
  return defaultId(t.direction === "render" ? eps.render : eps.capture);
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * Mini Controller body: two hybrid-target knobs (each drives an OS endpoint or
 * a mixer channel), mute buttons, target pickers, and the OS default-device
 * dropdowns. Endpoint volumes are polled; mixer values come from props.
 */
export function MiniPanel({
  buses,
  inputs,
  setBusVolume,
  setBusMuted,
  setInputGain,
  setInputMuted,
  variant = "dock",
  endpointOnly = false,
}: MiniPanelProps) {
  const [knobA, setKnobA] = useState<KnobTarget>(() =>
    endpointOnly ? DEFAULT_KNOB_A : loadKnobTarget("a", DEFAULT_KNOB_A),
  );
  const [knobB, setKnobB] = useState<KnobTarget>(() =>
    endpointOnly ? DEFAULT_KNOB_B : loadKnobTarget("b", DEFAULT_KNOB_B),
  );
  const [eps, setEps] = useState<Endpoints>(EMPTY_ENDPOINTS);
  // Polled endpoint volumes, keyed by device id.
  const [epVol, setEpVol] = useState<Record<string, { volume: number; muted: boolean }>>({});
  // deviceId -> last local-set timestamp; the poll skips these briefly so a
  // drag or mute toggle isn't snapped back by a stale read still in flight.
  const recentlySetRef = useRef<Record<string, number>>({});

  const refreshEndpoints = useCallback(async () => {
    try {
      const [render, capture] = await Promise.all([
        audioListEndpoints("render"),
        audioListEndpoints("capture"),
      ]);
      setEps({ render, capture });
    } catch {
      /* Windows-only; off-platform these reject — leave lists empty */
    }
  }, []);

  useEffect(() => {
    void refreshEndpoints();
  }, [refreshEndpoints]);

  // Poll the volumes of whichever endpoints the two knobs currently resolve to.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      // Don't burn COM cycles polling a hidden window (e.g. the mini window
      // closed-to-hidden, or a backgrounded tab).
      if (typeof document !== "undefined" && document.hidden) return;
      const ids = new Set<string>();
      for (const t of [knobA, knobB]) {
        const id = resolveEndpointId(t, eps);
        if (id) ids.add(id);
      }
      if (ids.size === 0) return;
      try {
        const entries = await Promise.all(
          [...ids].map(async (id) => [id, await audioGetEndpointVolume(id)] as const),
        );
        if (cancelled) return;
        const now = Date.now();
        setEpVol((prev) => {
          const next = { ...prev };
          for (const [id, v] of entries) {
            // Skip ids the user touched in the last 700ms so a live drag/toggle
            // wins over an in-flight stale read.
            if (now - (recentlySetRef.current[id] ?? 0) < 700) continue;
            next[id] = { volume: v.volume, muted: v.muted };
          }
          return next;
        });
      } catch {
        /* endpoint vanished mid-poll — keep last values */
      }
    };
    const handle = setInterval(poll, 250);
    void poll();
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [knobA, knobB, eps]);

  // Resolve a knob target to its live {value, muted, label} + apply handlers.
  const view = useCallback(
    (t: KnobTarget) => {
      if (t.kind === "endpoint") {
        const id = resolveEndpointId(t, eps);
        const cur = id ? epVol[id] : undefined;
        const name = id
          ? (t.direction === "render" ? eps.render : eps.capture).find((e) => e.id === id)?.name
          : undefined;
        return {
          value: cur?.volume ?? 0,
          muted: cur?.muted ?? false,
          label: targetLabel(t, buses, inputs, name),
          available: id !== null,
          setValue: (v: number) => {
            if (!id) return;
            recentlySetRef.current[id] = Date.now();
            setEpVol((p) => ({ ...p, [id]: { volume: v, muted: p[id]?.muted ?? false } }));
            void audioSetEndpointVolume(id, v);
          },
          toggleMute: () => {
            if (!id) return;
            recentlySetRef.current[id] = Date.now();
            const next = !(cur?.muted ?? false);
            setEpVol((p) => ({ ...p, [id]: { volume: p[id]?.volume ?? 0, muted: next } }));
            void audioSetEndpointMute(id, next);
          },
        };
      }
      if (t.kind === "bus") {
        const b = buses.find((x) => x.id === t.busId);
        return {
          value: b?.volume ?? 0,
          muted: b?.muted ?? false,
          label: targetLabel(t, buses, inputs),
          available: !!b,
          setValue: (v: number) => b && setBusVolume(b.id, v),
          toggleMute: () => b && setBusMuted(b.id, !b.muted),
        };
      }
      const i = inputs.find((x) => x.id === t.inputId);
      return {
        value: i?.gain ?? 0,
        muted: i?.muted ?? false,
        label: targetLabel(t, buses, inputs),
        available: !!i,
        setValue: (v: number) => i && setInputGain(i.id, v),
        toggleMute: () => i && setInputMuted(i.id, !i.muted),
      };
    },
    [eps, epVol, buses, inputs, setBusVolume, setBusMuted, setInputGain, setInputMuted],
  );

  const setDefault = useCallback(
    async (id: string) => {
      try {
        await audioSetDefaultEndpoint(id);
        await refreshEndpoints();
      } catch {
        /* ignore — non-Windows or device gone */
      }
    },
    [refreshEndpoints],
  );

  const onPickTarget = (slot: "a" | "b", t: KnobTarget) => {
    const set = slot === "a" ? setKnobA : setKnobB;
    set(t);
    saveKnobTarget(slot, t);
  };

  const a = view(knobA);
  const b = view(knobB);

  return (
    <div className={`${styles.panel} ${variant === "window" ? styles.window : ""}`}>
      <div className={styles.knobs}>
        <KnobSlot
          slotLabel="A"
          target={knobA}
          v={a}
          buses={buses}
          inputs={inputs}
          showPicker={!endpointOnly}
          onPick={(t) => onPickTarget("a", t)}
        />
        <KnobSlot
          slotLabel="B"
          target={knobB}
          v={b}
          buses={buses}
          inputs={inputs}
          showPicker={!endpointOnly}
          onPick={(t) => onPickTarget("b", t)}
        />
      </div>

      <div className={styles.defaults}>
        <DeviceSelect
          label="Default speaker"
          list={eps.render}
          onPick={(id) => void setDefault(id)}
        />
        <DeviceSelect
          label="Default mic"
          list={eps.capture}
          onPick={(id) => void setDefault(id)}
        />
      </div>
    </div>
  );
}

interface SlotView {
  value: number;
  muted: boolean;
  label: string;
  available: boolean;
  setValue: (v: number) => void;
  toggleMute: () => void;
}

function KnobSlot({
  slotLabel,
  target,
  v,
  buses,
  inputs,
  showPicker,
  onPick,
}: {
  slotLabel: string;
  target: KnobTarget;
  v: SlotView;
  buses: Bus[];
  inputs: AudioInput[];
  showPicker: boolean;
  onPick: (t: KnobTarget) => void;
}) {
  return (
    <div className={styles.slot}>
      <Knob
        value={v.value}
        onChange={v.setValue}
        label={v.label}
        valueLabel={v.available ? pct(v.value) : "—"}
        ariaLabel={`${v.label} volume`}
        muted={v.muted}
        onMuteToggle={v.available ? v.toggleMute : undefined}
        disabled={!v.available}
      />
      {showPicker && (
        <TargetSelect
          slotLabel={slotLabel}
          target={target}
          buses={buses}
          inputs={inputs}
          onPick={onPick}
        />
      )}
    </div>
  );
}

/** Picks what a knob controls: a default endpoint, a bus, or an input. */
function TargetSelect({
  slotLabel,
  target,
  buses,
  inputs,
  onPick,
}: {
  slotLabel: string;
  target: KnobTarget;
  buses: Bus[];
  inputs: AudioInput[];
  onPick: (t: KnobTarget) => void;
}) {
  const options: { key: string; label: string; target: KnobTarget }[] = [
    { key: "endpoint:render:default", label: "Default Speaker", target: DEFAULT_KNOB_A },
    { key: "endpoint:capture:default", label: "Default Mic", target: DEFAULT_KNOB_B },
    ...buses.map((b) => ({
      key: `bus:${b.id}`,
      label: `Bus · ${b.label}`,
      target: { kind: "bus", busId: b.id } as KnobTarget,
    })),
    ...inputs.map((i) => ({
      key: `input:${i.id}`,
      label: `Input · ${i.name}`,
      target: { kind: "input", inputId: i.id } as KnobTarget,
    })),
  ];
  const current = targetKey(target);
  return (
    <select
      className={styles.targetSelect}
      value={current}
      aria-label={`Knob ${slotLabel} target`}
      onChange={(e) => {
        const opt = options.find((o) => o.key === e.target.value);
        if (opt) onPick(opt.target);
      }}
    >
      {options.every((o) => o.key !== current) && (
        <option value={current}>{targetLabel(target, buses, inputs)}</option>
      )}
      {options.map((o) => (
        <option key={o.key} value={o.key}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function DeviceSelect({
  label,
  list,
  onPick,
}: {
  label: string;
  list: EndpointInfo[];
  onPick: (id: string) => void;
}) {
  const current = defaultId(list) ?? "";
  return (
    <label className={styles.deviceField}>
      <span className={styles.deviceLabel}>{label}</span>
      <select
        className={styles.deviceSelect}
        value={current}
        disabled={list.length === 0}
        onChange={(e) => onPick(e.target.value)}
      >
        {list.length === 0 && <option value="">No devices</option>}
        {list.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name || "Unnamed device"}
          </option>
        ))}
      </select>
    </label>
  );
}
