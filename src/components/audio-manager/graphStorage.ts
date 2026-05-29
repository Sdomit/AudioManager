/**
 * Phase B1 — storage adapter between NodeView's legacy localStorage keys
 * and the pure graphSerialization layer.
 *
 * Why this layer exists: the legacy on-disk shapes are NOT the same as
 * `SerializedGraph`. NodeView stores Maps as entry-tuple arrays and the
 * viewport as a bare object; `serializeGraph`/`parseGraph` speak a
 * different shape. This module owns that conversion so NodeView never has
 * to know the serialization format, and so `parseGraph`'s validation +
 * backend-send guard run on every load for free.
 *
 * B1 is adapter-only: no NodeView wiring, no behavior change, no combined
 * `am.graph.v1` key, no migration write-back. loadOverlay is a pure read
 * (it never persists). Writers preserve the exact legacy byte format so
 * B2/B3 wiring is provably a no-op on disk.
 *
 * Note: the LS_* constants below temporarily duplicate the ones in
 * NodeView.tsx. NodeView will import these from here in B2 and drop its
 * own copies.
 */

import {
  GRAPH_SCHEMA_VERSION,
  parseGraph,
  type GraphOverlay,
  type GroupMeta,
  type NodePos,
  type ParseWarning,
  type Viewport,
} from "./graphSerialization";
import type { EdgeId, GraphEdge, NodeId } from "./graph";

/* ── localStorage keys (duplicated from NodeView until B2) ────────────── */

export const LS_NODE_POSITIONS = "am.nodePositions.v2";
export const LS_LEGACY_INPUT_POSITIONS = "am.nodePositions.inputs";
export const LS_LEGACY_BUS_POSITIONS = "am.nodePositions.buses";
export const LS_GROUPS = "am.nodeGroups.v1";
export const LS_LOCAL_EDGES = "am.nodeLocalEdges.v1";
export const LS_VIEWPORT = "am.nodeView.viewport";

/* ── Viewport parity constants (mirror NodeView) ─────────────────────── */

export const DEFAULT_VIEWPORT: Viewport = { tx: 0, ty: 0, zoom: 1 };

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;

/** Clamp a zoom factor to NodeView's [0.25, 4] range. */
export function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/* ── Injectable storage (so tests run in Node without a DOM) ──────────── */

export interface GraphStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Read + JSON.parse a key. Returns undefined on missing key or bad JSON. */
function readJSON(storage: GraphStorageLike, key: string): unknown {
  try {
    const raw = storage.getItem(key);
    if (raw == null) return undefined;
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/* ── Legacy → SerializedGraph shape conversion ───────────────────────── */

/** `Array<[id, {name}]>` → `Array<{id, name}>`. parseGraph validates each. */
function legacyGroupsToSerialized(raw: unknown): Array<{ id: unknown; name: unknown }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Array<{ id: unknown; name: unknown }> = [];
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const id = entry[0];
    const meta = entry[1];
    const name = meta && typeof meta === "object" ? (meta as { name?: unknown }).name : undefined;
    out.push({ id, name });
  }
  return out;
}

/** `Array<[edgeId, GraphEdge]>` → `GraphEdge[]`. Tuple key dropped; the
 *  edge value carries its own `id`. parseGraph validates each. */
function legacyEdgesToSerialized(raw: unknown): unknown[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: unknown[] = [];
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    out.push(entry[1]);
  }
  return out;
}

/** `Array<[NodeId, NodePos]>` → `Record<NodeId, NodePos>`. */
function entriesToRecord(raw: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const rec: Record<string, unknown> = {};
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const nid = entry[0];
    if (typeof nid === "string") rec[nid] = entry[1];
  }
  return rec;
}

/** Split legacy positions (`am.nodePositions.inputs`/`.buses`) → record,
 *  prefixing raw ids with `in:` / `bus:` to form NodeIds. */
