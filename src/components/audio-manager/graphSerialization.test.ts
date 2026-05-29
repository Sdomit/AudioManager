import { describe, expect, it } from "vitest";

import { busNodeId, groupNodeId, inputNodeId } from "./graph";
import type { GraphEdge } from "./graph";
import {
  GRAPH_SCHEMA_VERSION,
  parseGraph,
  parseGraphFromString,
  serializeGraph,
  serializeGraphToString,
  type GraphOverlay,
  type SerializedGraph,
} from "./graphSerialization";

function overlay(parts: Partial<GraphOverlay> = {}): GraphOverlay {
  return {
    groups: parts.groups ?? new Map(),
    localEdges: parts.localEdges ?? new Map(),
    positions: parts.positions ?? new Map(),
    viewport: parts.viewport ?? null,
  };
}

function edge(over: Partial<GraphEdge> & Pick<GraphEdge, "id" | "fromNode" | "toNode">): GraphEdge {
  return {
    fromPort: "out",
    toPort: "in",
    gain: 1,
    muted: false,
    ...over,
  };
}

describe("graphSerialization — round trip", () => {
  it("serialize → parse preserves overlay contents", () => {
    const g1 = "g1";
    const g2 = "g2";
    const e1 = edge({
      id: "e1",
      fromNode: inputNodeId("in1"),
      toNode: groupNodeId(g1),
      gain: 0.5,
      muted: false,
    });
    const e2 = edge({
      id: "e2",
      fromNode: groupNodeId(g1),
      toNode: groupNodeId(g2),
      gain: 0.75,
      muted: true,
    });
    const e3 = edge({
      id: "e3",
      fromNode: groupNodeId(g2),
      toNode: busNodeId("A1"),
      gain: 1,
      muted: false,
    });
    const src = overlay({
      groups: new Map([
        [g1, { name: "Drums" }],
        [g2, { name: "Master" }],
      ]),
      localEdges: new Map([
        [e1.id, e1],
        [e2.id, e2],
        [e3.id, e3],
      ]),
      positions: new Map([
        [inputNodeId("in1"), { x: 10, y: 20 }],
        [groupNodeId(g1), { x: 200, y: 50 }],
        [busNodeId("A1"), { x: 400, y: 100 }],
      ]),
      viewport: { tx: 10, ty: 20, zoom: 1.5 },
    });

    const result = parseGraph(serializeGraph(src));
    expect(result.warnings).toEqual([]);
    expect(result.overlay.groups).toEqual(src.groups);
    expect(result.overlay.localEdges).toEqual(src.localEdges);
    expect(result.overlay.positions).toEqual(src.positions);
    expect(result.overlay.viewport).toEqual(src.viewport);
  });
});

describe("graphSerialization — parseGraphFromString", () => {
  it("returns empty overlay + CORRUPT on invalid JSON", () => {
    const result = parseGraphFromString("not json {");
    expect(result.overlay.groups.size).toBe(0);
    expect(result.overlay.localEdges.size).toBe(0);
    expect(result.overlay.positions.size).toBe(0);
    expect(result.overlay.viewport).toBeNull();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.code).toBe("CORRUPT");
  });

  it("round-trips through serializeGraphToString", () => {
    const src = overlay({
      groups: new Map([["g1", { name: "G1" }]]),
    });
    const result = parseGraphFromString(serializeGraphToString(src));
    expect(result.warnings).toEqual([]);
    expect(result.overlay.groups.get("g1")).toEqual({ name: "G1" });
  });
});

