import { useCallback, useRef, useState } from "react";
import type { AudioInput, Bus, Send } from "./types";

/**
 * Snapshot of the user-mutable audio state for undo/redo.
 * Excludes ephemeral fields (meter levels, clipUntil) so undo doesn't
 * thrash meters or revive stale clip latches.
 */
export interface Snapshot {
  buses: BusSnap[];
  inputs: InputSnap[];
  sends: Send[];
}

export interface BusSnap {
  id: Bus["id"];
  device: string | null;
  enabled: boolean;
  muted: boolean;
  volume: number;
}

export interface InputSnap {
  id: string;
  name: string;
  kind: AudioInput["kind"];
  device: string;
  gain: number;
  muted: boolean;
}

export function takeSnapshot(
  buses: Bus[],
  inputs: AudioInput[],
  sends: Send[],
): Snapshot {
  return {
    buses: buses.map((b) => ({
      id: b.id,
      device: b.device,
      enabled: b.enabled,
      muted: b.muted,
      volume: b.volume,
    })),
    inputs: inputs.map((i) => ({
      id: i.id,
      name: i.name,
      kind: i.kind,
      device: i.device,
      gain: i.gain,
      muted: i.muted,
    })),
    sends: sends.map((s) => ({ ...s })),
  };
}

const HISTORY_CAP = 50;

export interface UseHistory {
  /**
   * Push pre-action snapshot. Clears redo stack.
   * If `coalesceKey` matches the previous push's key, the call is
   * silently skipped — useful for slider drags (one entry per gesture,
   * not per change).
   */
  push: (snap: Snapshot, coalesceKey?: string) => void;
  /** Pop a past snapshot and ALSO push `current` onto redo stack. */
  undo: (current: Snapshot) => Snapshot | null;
  /** Pop a future snapshot and ALSO push `current` onto undo stack. */
  redo: (current: Snapshot) => Snapshot | null;
  /** Wipe both stacks (e.g., after preset load / hydrate). */
  reset: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export function useHistory(): UseHistory {
  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const lastKey = useRef<string | null>(null);
  const [, force] = useState(0);
  const bump = useCallback(() => force((n) => (n + 1) & 0x7fffffff), []);

  const push = useCallback(
    (snap: Snapshot, coalesceKey?: string) => {
      if (coalesceKey != null && coalesceKey === lastKey.current) return;
      past.current.push(snap);
      if (past.current.length > HISTORY_CAP) past.current.shift();
      if (future.current.length > 0) future.current = [];
      lastKey.current = coalesceKey ?? null;
      bump();
    },
    [bump],
  );

  const undo = useCallback(
    (current: Snapshot): Snapshot | null => {
      const snap = past.current.pop();
      if (!snap) return null;
      future.current.push(current);
      if (future.current.length > HISTORY_CAP) future.current.shift();
      bump();
      return snap;
    },
    [bump],
  );

  const redo = useCallback(
    (current: Snapshot): Snapshot | null => {
      const snap = future.current.pop();
      if (!snap) return null;
      past.current.push(current);
      if (past.current.length > HISTORY_CAP) past.current.shift();
      bump();
      return snap;
    },
    [bump],
  );

  const reset = useCallback(() => {
    past.current = [];
    future.current = [];
    bump();
  }, [bump]);

  return {
    push,
    undo,
    redo,
    reset,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
  };
}
