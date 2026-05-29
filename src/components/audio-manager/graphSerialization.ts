/**
 * Pure serialize/deserialize for the frontend-owned graph overlay.
 *
 * The overlay covers what the UI owns end-to-end:
 *   - group nodes (frontend-only, no backend representation yet)
 *   - localEdges between groups and between groups and input/bus nodes
 *   - node positions for layout
 *   - viewport (pan + zoom)
 *
 * Explicitly NOT serialized:
 *   - backend input → bus sends (live backend state)
 *   - selection, drag, hover, marquee (ephemeral UI state)
 *   - audio routing / preset state (owned by the engine)
 *
 * parseGraph never throws. Malformed pieces are dropped with a warning
 * so a corrupt save can still hydrate as an empty overlay rather than
 * locking the app out of the routing view.
 */

import {
  groupIdFromNodeId,
  isBusNodeId,
  isInputNodeId,
} from "./graph";
import type { EdgeId, GraphEdge, NodeId } from "./graph";

export const GRAPH_SCHEMA_VERSION = 1;

export type NodePos = { x: number; y: number };

export interface Viewport {
  tx: number;
  ty: number;
  zoom: number;
}

export interface GroupMeta {
  name: string;
}

export interface SerializedGroup {
  id: string;
  name: string;
}

export interface SerializedGraph {
  schemaVersion: number;
  groups: SerializedGroup[];
  localEdges: GraphEdge[];
  nodePositions: Record<NodeId, NodePos>;
  viewport: Viewport | null;
}

export interface GraphOverlay {
  groups: Map<string, GroupMeta>;
  localEdges: Map<EdgeId, GraphEdge>;
  positions: Map<NodeId, NodePos>;
  viewport: Viewport | null;
}

export interface ParseWarning {
  code: string;
  message: string;
}

export interface ParseResult {
  overlay: GraphOverlay;
  warnings: ParseWarning[];
}

export function emptyOverlay(): GraphOverlay {
  return {
    groups: new Map(),
    localEdges: new Map(),
    positions: new Map(),
    viewport: null,
  };
}

/** Pure input → bus is owned by the backend send model, never the overlay. */
function isBackendSendEdge(fromNode: NodeId, toNode: NodeId): boolean {
  return isInputNodeId(fromNode) && isBusNodeId(toNode);
}

export function serializeGraph(overlay: GraphOverlay): SerializedGraph {
  const groups: SerializedGroup[] = [];
  for (const [id, meta] of overlay.groups) {
    groups.push({ id, name: meta.name });
  }
  groups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const localEdges: GraphEdge[] = [];
  for (const edge of overlay.localEdges.values()) {
    if (isBackendSendEdge(edge.fromNode, edge.toNode)) continue;
    localEdges.push({ ...edge });
  }
  localEdges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const nodePositions: Record<NodeId, NodePos> = {};
  for (const [nid, p] of overlay.positions) {
    nodePositions[nid] = { x: p.x, y: p.y };
  }

  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    groups,
    localEdges,
    nodePositions,
    viewport: overlay.viewport
      ? { tx: overlay.viewport.tx, ty: overlay.viewport.ty, zoom: overlay.viewport.zoom }
      : null,
  };
}

export function serializeGraphToString(overlay: GraphOverlay): string {
  return JSON.stringify(serializeGraph(overlay));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function finiteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function parseViewport(v: unknown, warnings: ParseWarning[]): Viewport | null {
  if (v === null || v === undefined) return null;
  if (!isRecord(v)) {
    warnings.push({ code: "BAD_VIEWPORT", message: "viewport must be object or null" });
    return null;
  }
  const { tx, ty, zoom } = v;
  if (!finiteNum(tx) || !finiteNum(ty) || !finiteNum(zoom) || zoom <= 0) {
    warnings.push({
      code: "BAD_VIEWPORT",
      message: "viewport tx/ty/zoom must be finite, zoom > 0",
    });
    return null;
  }
  return { tx, ty, zoom };
}

function parseGroups(raw: unknown, warnings: ParseWarning[]): Map<string, GroupMeta> {
  const out = new Map<string, GroupMeta>();
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (!isRecord(item)) {
      warnings.push({ code: "BAD_GROUP", message: "group entry not an object" });
      continue;
    }
    const { id, name } = item;
    if (!nonEmptyString(id)) {
      warnings.push({ code: "BAD_GROUP", message: "group id must be non-empty string" });
      continue;
    }
    if (typeof name !== "string") {
      warnings.push({
        code: "BAD_GROUP",
        message: `group ${id} name must be string`,
      });
      continue;
    }
    if (out.has(id)) {
      warnings.push({ code: "DUP_GROUP", message: `duplicate group id: ${id}` });
      continue;
    }
    out.set(id, { name });
  }
  return out;
}

