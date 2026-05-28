/**
 * Generalized audio routing graph (Phase G-1, UI-only).
 *
 * The shipping backend is bipartite (Input → Bus, fixed 4 buses). This
 * module defines the generalized DAG model the UI will adopt so future
 * phases — FX nodes, sub-mix groups, sidechain — can land without
 * another type-system rewrite. The Rust engine still speaks the old
 * model; `graphAdapter.ts` translates between the two.
 *
 * Invariants:
 *   1. Nodes and edges are addressed by string id (uuid-like).
 *   2. An edge connects (fromNode.fromPort) → (toNode.toPort), both
 *      ports must exist on their respective nodes, fromPort.dir must be
 *      "out", toPort.dir must be "in", and port kinds must match.
 *   3. Graphs are DAGs. `addEdge` rejects self-loops and cycles via DFS.
 *   4. Per-edge `gain` is in the UI scale (0..1, 0.75 ≈ unity) for
 *      parity with `Send.gain`. Conversion happens at the engine layer.
 */

import type { AudioInput, Bus, BusId, InputSourceKind } from "./types";

export type NodeId = string;
export type PortId = string;
export type EdgeId = string;

export type PortKind = "audio" | "sidechain" | "control";
export type ChannelLayout = "mono" | "stereo";
export type PortDirection = "in" | "out";

export interface Port {
  id: PortId;
  kind: PortKind;
  layout: ChannelLayout;
  dir: PortDirection;
}

/**
 * NodeKind carries the original UI-model data on `backing` for
 * input/bus nodes so the adapter can rebuild buses/inputs without loss.
 * group / splitter / fx / meter are pure-graph and have no legacy backing.
 */
export type NodeKind =
  | { type: "input"; backing: AudioInput }
  | { type: "bus"; backing: Bus }
  | { type: "group" }
  | { type: "splitter" }
  | { type: "fx"; fx: FxParams }
  | { type: "meter" };

export type FxParams =
  | {
      kind: "noise_gate";
      thresholdDb: number;
      attackMs: number;
      releaseMs: number;
    }
  | {
      kind: "compressor";
      thresholdDb: number;
      ratio: number;
      attackMs: number;
      releaseMs: number;
      kneeDb: number;
      makeupDb: number;
    }
  | { kind: "high_pass"; cutoffHz: number; slopeDbPerOct: 6 | 12 | 18 | 24 }
  | { kind: "limiter"; ceilingDb: number; releaseMs: number }
  | { kind: "param_eq"; bands: EqBand[] };

export type EqBandType =
  | "peaking"
  | "low_shelf"
  | "high_shelf"
  | "low_pass"
  | "high_pass";

export interface EqBand {
  freqHz: number;
  gainDb: number;
  q: number;
  type: EqBandType;
}

export interface GraphNode {
  id: NodeId;
  kind: NodeKind;
  /** Human label. For input/bus nodes this mirrors the backing model. */
  name: string;
  ports: Port[];
  /** Master gain on this node, UI scale 0..1. */
  gain: number;
  muted: boolean;
  /** Live peak meter, 0..1.2. Transient — never persisted. */
  level: number;
  /** Layout hint, persisted with the graph. */
  uiX: number;
  uiY: number;
}

export interface GraphEdge {
  id: EdgeId;
  fromNode: NodeId;
  fromPort: PortId;
  toNode: NodeId;
  toPort: PortId;
  /** UI scale 0..1. */
  gain: number;
  muted: boolean;
}

export interface Graph {
  nodes: Map<NodeId, GraphNode>;
  edges: Map<EdgeId, GraphEdge>;
}

/* ── Construction ────────────────────────────────────────────────────── */

export function emptyGraph(): Graph {
  return { nodes: new Map(), edges: new Map() };
}

export function cloneGraph(g: Graph): Graph {
  const nodes = new Map<NodeId, GraphNode>();
  for (const [id, n] of g.nodes) nodes.set(id, { ...n, ports: n.ports.map((p) => ({ ...p })) });
  const edges = new Map<EdgeId, GraphEdge>();
  for (const [id, e] of g.edges) edges.set(id, { ...e });
  return { nodes, edges };
}

/* ── Port templates ──────────────────────────────────────────────────── */

/**
 * Standard ports for a node of the given kind. UI nodes that need
 * sidechain or auxiliary ports build on top of these.
 */
