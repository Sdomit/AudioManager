import type { BusId, Bus, AudioInput } from "./types";
import type { EndpointDirection } from "../../types/engine";

/**
 * What a Mini Controller knob drives. Hybrid: an OS audio endpoint
 * (system-wide volume) or a mixer channel (a bus or an input). For an
 * endpoint, `deviceId: null` means "follow the current OS default" — so the
 * speaker/mic knob tracks whatever device is default and re-points when the
 * default dropdown changes.
 */
export type KnobTarget =
  | { kind: "endpoint"; direction: EndpointDirection; deviceId: string | null }
  | { kind: "bus"; busId: BusId }
  | { kind: "input"; inputId: string };

export const DEFAULT_KNOB_A: KnobTarget = {
  kind: "endpoint",
  direction: "render",
  deviceId: null,
};
export const DEFAULT_KNOB_B: KnobTarget = {
  kind: "endpoint",
  direction: "capture",
  deviceId: null,
};

/** Stable string id for a target — for React keys + equality checks. */
export function targetKey(t: KnobTarget): string {
  switch (t.kind) {
    case "endpoint":
      return `endpoint:${t.direction}:${t.deviceId ?? "default"}`;
    case "bus":
      return `bus:${t.busId}`;
    case "input":
      return `input:${t.inputId}`;
  }
}

/** Human label for a target, given current buses/inputs for name lookup. */
export function targetLabel(
  t: KnobTarget,
  buses: Bus[],
  inputs: AudioInput[],
  endpointName?: string,
): string {
  switch (t.kind) {
    case "endpoint": {
      const which = t.direction === "render" ? "Speaker" : "Mic";
      if (t.deviceId === null) return `Default ${which}`;
      return endpointName?.trim() || which;
    }
    case "bus":
      return buses.find((b) => b.id === t.busId)?.label ?? "Bus";
    case "input":
      return inputs.find((i) => i.id === t.inputId)?.name ?? "Input";
  }
}

const LS_PREFIX = "am-mini-knob-";

function isKnobTarget(v: unknown): v is KnobTarget {
  if (!v || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  if (t.kind === "endpoint")
    return (
      (t.direction === "render" || t.direction === "capture") &&
      (t.deviceId === null || typeof t.deviceId === "string")
    );
  if (t.kind === "bus") return typeof t.busId === "string";
  if (t.kind === "input") return typeof t.inputId === "string";
  return false;
}

/** Load a persisted knob target by slot ("a" | "b"), or the fallback. */
export function loadKnobTarget(slot: string, fallback: KnobTarget): KnobTarget {
  try {
    const raw = localStorage.getItem(LS_PREFIX + slot);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return isKnobTarget(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** Persist a knob target for slot ("a" | "b"). */
export function saveKnobTarget(slot: string, t: KnobTarget): void {
  try {
    localStorage.setItem(LS_PREFIX + slot, JSON.stringify(t));
  } catch {
    /* private mode / quota — target just won't persist */
  }
}