describe("graphSerialization — validation", () => {
  it("drops duplicate group ids keeping the first", () => {
    const raw: SerializedGraph = {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      groups: [
        { id: "g1", name: "first" },
        { id: "g1", name: "second" },
      ],
      localEdges: [],
      nodePositions: {},
      viewport: null,
    };
    const result = parseGraph(raw);
    expect(result.overlay.groups.size).toBe(1);
    expect(result.overlay.groups.get("g1")).toEqual({ name: "first" });
    expect(result.warnings.some((w) => w.code === "DUP_GROUP")).toBe(true);
  });

  it("drops duplicate edge ids keeping the first", () => {
    const raw = {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      groups: [{ id: "g1", name: "g1" }],
      localEdges: [
        edge({ id: "e1", fromNode: inputNodeId("in1"), toNode: groupNodeId("g1"), gain: 0.4 }),
        edge({ id: "e1", fromNode: inputNodeId("in2"), toNode: groupNodeId("g1"), gain: 0.9 }),
      ],
      nodePositions: {},
      viewport: null,
    };
    const result = parseGraph(raw);
    expect(result.overlay.localEdges.size).toBe(1);
    expect(result.overlay.localEdges.get("e1")?.gain).toBe(0.4);
    expect(result.warnings.some((w) => w.code === "DUP_EDGE")).toBe(true);
  });

  it("drops edge with missing group endpoint", () => {
    const raw = {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      groups: [{ id: "g1", name: "g1" }],
      localEdges: [
        edge({ id: "e1", fromNode: groupNodeId("g1"), toNode: groupNodeId("ghost") }),
      ],
      nodePositions: {},
      viewport: null,
    };
    const result = parseGraph(raw);
    expect(result.overlay.localEdges.size).toBe(0);
    expect(result.warnings.some((w) => w.code === "EDGE_MISSING_NODE")).toBe(true);
  });

  it("keeps edges with input/bus endpoints (live backend validates later)", () => {
    const raw = {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      groups: [{ id: "g1", name: "g1" }],
      localEdges: [
        edge({ id: "e1", fromNode: inputNodeId("in1"), toNode: groupNodeId("g1") }),
        edge({ id: "e2", fromNode: groupNodeId("g1"), toNode: busNodeId("A1") }),
      ],
      nodePositions: {},
      viewport: null,
    };
    const result = parseGraph(raw);
    expect(result.overlay.localEdges.size).toBe(2);
    expect(
      result.warnings.filter((w) => w.code === "EDGE_MISSING_NODE"),
    ).toHaveLength(0);
  });

  it("drops edge with invalid port direction", () => {
    const raw = {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      groups: [{ id: "g1", name: "g1" }],
      localEdges: [
        {
          id: "e1",
          fromNode: groupNodeId("g1"),
          toNode: busNodeId("A1"),
          fromPort: "in",
          toPort: "in",
          gain: 1,
          muted: false,
        },
      ],
      nodePositions: {},
      viewport: null,
    };
    const result = parseGraph(raw);
    expect(result.overlay.localEdges.size).toBe(0);
    expect(result.warnings.some((w) => w.code === "BAD_EDGE")).toBe(true);
  });

  it("drops positions with non-finite coordinates", () => {
    const raw = {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      groups: [],
      localEdges: [],
      nodePositions: {
        [inputNodeId("in1")]: { x: 10, y: 20 },
        [inputNodeId("in2")]: { x: Number.NaN, y: 0 },
        [inputNodeId("in3")]: { x: 1, y: "5" },
      },
      viewport: null,
    };
    const result = parseGraph(raw);
    expect(result.overlay.positions.size).toBe(1);
    expect(result.overlay.positions.get(inputNodeId("in1"))).toEqual({ x: 10, y: 20 });
    expect(result.warnings.filter((w) => w.code === "BAD_POSITION")).toHaveLength(2);
  });

  it("nulls out invalid viewport", () => {
    const raw = {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      groups: [],
      localEdges: [],
      nodePositions: {},
      viewport: { tx: 0, ty: 0, zoom: -1 },
    };
    const result = parseGraph(raw);
    expect(result.overlay.viewport).toBeNull();
    expect(result.warnings.some((w) => w.code === "BAD_VIEWPORT")).toBe(true);
  });

  it("returns empty overlay when schemaVersion is too new", () => {
    const raw = {
      schemaVersion: GRAPH_SCHEMA_VERSION + 99,
      groups: [{ id: "g1", name: "should be ignored" }],
      localEdges: [],
      nodePositions: {},
      viewport: null,
    };
    const result = parseGraph(raw);
    expect(result.overlay.groups.size).toBe(0);
    expect(result.overlay.localEdges.size).toBe(0);
    expect(result.warnings.some((w) => w.code === "VERSION_TOO_NEW")).toBe(true);
  });

  it("ignores unknown top-level fields, preserves known ones", () => {
    const raw = {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      groups: [{ id: "g1", name: "g1" }],
      localEdges: [],
      nodePositions: {},
      viewport: null,
      mysteryField: { hello: "world" },
      anotherOne: 42,
    };
    const result = parseGraph(raw);
    expect(result.overlay.groups.get("g1")).toEqual({ name: "g1" });
    expect(result.warnings).toEqual([]);
  });

  it("defaults gain to 1 and muted to false when omitted", () => {
    const raw = {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      groups: [{ id: "g1", name: "g1" }],
      localEdges: [
        {
          id: "e1",
          fromNode: inputNodeId("in1"),
          toNode: groupNodeId("g1"),
          fromPort: "out",
          toPort: "in",
        },
      ],
      nodePositions: {},
      viewport: null,
    };
    const result = parseGraph(raw);
    const e = result.overlay.localEdges.get("e1");
    expect(e?.gain).toBe(1);
    expect(e?.muted).toBe(false);
  });
});

describe("graphSerialization — backend send guard", () => {
  it("serializeGraph drops pure input→bus edges from the output", () => {
    const sendEdge = edge({
      id: "edge:in1|A1",
      fromNode: inputNodeId("in1"),
      toNode: busNodeId("A1"),
    });
    const keepEdge = edge({
      id: "edge:in1|g1",
      fromNode: inputNodeId("in1"),
      toNode: groupNodeId("g1"),
    });
    const src = overlay({
      groups: new Map([["g1", { name: "g1" }]]),
      localEdges: new Map([
        [sendEdge.id, sendEdge],
        [keepEdge.id, keepEdge],
      ]),
    });
    const out = serializeGraph(src);
    expect(out.localEdges.map((e) => e.id)).toEqual(["edge:in1|g1"]);
  });

  it("parseGraph drops input→bus edges with BACKEND_SEND_EDGE warning", () => {
    const raw: SerializedGraph = {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      groups: [],
      localEdges: [
        edge({
          id: "edge:in1|A1",
          fromNode: inputNodeId("in1"),
          toNode: busNodeId("A1"),
        }),
      ],
      nodePositions: {},
      viewport: null,
    };
    const result = parseGraph(raw);
    expect(result.overlay.localEdges.size).toBe(0);
    expect(result.warnings.some((w) => w.code === "BACKEND_SEND_EDGE")).toBe(true);
  });
});