export function defaultPortsFor(kind: NodeKind): Port[] {
  switch (kind.type) {
    case "input":
      return [{ id: "out", kind: "audio", layout: "stereo", dir: "out" }];
    case "bus":
      return [{ id: "in", kind: "audio", layout: "stereo", dir: "in" }];
    case "group":
    case "splitter":
    case "meter":
      return [
        { id: "in", kind: "audio", layout: "stereo", dir: "in" },
        { id: "out", kind: "audio", layout: "stereo", dir: "out" },
      ];
    case "fx": {
      const base: Port[] = [
        { id: "in", kind: "audio", layout: "stereo", dir: "in" },
        { id: "out", kind: "audio", layout: "stereo", dir: "out" },
      ];
      if (kind.fx.kind === "compressor") {
        base.push({ id: "sc", kind: "sidechain", layout: "stereo", dir: "in" });
      }
      return base;
    }
  }
}

/* ── Mutations ───────────────────────────────────────────────────────── */

export class GraphError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

export function addNode(g: Graph, n: GraphNode): Graph {
  if (g.nodes.has(n.id)) {
    throw new GraphError(`Duplicate node id: ${n.id}`, "DUP_NODE");
  }
  const next = cloneGraph(g);
  next.nodes.set(n.id, n);
  return next;
}

/** Remove node + every edge incident on it. */
export function removeNode(g: Graph, id: NodeId): Graph {
  const next = cloneGraph(g);
  next.nodes.delete(id);
  for (const [eid, e] of g.edges) {
    if (e.fromNode === id || e.toNode === id) next.edges.delete(eid);
  }
  return next;
}

export function findEdge(
  g: Graph,
  fromNode: NodeId,
  fromPort: PortId,
  toNode: NodeId,
  toPort: PortId,
): GraphEdge | null {
  for (const e of g.edges.values()) {
    if (
      e.fromNode === fromNode &&
      e.fromPort === fromPort &&
      e.toNode === toNode &&
      e.toPort === toPort
    ) {
      return e;
    }
  }
  return null;
}

/**
 * Add an edge. Rejects:
 *   - duplicate (same id, OR same from/to pair)
 *   - self-loop
 *   - port not found on node
 *   - port direction mismatch (fromPort must be "out", toPort must be "in")
 *   - port kind mismatch
 *   - cycle (DFS reachability check from toNode → fromNode)
 */
export function addEdge(g: Graph, e: GraphEdge): Graph {
  if (g.edges.has(e.id)) {
    throw new GraphError(`Duplicate edge id: ${e.id}`, "DUP_EDGE");
  }
  if (e.fromNode === e.toNode) {
    throw new GraphError("Self-loop not allowed", "SELF_LOOP");
  }
  const from = g.nodes.get(e.fromNode);
  const to = g.nodes.get(e.toNode);
  if (!from) throw new GraphError(`Missing fromNode: ${e.fromNode}`, "MISSING_NODE");
  if (!to) throw new GraphError(`Missing toNode: ${e.toNode}`, "MISSING_NODE");
  const fromPort = from.ports.find((p) => p.id === e.fromPort);
  const toPort = to.ports.find((p) => p.id === e.toPort);
  if (!fromPort) throw new GraphError(`Missing fromPort: ${e.fromPort}`, "MISSING_PORT");
  if (!toPort) throw new GraphError(`Missing toPort: ${e.toPort}`, "MISSING_PORT");
  if (fromPort.dir !== "out") {
    throw new GraphError(`fromPort must be out, got ${fromPort.dir}`, "PORT_DIR");
  }
  if (toPort.dir !== "in") {
    throw new GraphError(`toPort must be in, got ${toPort.dir}`, "PORT_DIR");
  }
  if (fromPort.kind !== toPort.kind) {
    throw new GraphError(
      `Port kind mismatch: ${fromPort.kind} -> ${toPort.kind}`,
      "PORT_KIND",
    );
  }
  if (findEdge(g, e.fromNode, e.fromPort, e.toNode, e.toPort)) {
    throw new GraphError("Duplicate edge between same ports", "DUP_PAIR");
  }
  // Cycle check: walk forward from e.toNode; if we can reach e.fromNode
  // through existing edges, adding this edge would close a cycle.
  if (reaches(g, e.toNode, e.fromNode)) {
    throw new GraphError("Edge would create a cycle", "CYCLE");
  }
  const next = cloneGraph(g);
  next.edges.set(e.id, e);
  return next;
}

export function removeEdge(g: Graph, id: EdgeId): Graph {
  const next = cloneGraph(g);
  next.edges.delete(id);
  return next;
}

