/**
 * Bidirectional adapter between the bipartite UI model
 * ({buses, inputs, sends}) and the generalized DAG model (graph.ts).
 *
 * G-1 scope: lossless round-trip for input/bus nodes and enabled sends.
 * Disabled sends are dropped (the current UI model never persists them).
 * Group/Fx/Meter nodes have no bipartite representation and are dropped
 * in `graphToBipartite` (with a warning hook for callers that care).
 */

import type { AudioInput, Bus, Send } from "./types";
import {
  type Graph,
  type GraphEdge,
  type GraphNode,
  bipartiteEdgeId,
  busIdFromNodeId,
  busNodeId,
  defaultPortsFor,
  emptyGraph,
  inputIdFromNodeId,
  inputNodeId,
  isBusNodeId,
  isInputNodeId,
} from "./graph";

const INPUT_COL_X = 14;
const BUS_COL_X = 14 + 200 + 160;
const INPUT_ROW_H = 52 + 6;
const BUS_ROW_H = 80 + 10;
const COL_PAD = 14;

export interface AdapterWarning {
  code: "DROPPED_NODE" | "DROPPED_EDGE" | "MISSING_BACKING";
  detail: string;
}

export interface AdapterResult<T> {
  value: T;
  warnings: AdapterWarning[];
}

/**
 * Bipartite UI state → generalized graph.
 *
 * Layout: input nodes get a left column, bus nodes a right column. The
 * NodeView component overrides these from its own localStorage layout
 * once it consumes the graph model.
 */
export function bipartiteToGraph(
  buses: Bus[],
  inputs: AudioInput[],
  sends: Send[],
): Graph {
  let g = emptyGraph();

  inputs.forEach((input, i) => {
    const kind = { type: "input" as const, backing: input };
    const node: GraphNode = {
      id: inputNodeId(input.id),
      kind,
      name: input.name,
      ports: defaultPortsFor(kind),
      gain: input.gain,
      muted: input.muted,
      level: input.level,
      uiX: INPUT_COL_X,
      uiY: COL_PAD + i * INPUT_ROW_H,
    };
    g.nodes.set(node.id, node);
  });

  buses.forEach((bus, i) => {
    const kind = { type: "bus" as const, backing: bus };
    const node: GraphNode = {
      id: busNodeId(bus.id),
      kind,
      name: bus.label,
      ports: defaultPortsFor(kind),
      gain: bus.volume,
      muted: bus.muted,
      level: bus.level,
      uiX: BUS_COL_X,
      uiY: COL_PAD + i * BUS_ROW_H,
    };
    g.nodes.set(node.id, node);
  });

  for (const s of sends) {
    if (!s.enabled) continue;
    if (!g.nodes.has(inputNodeId(s.inputId))) continue;
    if (!g.nodes.has(busNodeId(s.busId))) continue;
    const edge: GraphEdge = {
      id: bipartiteEdgeId(s.inputId, s.busId),
      fromNode: inputNodeId(s.inputId),
      fromPort: "out",
      toNode: busNodeId(s.busId),
      toPort: "in",
      gain: s.gain,
      muted: s.muted,
    };
    g.edges.set(edge.id, edge);
  }

  return g;
}

/**
 * Generalized graph → bipartite UI state.
 *
 * Drops anything outside the bipartite model (group/fx/meter nodes,
 * edges between non-input/non-bus pairs). Callers can inspect the
 * warnings list to decide whether to surface the lossy conversion.
 */
export function graphToBipartite(g: Graph): AdapterResult<{
  buses: Bus[];
  inputs: AudioInput[];
  sends: Send[];
}> {
  const warnings: AdapterWarning[] = [];
  const inputs: AudioInput[] = [];
  const buses: Bus[] = [];

  for (const node of g.nodes.values()) {
    if (node.kind.type === "input") {
      inputs.push({
        ...node.kind.backing,
        name: node.name,
        gain: node.gain,
        muted: node.muted,
        level: node.level,
      });
    } else if (node.kind.type === "bus") {
      buses.push({
        ...node.kind.backing,
        label: node.name,
        volume: node.gain,
        muted: node.muted,
        level: node.level,
      });
    } else {
      warnings.push({
        code: "DROPPED_NODE",
        detail: `Non-bipartite node dropped: ${node.id} (${node.kind.type})`,
      });
    }
  }

  const sends: Send[] = [];
  for (const e of g.edges.values()) {
    const inputId = inputIdFromNodeId(e.fromNode);
    const busId = busIdFromNodeId(e.toNode);
    if (inputId == null || busId == null) {
      warnings.push({
        code: "DROPPED_EDGE",
        detail: `Non-bipartite edge dropped: ${e.id}`,
      });
      continue;
    }
    if (e.fromPort !== "out" || e.toPort !== "in") {
      warnings.push({
        code: "DROPPED_EDGE",
        detail: `Non-default-port edge dropped: ${e.id} (${e.fromPort}->${e.toPort})`,
      });
      continue;
    }
    sends.push({
      inputId,
      busId,
      enabled: true,
      gain: e.gain,
      muted: e.muted,
    });
  }

  return { value: { buses, inputs, sends }, warnings };
}

/**
 * Walk a graph and return any edges that touch non-bipartite ports
 * or non-input/non-bus nodes. Useful for telling the user "you have
 * 3 FX nodes that the current backend can't run yet".
 */
export function nonBipartiteCount(g: Graph): { nodes: number; edges: number } {
  let n = 0;
  let edges = 0;
  for (const node of g.nodes.values()) {
    if (node.kind.type !== "input" && node.kind.type !== "bus") n++;
  }
  for (const e of g.edges.values()) {
    const fromOk = isInputNodeId(e.fromNode);
    const toOk = isBusNodeId(e.toNode);
    if (!fromOk || !toOk) edges++;
  }
  return { nodes: n, edges };
}