function legacySplitToRecord(inputsRaw: unknown, busesRaw: unknown): Record<string, unknown> {
  const rec: Record<string, unknown> = {};
  if (Array.isArray(inputsRaw)) {
    for (const entry of inputsRaw) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const id = entry[0];
      if (typeof id === "string") rec[`in:${id}`] = entry[1];
    }
  }
  if (Array.isArray(busesRaw)) {
    for (const entry of busesRaw) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const id = entry[0];
      if (typeof id === "string") rec[`bus:${id}`] = entry[1];
    }
  }
  return rec;
}

/* ── Load ─────────────────────────────────────────────────────────────── */

/**
 * Read the four legacy keys, convert to the SerializedGraph shape, run it
 * through parseGraph (validation + backend-send guard), then reconcile the
 * viewport to NodeView's exact behavior:
 *   - missing/invalid viewport → DEFAULT_VIEWPORT (not null)
 *   - valid viewport          → zoom clamped to [0.25, 4]
 *
 * Positions prefer `am.nodePositions.v2`; only when it is absent (or
 * unparseable) do the legacy split keys get migrated in-memory. This is a
 * read-only operation — it never writes back.
 */
export function loadOverlay(storage: GraphStorageLike): {
  overlay: GraphOverlay;
  warnings: ParseWarning[];
} {
  const groupsRaw = readJSON(storage, LS_GROUPS);
  const edgesRaw = readJSON(storage, LS_LOCAL_EDGES);
  const v2Raw = readJSON(storage, LS_NODE_POSITIONS);
  const viewportRaw = readJSON(storage, LS_VIEWPORT);

  let nodePositions: Record<string, unknown> | undefined;
  if (Array.isArray(v2Raw)) {
    nodePositions = entriesToRecord(v2Raw);
  } else {
    const inputsRaw = readJSON(storage, LS_LEGACY_INPUT_POSITIONS);
    const busesRaw = readJSON(storage, LS_LEGACY_BUS_POSITIONS);
    nodePositions = legacySplitToRecord(inputsRaw, busesRaw);
  }

  // schemaVersion is stamped as current: these legacy keys hold
  // current-format data, so suppress the spurious "MIGRATED" warning.
  const assembled = {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    groups: legacyGroupsToSerialized(groupsRaw),
    localEdges: legacyEdgesToSerialized(edgesRaw),
    nodePositions,
    viewport: viewportRaw === undefined ? null : viewportRaw,
  };

  const { overlay, warnings } = parseGraph(assembled);

  if (overlay.viewport === null) {
    overlay.viewport = { ...DEFAULT_VIEWPORT };
  } else {
    overlay.viewport = { ...overlay.viewport, zoom: clampZoom(overlay.viewport.zoom) };
  }

  return { overlay, warnings };
}

/* ── Save (exact legacy byte format — locked by tests) ───────────────── */

export function saveGroups(storage: GraphStorageLike, groups: Map<string, GroupMeta>): void {
  try {
    storage.setItem(LS_GROUPS, JSON.stringify(Array.from(groups.entries())));
  } catch {}
}

export function saveLocalEdges(storage: GraphStorageLike, localEdges: Map<EdgeId, GraphEdge>): void {
  try {
    storage.setItem(LS_LOCAL_EDGES, JSON.stringify(Array.from(localEdges.entries())));
  } catch {}
}

export function savePositions(storage: GraphStorageLike, positions: Map<NodeId, NodePos>): void {
  try {
    storage.setItem(LS_NODE_POSITIONS, JSON.stringify(Array.from(positions.entries())));
  } catch {}
}

export function saveViewport(storage: GraphStorageLike, viewport: Viewport): void {
  try {
    storage.setItem(LS_VIEWPORT, JSON.stringify(viewport));
  } catch {}
}

/**
 * Reset-layout parity: remove only the unified positions key. Groups,
 * local edges, viewport, and the legacy split keys are left untouched —
 * NodeView's current resetLayout removes only `am.nodePositions.v2`.
 */
export function clearPositions(storage: GraphStorageLike): void {
  try {
    storage.removeItem(LS_NODE_POSITIONS);
  } catch {}
}