export function updateNode(
  g: Graph,
  id: NodeId,
  patch: Partial<Omit<GraphNode, "id">>,
): Graph {
  const cur = g.nodes.get(id);
  if (!cur) throw new GraphError(`Missing node: ${id}`, "MISSING_NODE");
  const next = cloneGraph(g);
  next.nodes.set(id, { ...cur, ...patch });
  return next;
}

export function updateEdge(
  g: Graph,
  id: EdgeId,
  patch: Partial<Omit<GraphEdge, "id" | "fromNode" | "fromPort" | "toNode" | "toPort">>,
): Graph {
  const cur = g.edges.get(id);
  if (!cur) throw new GraphError(`Missing edge: ${id}`, "MISSING_EDGE");
  const next = cloneGraph(g);
  next.edges.set(id, { ...cur, ...patch });
  return next;
}

/* ── Queries ─────────────────────────────────────────────────────────── */

export function inboundEdges(g: Graph, nodeId: NodeId): GraphEdge[] {
  const out: GraphEdge[] = [];
  for (const e of g.edges.values()) if (e.toNode === nodeId) out.push(e);
  return out;
}

export function outboundEdges(g: Graph, nodeId: NodeId): GraphEdge[] {
  const out: GraphEdge[] = [];
  for (const e of g.edges.values()) if (e.fromNode === nodeId) out.push(e);
  return out;
}

/** Is `target` reachable from `start` via forward edges? */
export function reaches(g: Graph, start: NodeId, target: NodeId): boolean {
  if (start === target) return true;
  const stack: NodeId[] = [start];
  const seen = new Set<NodeId>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === target) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const e of outboundEdges(g, cur)) stack.push(e.toNode);
  }
  return false;
}

export function hasCycle(g: Graph): boolean {
  return topoSort(g) === null;
}

/**
 * Kahn's algorithm. Returns the topological order, or null if the
 * graph contains a cycle.
 */
export function topoSort(g: Graph): NodeId[] | null {
  const indegree = new Map<NodeId, number>();
  for (const id of g.nodes.keys()) indegree.set(id, 0);
  for (const e of g.edges.values()) {
    indegree.set(e.toNode, (indegree.get(e.toNode) ?? 0) + 1);
  }
  const queue: NodeId[] = [];
  for (const [id, deg] of indegree) if (deg === 0) queue.push(id);
  const order: NodeId[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of outboundEdges(g, id)) {
      const d = (indegree.get(e.toNode) ?? 0) - 1;
      indegree.set(e.toNode, d);
      if (d === 0) queue.push(e.toNode);
    }
  }
  return order.length === g.nodes.size ? order : null;
}

/* ── Node id helpers (shared with adapter for round-trip stability) ──── */

export const NODE_ID_INPUT_PREFIX = "in:";
export const NODE_ID_BUS_PREFIX = "bus:";

export function inputNodeId(inputId: string): NodeId {
  return `${NODE_ID_INPUT_PREFIX}${inputId}`;
}

export function busNodeId(busId: BusId): NodeId {
  return `${NODE_ID_BUS_PREFIX}${busId}`;
}

export function isInputNodeId(id: NodeId): boolean {
  return id.startsWith(NODE_ID_INPUT_PREFIX);
}

export function isBusNodeId(id: NodeId): boolean {
  return id.startsWith(NODE_ID_BUS_PREFIX);
}

export function inputIdFromNodeId(id: NodeId): string | null {
  return id.startsWith(NODE_ID_INPUT_PREFIX)
    ? id.slice(NODE_ID_INPUT_PREFIX.length)
    : null;
}

export function busIdFromNodeId(id: NodeId): BusId | null {
  if (!id.startsWith(NODE_ID_BUS_PREFIX)) return null;
  const raw = id.slice(NODE_ID_BUS_PREFIX.length);
  if (raw === "A1" || raw === "A2" || raw === "B1" || raw === "B2") return raw;
  return null;
}

/** Edge id for an input → bus connection. Stable across renders. */
export function bipartiteEdgeId(inputId: string, busId: BusId): EdgeId {
  return `edge:${inputId}|${busId}`;
}

/* ── Type-narrowing accessors ────────────────────────────────────────── */

export function asInputNode(n: GraphNode): { node: GraphNode; backing: AudioInput } | null {
  return n.kind.type === "input" ? { node: n, backing: n.kind.backing } : null;
}

export function asBusNode(n: GraphNode): { node: GraphNode; backing: Bus } | null {
  return n.kind.type === "bus" ? { node: n, backing: n.kind.backing } : null;
}

/* ── Re-export for adapter convenience ──────────────────────────────── */

export type { AudioInput, Bus, BusId, InputSourceKind };