function parseLocalEdges(
  raw: unknown,
  groups: Map<string, GroupMeta>,
  warnings: ParseWarning[],
): Map<EdgeId, GraphEdge> {
  const out = new Map<EdgeId, GraphEdge>();
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (!isRecord(item)) {
      warnings.push({ code: "BAD_EDGE", message: "edge entry not an object" });
      continue;
    }
    const { id, fromNode, fromPort, toNode, toPort, gain, muted } = item;
    if (!nonEmptyString(id)) {
      warnings.push({ code: "BAD_EDGE", message: "edge id must be non-empty string" });
      continue;
    }
    if (!nonEmptyString(fromNode) || !nonEmptyString(toNode)) {
      warnings.push({
        code: "BAD_EDGE",
        message: `edge ${id} fromNode/toNode must be non-empty strings`,
      });
      continue;
    }
    if (fromPort !== "out" || toPort !== "in") {
      warnings.push({
        code: "BAD_EDGE",
        message: `edge ${id} ports must be out→in`,
      });
      continue;
    }
    if (isBackendSendEdge(fromNode, toNode)) {
      warnings.push({
        code: "BACKEND_SEND_EDGE",
        message: `edge ${id} is a backend input→bus send, dropped from overlay`,
      });
      continue;
    }
    const fromGid = groupIdFromNodeId(fromNode);
    const toGid = groupIdFromNodeId(toNode);
    if (fromGid !== null && !groups.has(fromGid)) {
      warnings.push({
        code: "EDGE_MISSING_NODE",
        message: `edge ${id} fromNode ${fromNode} missing from groups`,
      });
      continue;
    }
    if (toGid !== null && !groups.has(toGid)) {
      warnings.push({
        code: "EDGE_MISSING_NODE",
        message: `edge ${id} toNode ${toNode} missing from groups`,
      });
      continue;
    }
    if (out.has(id)) {
      warnings.push({ code: "DUP_EDGE", message: `duplicate edge id: ${id}` });
      continue;
    }
    const g = finiteNum(gain) ? gain : 1;
    const m = typeof muted === "boolean" ? muted : false;
    out.set(id, {
      id,
      fromNode,
      fromPort: "out",
      toNode,
      toPort: "in",
      gain: g,
      muted: m,
    });
  }
  return out;
}

function parsePositions(raw: unknown, warnings: ParseWarning[]): Map<NodeId, NodePos> {
  const out = new Map<NodeId, NodePos>();
  if (!isRecord(raw)) return out;
  for (const [nid, val] of Object.entries(raw)) {
    if (!nonEmptyString(nid)) continue;
    if (!isRecord(val) || !finiteNum(val.x) || !finiteNum(val.y)) {
      warnings.push({ code: "BAD_POSITION", message: `bad position for ${nid}` });
      continue;
    }
    out.set(nid, { x: val.x, y: val.y });
  }
  return out;
}

export function parseGraph(raw: unknown): ParseResult {
  const warnings: ParseWarning[] = [];
  if (!isRecord(raw)) {
    warnings.push({ code: "BAD_ROOT", message: "root must be an object" });
    return { overlay: emptyOverlay(), warnings };
  }
  const rawVer = raw.schemaVersion;
  if (rawVer === undefined) {
    warnings.push({
      code: "MIGRATED",
      message: "missing schemaVersion, treating as current",
    });
  } else if (!finiteNum(rawVer)) {
    warnings.push({
      code: "MIGRATED",
      message: "non-numeric schemaVersion, treating as current",
    });
  } else if (rawVer > GRAPH_SCHEMA_VERSION) {
    warnings.push({
      code: "VERSION_TOO_NEW",
      message: `schemaVersion ${rawVer} > ${GRAPH_SCHEMA_VERSION}`,
    });
    return { overlay: emptyOverlay(), warnings };
  } else if (rawVer < GRAPH_SCHEMA_VERSION) {
    warnings.push({
      code: "MIGRATED",
      message: `schemaVersion ${rawVer} < ${GRAPH_SCHEMA_VERSION}, best-effort parse`,
    });
  }
  const groups = parseGroups(raw.groups, warnings);
  const localEdges = parseLocalEdges(raw.localEdges, groups, warnings);
  const positions = parsePositions(raw.nodePositions, warnings);
  const viewport = parseViewport(raw.viewport, warnings);
  return {
    overlay: { groups, localEdges, positions, viewport },
    warnings,
  };
}

export function parseGraphFromString(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      overlay: emptyOverlay(),
      warnings: [{ code: "CORRUPT", message: "invalid JSON" }],
    };
  }
  return parseGraph(parsed);
}
