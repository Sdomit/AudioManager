import { describe, expect, it } from "vitest";

import { busNodeId, groupNodeId, inputNodeId } from "./graph";
import type { GraphEdge } from "./graph";
import type { GroupMeta, NodePos, Viewport } from "./graphSerialization";
import {
  clearPositions,
  DEFAULT_VIEWPORT,
  loadOverlay,
  LS_GROUPS,
  LS_LEGACY_BUS_POSITIONS,
  LS_LEGACY_INPUT_POSITIONS,
  LS_LOCAL_EDGES,
  LS_NODE_POSITIONS,
  LS_VIEWPORT,
  saveGroups,
  saveLocalEdges,
  savePositions,
  saveViewport,
  type GraphStorageLike,
} from "./graphStorage";

function makeStorage(init: Record<string, string> = {}): GraphStorageLike {
  const m = new Map<string, string>(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

function edge(
  over: Partial<GraphEdge> & Pick<GraphEdge, "id" | "fromNode" | "toNode">,
): GraphEdge {
  return { fromPort: "out", toPort: "in", gain: 1, muted: false, ...over };
}

/** Encode a Map the way NodeView persists it (entry-tuple array). */
function entriesJSON<K, V>(m: Map<K, V>): string {
  return JSON.stringify(Array.from(m.entries()));
}

describe("graphStorage — loadOverlay (valid legacy data)", () => {
  it("reads groups, localEdges, positions, and viewport", () => {
    const groups = new Map<string, GroupMeta>([["g1", { name: "Drums" }]]);
    const e1 = edge({ id: "e1", fromNode: inputNodeId("in1"), toNode: groupNodeId("g1"), gain: 0.5 });
    const edges = new Map<string, GraphEdge>([["e1", e1]]);
    const positions = new Map<string, NodePos>([
      [inputNodeId("in1"), { x: 10, y: 20 }],
      [groupNodeId("g1"), { x: 200, y: 50 }],
    ]);
    const viewport: Viewport = { tx: 5, ty: 6, zoom: 1.5 };

    const storage = makeStorage({
      [LS_GROUPS]: entriesJSON(groups),
      [LS_LOCAL_EDGES]: entriesJSON(edges),
      [LS_NODE_POSITIONS]: entriesJSON(positions),
      [LS_VIEWPORT]: JSON.stringify(viewport),
    });

    const { overlay } = loadOverlay(storage);
    expect(overlay.groups.get("g1")).toEqual({ name: "Drums" });
    expect(overlay.localEdges.get("e1")).toEqual(e1);
    expect(overlay.positions.get(inputNodeId("in1"))).toEqual({ x: 10, y: 20 });
    expect(overlay.positions.get(groupNodeId("g1"))).toEqual({ x: 200, y: 50 });
    expect(overlay.viewport).toEqual(viewport);
  });
});

describe("graphStorage — writers preserve exact legacy byte format", () => {
  it("saveGroups writes JSON.stringify(Array.from(entries))", () => {
    const storage = makeStorage();
    const groups = new Map<string, GroupMeta>([
      ["g1", { name: "A" }],
      ["g2", { name: "B" }],
    ]);
    saveGroups(storage, groups);
    expect(storage.getItem(LS_GROUPS)).toBe(JSON.stringify(Array.from(groups.entries())));
  });

  it("saveLocalEdges writes JSON.stringify(Array.from(entries))", () => {
    const storage = makeStorage();
    const e1 = edge({ id: "e1", fromNode: groupNodeId("g1"), toNode: busNodeId("A1"), gain: 0.75 });
    const edges = new Map<string, GraphEdge>([["e1", e1]]);
    saveLocalEdges(storage, edges);
    expect(storage.getItem(LS_LOCAL_EDGES)).toBe(JSON.stringify(Array.from(edges.entries())));
  });

  it("savePositions writes JSON.stringify(Array.from(entries))", () => {
    const storage = makeStorage();
    const positions = new Map<string, NodePos>([
      [inputNodeId("in1"), { x: 1, y: 2 }],
      [busNodeId("A1"), { x: 3, y: 4 }],
    ]);
    savePositions(storage, positions);
    expect(storage.getItem(LS_NODE_POSITIONS)).toBe(
      JSON.stringify(Array.from(positions.entries())),
    );
  });

  it("saveViewport writes JSON.stringify(viewport) with tx,ty,zoom key order", () => {
    const storage = makeStorage();
    const viewport: Viewport = { tx: 1, ty: 2, zoom: 3 };
    saveViewport(storage, viewport);
    expect(storage.getItem(LS_VIEWPORT)).toBe(JSON.stringify(viewport));
    expect(storage.getItem(LS_VIEWPORT)).toBe('{"tx":1,"ty":2,"zoom":3}');
  });
});

describe("graphStorage — viewport parity", () => {
  it("returns DEFAULT_VIEWPORT when viewport key is missing", () => {
    const { overlay } = loadOverlay(makeStorage());
    expect(overlay.viewport).toEqual(DEFAULT_VIEWPORT);
    expect(overlay.viewport).toEqual({ tx: 0, ty: 0, zoom: 1 });
  });

  it("returns DEFAULT_VIEWPORT when viewport zoom is invalid (<= 0)", () => {
    const storage = makeStorage({ [LS_VIEWPORT]: JSON.stringify({ tx: 0, ty: 0, zoom: -1 }) });
    expect(loadOverlay(storage).overlay.viewport).toEqual(DEFAULT_VIEWPORT);
  });

  it("returns DEFAULT_VIEWPORT when viewport JSON is corrupt", () => {
    const storage = makeStorage({ [LS_VIEWPORT]: "not json {" });
    expect(loadOverlay(storage).overlay.viewport).toEqual(DEFAULT_VIEWPORT);
  });

  it("clamps zoom into [0.25, 4]", () => {
    const hi = makeStorage({ [LS_VIEWPORT]: JSON.stringify({ tx: 0, ty: 0, zoom: 999 }) });
    expect(loadOverlay(hi).overlay.viewport?.zoom).toBe(4);
    const lo = makeStorage({ [LS_VIEWPORT]: JSON.stringify({ tx: 0, ty: 0, zoom: 0.01 }) });
    expect(loadOverlay(lo).overlay.viewport?.zoom).toBe(0.25);
  });
});

describe("graphStorage — resilience", () => {
  it("corrupt JSON in one key does not crash and preserves other slices", () => {
    const positions = new Map<string, NodePos>([[inputNodeId("in1"), { x: 7, y: 8 }]]);
    const storage = makeStorage({
      [LS_GROUPS]: "{ corrupt json",
      [LS_NODE_POSITIONS]: entriesJSON(positions),
    });
    const { overlay } = loadOverlay(storage);
    expect(overlay.groups.size).toBe(0);
    expect(overlay.positions.get(inputNodeId("in1"))).toEqual({ x: 7, y: 8 });
  });
});

describe("graphStorage — legacy split position migration", () => {
  it("migrates split keys to in:/bus: NodeIds when v2 is absent", () => {
    const storage = makeStorage({
      [LS_LEGACY_INPUT_POSITIONS]: JSON.stringify([["in1", { x: 1, y: 2 }]]),
      [LS_LEGACY_BUS_POSITIONS]: JSON.stringify([["A1", { x: 3, y: 4 }]]),
    });
    const { overlay } = loadOverlay(storage);
    expect(overlay.positions.get(inputNodeId("in1"))).toEqual({ x: 1, y: 2 });
    expect(overlay.positions.get(busNodeId("A1"))).toEqual({ x: 3, y: 4 });
  });

  it("prefers v2 over split legacy keys when both exist", () => {
    const v2 = new Map<string, NodePos>([[inputNodeId("inX"), { x: 9, y: 9 }]]);
    const storage = makeStorage({
      [LS_NODE_POSITIONS]: entriesJSON(v2),
      [LS_LEGACY_INPUT_POSITIONS]: JSON.stringify([["inY", { x: 1, y: 1 }]]),
    });
    const { overlay } = loadOverlay(storage);
    expect(overlay.positions.get(inputNodeId("inX"))).toEqual({ x: 9, y: 9 });
    expect(overlay.positions.has(inputNodeId("inY"))).toBe(false);
  });
});

describe("graphStorage — backend send guard", () => {
  it("drops a stray input->bus local edge with a BACKEND_SEND_EDGE warning", () => {
    const sendEdge = edge({
      id: "edge:in1|A1",
      fromNode: inputNodeId("in1"),
      toNode: busNodeId("A1"),
    });
    const storage = makeStorage({
      [LS_LOCAL_EDGES]: entriesJSON(new Map([[sendEdge.id, sendEdge]])),
    });
    const { overlay, warnings } = loadOverlay(storage);
    expect(overlay.localEdges.size).toBe(0);
    expect(warnings.some((w) => w.code === "BACKEND_SEND_EDGE")).toBe(true);
  });
});

describe("graphStorage — clearPositions", () => {
  it("removes only LS_NODE_POSITIONS, leaving every other key intact", () => {
    const storage = makeStorage({
      [LS_NODE_POSITIONS]: entriesJSON(new Map([[inputNodeId("in1"), { x: 1, y: 1 }]])),
      [LS_GROUPS]: entriesJSON(new Map([["g1", { name: "g1" }]])),
      [LS_LOCAL_EDGES]: entriesJSON(new Map<string, GraphEdge>()),
      [LS_VIEWPORT]: JSON.stringify({ tx: 1, ty: 2, zoom: 1 }),
      [LS_LEGACY_INPUT_POSITIONS]: JSON.stringify([["in1", { x: 1, y: 2 }]]),
      [LS_LEGACY_BUS_POSITIONS]: JSON.stringify([["A1", { x: 3, y: 4 }]]),
    });
    clearPositions(storage);
    expect(storage.getItem(LS_NODE_POSITIONS)).toBeNull();
    expect(storage.getItem(LS_GROUPS)).not.toBeNull();
    expect(storage.getItem(LS_LOCAL_EDGES)).not.toBeNull();
    expect(storage.getItem(LS_VIEWPORT)).not.toBeNull();
    expect(storage.getItem(LS_LEGACY_INPUT_POSITIONS)).not.toBeNull();
    expect(storage.getItem(LS_LEGACY_BUS_POSITIONS)).not.toBeNull();
  });
});
