import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  iconForBusRole,
  iconForKind,
  MuteIcon,
  RecordIcon,
  XIcon,
} from "./Icon";
import { findRecording } from "./RecordButton";
import type {
  ActiveRecording,
  AudioInput,
  Bus,
  BusId,
  DetailSelection,
  DspConfig,
  EqConfig,
  LimiterConfig,
  Send,
  TapSpec,
} from "./types";
import {
  NodeFxPopover,
  countBusFx,
  countInputFx,
  type NodeFxTarget,
} from "./NodeFxPopover";
import { gainToDb } from "./units";
import { bipartiteToGraph } from "./graphAdapter";
import {
  addEdge as graphAddEdge,
  addNode as graphAddNode,
  asBusNode,
  asInputNode,
  busIdFromNodeId,
  busNodeId,
  defaultPortsFor,
  GraphError,
  groupIdFromNodeId,
  groupNodeId,
  inputIdFromNodeId,
  inputNodeId,
  isBusNodeId,
  isGroupNodeId,
  isInputNodeId,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type NodeId,
} from "./graph";
import { isBusId } from "./adapters";
import styles from "./NodeView.module.css";

/**
 * Node-graph routing view.
 *
 * Inputs are nodes on the left; buses are nodes on the right. Bezier
 * wires connect (input → bus) for every enabled send. Drag from an
 * input's output port to a bus's input port to create a send; click a
 * wire to select it and edit its gain.
 *
 * Wire color  = bus accent color
 * Wire weight = max(2, send.gain * 6) — trimmed sends look thinner
 * Active flow = marching-dash animation modulated by the input level
 */

interface NodeViewProps {
  buses: Bus[];
  inputs: AudioInput[];
  sends: Send[];
  selection: DetailSelection;
  activeRecordings: ActiveRecording[];
  onToggleSend: (inputId: string, busId: BusId) => void;
  onSendGainChange: (inputId: string, busId: BusId, v: number) => void;
  onSendMuted: (inputId: string, busId: BusId, muted: boolean) => void;
  onSelectInput: (id: string) => void;
  onSelectBus: (id: BusId) => void;
  onStartRecording: (spec: TapSpec) => void;
  onStopRecording: (id: string) => void;
  /**
   * Open the add-input device picker. NodeView is the routing view
   * that hides the side InputList; without this affordance, users
   * stuck in node view have no way to add a new input.
   */
  onAddInput?: () => void;
  /**
   * Remove an input. Used by the multi-select Del shortcut.
   * Buses are not removable here (4 fixed buses).
   */
  onRemoveInput?: (id: string) => void;
  onInputGainChange: (id: string, v: number) => void;
  onBusVolumeChange: (id: BusId, v: number) => void;
  /** Per-input DSP chain edit (denoise/HPF/gate/EQ/comp/limiter). */
  onInputDsp: (id: string, dsp: DspConfig) => void;
  /** Per-bus EQ edit. */
  onBusEq: (id: BusId, eq: EqConfig) => void;
  /** Per-bus limiter edit. */
  onBusLimiter: (id: BusId, limiter: LimiterConfig) => void;
}

interface MarqueeState {
  startX: number;
  startY: number;
  curX: number;
  curY: number;
}

// ── Geometry constants ────────────────────────────────────────────────────
const INPUT_W = 200;
const INPUT_H = 52;
const INPUT_GAP = 6;
const BUS_W = 200;
const BUS_H = 80;
const BUS_GAP = 10;
const GROUP_W = 180;
const GROUP_H = 56;
const COL_PAD = 18;
const COL_GAP_BETWEEN = 200; // horizontal space between input column and bus column for wires
const MIN_CANVAS_W = COL_PAD + INPUT_W + COL_GAP_BETWEEN + BUS_W + COL_PAD;
const MIN_CANVAS_H = 300;

interface DragState {
  /**
   * Graph NodeId of the source. Drives validation and tooltip plumbing.
   * For input sources this is `inputNodeId(fromInputId)`; for group
   * sources this is `groupNodeId(fromGroupId)`.
   */
  fromNodeId: NodeId;
  /**
   * Backing input id when the source is an input node. Empty string
   * when the source is a group node. Kept so the bipartite mouseup
   * path (which calls onToggleSend) doesn't need to re-parse.
   */
  fromInputId: string;
  startX: number;
  startY: number;
  curX: number;
  curY: number;
  /** Bus drop target. Null when nothing is hovered or hovering a group. */
  hoverBusId: BusId | null;
  /** Group drop target. Null when nothing is hovered or hovering a bus. */
  hoverGroupId: string | null;
  /**
   * True if the candidate edge would be accepted by the generalized
   * graph (no cycle, ports compatible, no duplicate). Drives ghost-wire
   * color and is checked on mouseup before firing onToggleSend so
   * invalid drops are silently rejected.
   */
  dropOk: boolean;
  /**
   * Human-readable explanation when dropOk=false. Shown near the cursor
   * as a tooltip so the user can see why their drop will be rejected.
   * Null when dropOk=true.
   */
  dropReason: string | null;
}

/** Map GraphError.code to a short human label for the drop tooltip. */
function dropReasonFor(code: string): string {
  switch (code) {
    case "CYCLE":         return "Would create a cycle";
    case "SELF_LOOP":     return "Cannot connect to itself";
    case "PORT_KIND":     return "Incompatible port type";
    case "PORT_DIR":      return "Wrong port direction";
    case "MISSING_PORT":  return "Port not found";
    case "MISSING_NODE":  return "Node not found";
    default:              return "Invalid connection";
  }
}

interface NodeDragState {
  kind: "input" | "bus" | "group";
  id: string;
  startMouseX: number;
  startMouseY: number;
  startNodeX: number;
  startNodeY: number;
  moved: boolean;
  /**
   * Starting positions of ALL selected nodes (group drag), keyed by
   * graph NodeId. Single-node drags use a one-entry map.
   */
  groupStart: Map<NodeId, NodePos>;
}

type NodePos = { x: number; y: number };

interface Viewport { tx: number; ty: number; zoom: number; }
interface PanState {
  startClientX: number;
  startClientY: number;
  startTx: number;
  startTy: number;
}

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

// ── Layout helpers ────────────────────────────────────────────────────
// Node footprint by graph NodeId kind. Centralizes the size lookup that
// the clamp / drag / placement paths used to each duplicate inline.
function nodeWidth(nid: NodeId): number {
  return isInputNodeId(nid) ? INPUT_W : isBusNodeId(nid) ? BUS_W : GROUP_W;
}
function nodeHeight(nid: NodeId): number {
  return isInputNodeId(nid) ? INPUT_H : isBusNodeId(nid) ? BUS_H : GROUP_H;
}

// Clamp a node's top-left so the whole node stays inside [0, bound-size].
function clampToBounds(
  x: number,
  y: number,
  w: number,
  h: number,
  bw: number,
  bh: number,
): NodePos {
  const maxX = Math.max(0, bw - w);
  const maxY = Math.max(0, bh - h);
  return { x: Math.min(maxX, Math.max(0, x)), y: Math.min(maxY, Math.max(0, y)) };
}

// Bus column x: sit at a comfortable, readable distance from the input
// column rather than pinned to the far right edge (which left a large
// dead gap in the middle on wide canvases). Never overflow the canvas.
function busColumnXFor(boundsW: number): number {
  return Math.min(boundsW - BUS_W - COL_PAD, COL_PAD + INPUT_W + COL_GAP_BETWEEN);
}

// Keep the (canvasW × canvasH) world box within the visible viewport.
// Nodes are always clamped inside the box, so a visible box guarantees
// every node stays on screen. When the box is smaller than the viewport
// (zoomed out) it is centered; otherwise panning is bounded so the box
// edges can never pull away from the viewport edges.
function clampView(
  v: Viewport,
  canvasW: number,
  canvasH: number,
  viewW: number,
  viewH: number,
): Viewport {
  const clampAxis = (t: number, content: number, viewport: number) => {
    if (content <= viewport) return (viewport - content) / 2;
    return Math.min(0, Math.max(viewport - content, t));
  };
  return {
    zoom: v.zoom,
    tx: clampAxis(v.tx, canvasW * v.zoom, viewW),
    ty: clampAxis(v.ty, canvasH * v.zoom, viewH),
  };
}

/** Pixel width of a node by kind. Used for port/wire endpoint maths. */
function nodeWidthFor(n: GraphNode): number {
  switch (n.kind.type) {
    case "input":  return INPUT_W;
    case "bus":    return BUS_W;
    case "group":  return GROUP_W;
    default:       return GROUP_W;
  }
}
function nodeHeightFor(n: GraphNode): number {
  switch (n.kind.type) {
    case "input":  return INPUT_H;
    case "bus":    return BUS_H;
    case "group":  return GROUP_H;
    default:       return GROUP_H;
  }
}

const LS_NODES_V2     = "am.nodePositions.v2";
const LS_INPUTS_LEGACY = "am.nodePositions.inputs";
const LS_BUSES_LEGACY  = "am.nodePositions.buses";
const LS_VIEW          = "am.nodeView.viewport";
const LS_GROUPS        = "am.nodeGroups.v1";
const LS_LOCAL_EDGES   = "am.nodeLocalEdges.v1";

/**
 * Load unified node positions. Reads the v2 key first; if absent and
 * the legacy split keys exist, migrates them in-place (prefix input ids
 * with `in:` and bus ids with `bus:`) and writes v2.
 */
function loadNodePositions(): Map<NodeId, NodePos> {
  try {
    const raw = localStorage.getItem(LS_NODES_V2);
    if (raw) {
      const arr = JSON.parse(raw) as Array<[NodeId, NodePos]>;
      return new Map(arr);
    }
  } catch {}
  const next = new Map<NodeId, NodePos>();
  try {
    const inRaw = localStorage.getItem(LS_INPUTS_LEGACY);
    if (inRaw) {
      const arr = JSON.parse(inRaw) as Array<[string, NodePos]>;
      for (const [id, p] of arr) next.set(inputNodeId(id), p);
    }
    const busRaw = localStorage.getItem(LS_BUSES_LEGACY);
    if (busRaw) {
      const arr = JSON.parse(busRaw) as Array<[string, NodePos]>;
      for (const [id, p] of arr) {
        if (isBusId(id)) {
          next.set(busNodeId(id), p);
        }
      }
    }
    if (next.size > 0) {
      localStorage.setItem(LS_NODES_V2, JSON.stringify(Array.from(next.entries())));
    }
  } catch {}
  return next;
}

function saveNodePositions(m: Map<NodeId, NodePos>): void {
  try {
    localStorage.setItem(LS_NODES_V2, JSON.stringify(Array.from(m.entries())));
  } catch {}
}

/** Frontend-only group node metadata. Position lives in nodePositions. */
interface GroupMeta { name: string; }

function loadGroups(): Map<string, GroupMeta> {
  try {
    const raw = localStorage.getItem(LS_GROUPS);
    if (raw) {
      const arr = JSON.parse(raw) as Array<[string, GroupMeta]>;
      return new Map(arr);
    }
  } catch {}
  return new Map();
}

function loadLocalEdges(): Map<string, GraphEdge> {
  try {
    const raw = localStorage.getItem(LS_LOCAL_EDGES);
    if (raw) {
      const arr = JSON.parse(raw) as Array<[string, GraphEdge]>;
      return new Map(arr);
    }
  } catch {}
  return new Map();
}

/**
 * Monotonic counter ensures sub-millisecond Add Group clicks produce
 * distinct ids. `Date.now()` alone collides when the handler fires
 * twice inside one event-loop tick (rapid double-click, programmatic
 * batch). Counter is module-scoped so all NodeView instances share it.
 */
let groupIdCounter = 0;

function nextGroupId(): string {
  groupIdCounter += 1;
  return `g_${Date.now().toString(36)}_${groupIdCounter.toString(36)}`;
}

export function NodeView({
  buses,
  inputs,
  sends,
  selection,
  activeRecordings,
  onToggleSend,
  onSendGainChange,
  onSendMuted,
  onSelectInput,
  onSelectBus,
  onStartRecording,
  onStopRecording,
  onAddInput,
  onRemoveInput,
  onInputGainChange,
  onBusVolumeChange,
  onInputDsp,
  onBusEq,
  onBusLimiter,
}: NodeViewProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // Open node FX editor (anchored at the click). Null when closed.
  const [openFx, setOpenFx] = useState<NodeFxTarget | null>(null);
  const openInputFx = useCallback((id: string, e: React.MouseEvent) => {
    // Screen coords (popover is position:fixed), clamped so it stays on-screen.
    const x = Math.min(Math.max(8, e.clientX - 150), window.innerWidth - 320);
    const y = Math.min(Math.max(8, e.clientY), window.innerHeight - 200);
    setOpenFx({ kind: "input", id, x, y });
  }, []);
  const openBusFx = useCallback((id: BusId, e: React.MouseEvent) => {
    const x = Math.min(Math.max(8, e.clientX - 150), window.innerWidth - 320);
    const y = Math.min(Math.max(8, e.clientY), window.innerHeight - 200);
    setOpenFx({ kind: "bus", id, x, y });
  }, []);
  const boundsRef = useRef<{ w: number; h: number }>({ w: MIN_CANVAS_W, h: MIN_CANVAS_H });
  const [wrapSize, setWrapSize] = useState<{ w: number; h: number }>({
    w: MIN_CANVAS_W,
    h: MIN_CANVAS_H,
  });
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const w = Math.max(0, Math.floor(el.clientWidth));
      const h = Math.max(0, Math.floor(el.clientHeight));
      setWrapSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [drag, setDrag] = useState<DragState | null>(null);
  // Mirror `drag` in a ref so the mouseup handler can read the latest
  // state without invoking the React state-updater (see onUp below).
  const dragRef = useRef<DragState | null>(null);
  useEffect(() => { dragRef.current = drag; }, [drag]);
  const [nodeDrag, setNodeDrag] = useState<NodeDragState | null>(null);
  const [hoverInput, setHoverInput] = useState<string | null>(null);
  const [hoverBus, setHoverBus] = useState<BusId | null>(null);
  const [hoverWire, setHoverWire] = useState<string | null>(null);

  // Right-click context menu (background of the node canvas).
  const [bgCtx, setBgCtx] = useState<{ x: number; y: number } | null>(null);
  const [selectedWire, setSelectedWire] = useState<string | null>(null);

  // ── Multi-selection (shift+click, marquee) ───────────────────────────
  const [selInputs, setSelInputs] = useState<Set<string>>(() => new Set());
  const [selBuses, setSelBuses] = useState<Set<BusId>>(() => new Set());
  const selInputsRef = useRef(selInputs);
  const selBusesRef = useRef(selBuses);
  useEffect(() => { selInputsRef.current = selInputs; }, [selInputs]);
  useEffect(() => { selBusesRef.current = selBuses; }, [selBuses]);
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);
  // Mirror marquee in a ref so mouseup can read the latest rect without
  // going through the React state-updater (which double-fires under
  // StrictMode and would also double-fire any side effects inside it).
  const marqueeRef = useRef<MarqueeState | null>(null);
  useEffect(() => { marqueeRef.current = marquee; }, [marquee]);

  const clearMultiSelect = useCallback(() => {
    setSelInputs((s) => (s.size === 0 ? s : new Set()));
    setSelBuses((s) => (s.size === 0 ? s : new Set()));
  }, []);

  // Shift+click toggles multi-select; the synthetic click that follows
  // mouseup must NOT fall through to the single-focus path.
  const suppressNextClick = useRef(false);

  // ── Viewport (pan + zoom) ────────────────────────────────────────────
  const [view, setView] = useState<Viewport>(() => {
    try {
      const raw = localStorage.getItem(LS_VIEW);
      if (raw) {
        const v = JSON.parse(raw);
        if (typeof v.tx === "number" && typeof v.ty === "number" && typeof v.zoom === "number") {
          return { tx: v.tx, ty: v.ty, zoom: clampZoom(v.zoom) };
        }
      }
    } catch {}
    return { tx: 0, ty: 0, zoom: 1 };
  });
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
    try { localStorage.setItem(LS_VIEW, JSON.stringify(view)); } catch {}
  }, [view]);

  const [panning, setPanning] = useState<PanState | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);

  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const v = viewRef.current;
    return {
      x: (clientX - rect.left - v.tx) / v.zoom,
      y: (clientY - rect.top - v.ty) / v.zoom,
    };
  }, []);

  // Clamp a viewport against the current bounds + live wrap size. Bounds
  // (boundsRef) track the world box; the wrap element gives the on-screen
  // viewport size. Used by every pan/zoom/reset path.
  const clampViewToBounds = useCallback((v: Viewport): Viewport => {
    const el = wrapRef.current;
    const vw = el?.clientWidth ?? boundsRef.current.w;
    const vh = el?.clientHeight ?? boundsRef.current.h;
    return clampView(v, boundsRef.current.w, boundsRef.current.h, vw, vh);
  }, []);

  // ── Node positions (unified Map<NodeId, NodePos>) ────────────────────
  // Single source of truth, keyed by graph NodeId (`in:<inputId>` or
  // `bus:<busId>`). Split views below are memoized for render-side
  // backward compatibility with the existing wires/canvas code.
  const [nodePositions, setNodePositions] = useState<Map<NodeId, NodePos>>(
    loadNodePositions,
  );
  const nodePosRef = useRef(nodePositions);
  useEffect(() => { nodePosRef.current = nodePositions; }, [nodePositions]);

  // ── Group nodes (frontend-only, persisted to localStorage) ───────────
  // Groups + their edges live in localStorage; the backend has no
  // knowledge of them. Once the engine generalizes (Phase G-3) the
  // adapter will translate these into real engine nodes.
  const [localGroups, setLocalGroups] = useState<Map<string, GroupMeta>>(loadGroups);
  const [localEdges, setLocalEdges] = useState<Map<string, GraphEdge>>(loadLocalEdges);
  const localGroupsRef = useRef(localGroups);
  const localEdgesRef = useRef(localEdges);
  useEffect(() => { localGroupsRef.current = localGroups; }, [localGroups]);
  useEffect(() => { localEdgesRef.current = localEdges; }, [localEdges]);
  useEffect(() => {
    try {
      localStorage.setItem(LS_GROUPS, JSON.stringify(Array.from(localGroups.entries())));
    } catch {}
  }, [localGroups]);
  useEffect(() => {
    try {
      localStorage.setItem(LS_LOCAL_EDGES, JSON.stringify(Array.from(localEdges.entries())));
    } catch {}
  }, [localEdges]);

  // Sync inputs+buses → seed defaults, prune removed. One effect now.
  useEffect(() => {
    setNodePositions((prev) => {
      const next = new Map(prev);
      let changed = false;
      const busColX = busColumnXFor(boundsRef.current.w);
      inputs.forEach((input, i) => {
        const nid = inputNodeId(input.id);
        if (!next.has(nid)) {
          next.set(nid, { x: COL_PAD, y: COL_PAD + i * (INPUT_H + INPUT_GAP) });
          changed = true;
        }
      });
      buses.forEach((bus, i) => {
        const nid = busNodeId(bus.id);
        if (!next.has(nid)) {
          next.set(nid, { x: busColX, y: COL_PAD + i * (BUS_H + BUS_GAP) });
          changed = true;
        }
      });
      const aliveInputs = new Set(inputs.map((i) => inputNodeId(i.id)));
      const aliveBuses = new Set(buses.map((b) => busNodeId(b.id)));
      const aliveGroups = new Set(Array.from(localGroupsRef.current.keys()).map(groupNodeId));
      for (const id of Array.from(next.keys())) {
        if (isInputNodeId(id) && !aliveInputs.has(id)) { next.delete(id); changed = true; }
        else if (isBusNodeId(id) && !aliveBuses.has(id)) { next.delete(id); changed = true; }
        else if (isGroupNodeId(id) && !aliveGroups.has(id)) { next.delete(id); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [inputs, buses]);

  // Prune local edges whose endpoints no longer exist.
  useEffect(() => {
    const aliveNodes = new Set<NodeId>();
    inputs.forEach((i) => aliveNodes.add(inputNodeId(i.id)));
    buses.forEach((b) => aliveNodes.add(busNodeId(b.id)));
    for (const gid of localGroups.keys()) aliveNodes.add(groupNodeId(gid));
    setLocalEdges((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [eid, edge] of prev) {
        if (!aliveNodes.has(edge.fromNode) || !aliveNodes.has(edge.toNode)) {
          next.delete(eid);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [inputs, buses, localGroups]);

  // Split views (memoized) — kept so render/wire code reads by raw input/bus id.
  const inputPositions = useMemo(() => {
    const m = new Map<string, NodePos>();
    for (const [nid, p] of nodePositions) {
      const id = inputIdFromNodeId(nid);
      if (id != null) m.set(id, p);
    }
    return m;
  }, [nodePositions]);

  const busPositions = useMemo(() => {
    const m = new Map<string, NodePos>();
    for (const [nid, p] of nodePositions) {
      const id = busIdFromNodeId(nid);
      if (id != null) m.set(id, p);
    }
    return m;
  }, [nodePositions]);

  // Back-compat refs + setters for code paths written against the old
  // split (Map<inputId, Pos> + Map<BusId, Pos>) model. They read from /
  // write through the unified `nodePositions` source of truth.
  const inputPosRef = useRef<Map<string, NodePos>>(new Map());
  const busPosRef = useRef<Map<string, NodePos>>(new Map());
  useEffect(() => { inputPosRef.current = inputPositions; }, [inputPositions]);
  useEffect(() => { busPosRef.current = busPositions; }, [busPositions]);

  // Derived port coords ────────────────────────────────────────────────
  const portOf = (kind: "input" | "bus", id: string): NodePos | null => {
    if (kind === "input") {
      const p = inputPositions.get(id);
      return p ? { x: p.x + INPUT_W, y: p.y + INPUT_H / 2 } : null;
    }
    const p = busPositions.get(id);
    return p ? { x: p.x, y: p.y + BUS_H / 2 } : null;
  };

  const canvasW = Math.max(MIN_CANVAS_W, Math.floor(wrapSize.w) || MIN_CANVAS_W);
  const canvasH = Math.max(MIN_CANVAS_H, Math.floor(wrapSize.h) || MIN_CANVAS_H);
  boundsRef.current = { w: canvasW, h: canvasH };
  const busColumnX = busColumnXFor(canvasW);

  // Pull stale/off-screen nodes back inside the current bounded canvas.
  useEffect(() => {
    setNodePositions((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [nid, p] of prev) {
        const { x: nx, y: ny } = clampToBounds(
          p.x, p.y, nodeWidth(nid), nodeHeight(nid), canvasW, canvasH,
        );
        if (nx !== p.x || ny !== p.y) {
          next.set(nid, { x: nx, y: ny });
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [canvasW, canvasH]);

  // Keep the world box within the viewport after any size/zoom change so
  // every node (always clamped into the box) remains visible — covers
  // initial load, window resize, and panel show/hide.
  useEffect(() => {
    setView((v) => clampViewToBounds(v));
  }, [canvasW, canvasH, clampViewToBounds]);

  // ── Mouse handlers for drag-to-connect ────────────────────────────────
  const handlePortMouseDown = useCallback(
    (inputId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const pos = nodePosRef.current.get(inputNodeId(inputId));
      if (!pos) return;
      const startX = pos.x + INPUT_W;
      const startY = pos.y + INPUT_H / 2;
      setDrag({
        fromNodeId: inputNodeId(inputId),
        fromInputId: inputId,
        startX,
        startY,
        curX: startX,
        curY: startY,
        hoverBusId: null,
        hoverGroupId: null,
        dropOk: true,
        dropReason: null,
      });
    },
    [],
  );

  // ── Mouse handlers for moving a node ──────────────────────────────────
  const handleNodeMouseDown = useCallback(
    (kind: "input" | "bus" | "group", id: string, e: React.MouseEvent) => {
      // Only left mouse button initiates a drag.
      if (e.button !== 0) return;
      // Ignore clicks on interactive children (ports, buttons).
      const target = e.target as HTMLElement;
      if (target.closest("button")) return;
      const nid =
        kind === "input" ? inputNodeId(id)
        : kind === "bus" ? busNodeId(id as BusId)
        : groupNodeId(id);
      const pos = nodePosRef.current.get(nid);
      if (!pos) return;
      // Shift+click → toggle this node in the multi-select set and
      // don't start a drag. The caller's onClick still fires after
      // mouseup; we suppress its single-select effect via the marker.
      if (e.shiftKey) {
        suppressNextClick.current = true;
        if (kind === "input") {
          setSelInputs((s) => {
            const next = new Set(s);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          });
        } else if (kind === "bus") {
          if (!isBusId(id)) return;
          setSelBuses((s) => {
            const next = new Set(s);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          });
        }
        // Group nodes don't participate in the multi-select set yet —
        // shift+click is a no-op there.
        e.preventDefault();
        return;
      }
      // Capture starting positions for every selected node so group
      // drag moves them together. Keys are graph NodeIds. If this node
      // isn't already in the multi-selection, treat as a single-node
      // drag (group of one).
      const groupStart = new Map<NodeId, NodePos>();
      const inMulti =
        (kind === "input" && selInputsRef.current.has(id)) ||
        (kind === "bus" && isBusId(id) && selBusesRef.current.has(id));
      // Group nodes are never part of inMulti (no multi-select support yet).
      if (inMulti) {
        for (const inId of selInputsRef.current) {
          const p = nodePosRef.current.get(inputNodeId(inId));
          if (p) groupStart.set(inputNodeId(inId), p);
        }
        for (const bId of selBusesRef.current) {
          const p = nodePosRef.current.get(busNodeId(bId));
          if (p) groupStart.set(busNodeId(bId), p);
        }
      } else {
        groupStart.set(nid, pos);
      }
      setNodeDrag({
        kind,
        id,
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        startNodeX: pos.x,
        startNodeY: pos.y,
        moved: false,
        groupStart,
      });
      e.preventDefault();
    },
    [],
  );

  useEffect(() => {
    if (!drag) return;
    const wrap = wrapRef.current;
    if (!wrap) return;

    const onMove = (e: MouseEvent) => {
      const { x, y } = toCanvas(e.clientX, e.clientY);

      // Sweep all candidate drop targets. Both bus input ports and
      // group input ports sit on the left edge of their nodes.
      let hoverBusId: BusId | null = null;
      let hoverGroupId: string | null = null;
      for (const [nid, pos] of nodePosRef.current) {
        if (isBusNodeId(nid)) {
          const portX = pos.x;
          const portY = pos.y + BUS_H / 2;
          const dx = x - portX;
          const dy = y - portY;
          if (dx * dx + dy * dy < 32 * 32) {
            const bid = busIdFromNodeId(nid);
            if (bid) { hoverBusId = bid; hoverGroupId = null; break; }
          }
        } else if (isGroupNodeId(nid)) {
          const portX = pos.x;
          const portY = pos.y + GROUP_H / 2;
          const dx = x - portX;
          const dy = y - portY;
          if (dx * dx + dy * dy < 32 * 32) {
            const gid = groupIdFromNodeId(nid);
            if (gid) { hoverGroupId = gid; hoverBusId = null; break; }
          }
        }
      }

      // Validate candidate edge via the generalized graph. GraphError
      // → invalid drop unless it's DUP_EDGE / DUP_PAIR (existing edge =
      // legitimate disconnect path; onMouseUp flips it off).
      let dropOk = true;
      let dropReason: string | null = null;
      const d0 = dragRef.current;
      if ((hoverBusId || hoverGroupId) && d0) {
        const toNode = hoverBusId ? busNodeId(hoverBusId) : groupNodeId(hoverGroupId!);
        const edgeId = `edge:${d0.fromNodeId}->${toNode}`;
        const candidate: GraphEdge = {
          id: edgeId,
          fromNode: d0.fromNodeId,
          fromPort: "out",
          toNode,
          toPort: "in",
          gain: 0.75,
          muted: false,
        };
        try {
          graphAddEdge(graphRef.current, candidate);
        } catch (err) {
          if (err instanceof GraphError) {
            if (err.code === "DUP_EDGE" || err.code === "DUP_PAIR") {
              // Existing edge — legitimate disconnect path.
              dropOk = true;
            } else {
              dropOk = false;
              dropReason = dropReasonFor(err.code);
            }
          } else {
            throw err;
          }
        }
      }

      setDrag((d) =>
        d
          ? { ...d, curX: x, curY: y, hoverBusId, hoverGroupId, dropOk, dropReason }
          : null,
      );
    };

    const onUp = () => {
      // Read drag state via the ref, never inside the setDrag updater.
      // React 18 StrictMode invokes updaters twice; a side effect like
      // onToggleSend in there would double-fire and net-cancel itself,
      // which is why connections appeared in Flow/Matrix but vanished
      // from NodeView on release.
      const d = dragRef.current;
      if (d && d.dropOk) {
        if (d.hoverBusId && isInputNodeId(d.fromNodeId) && d.fromInputId) {
          // Bipartite input → bus — flip via the backend send action.
          onToggleSend(d.fromInputId, d.hoverBusId);
        } else if (d.hoverBusId || d.hoverGroupId) {
          // Any other valid drop targets a group node or originates from
          // a group → frontend-only local edge.
          const toNode = d.hoverBusId
            ? busNodeId(d.hoverBusId)
            : groupNodeId(d.hoverGroupId!);
          const edgeId = `edge:${d.fromNodeId}->${toNode}`;
          setLocalEdges((prev) => {
            const next = new Map(prev);
            if (next.has(edgeId)) {
              // Disconnect (toggle off).
              next.delete(edgeId);
            } else {
              next.set(edgeId, {
                id: edgeId,
                fromNode: d.fromNodeId,
                fromPort: "out",
                toNode,
                toPort: "in",
                gain: 0.75,
                muted: false,
              });
            }
            return next;
          });
        }
      }
      setDrag(null);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, onToggleSend, toCanvas]);

  // ── Node-drag effect (moving a node around the canvas) ───────────────
  useEffect(() => {
    if (!nodeDrag) return;

    const onMove = (e: MouseEvent) => {
      const z = viewRef.current.zoom;
      const dx = (e.clientX - nodeDrag.startMouseX) / z;
      const dy = (e.clientY - nodeDrag.startMouseY) / z;
      setNodeDrag((d) => (d && (dx !== 0 || dy !== 0) ? { ...d, moved: true } : d));
      // Group move: apply the same delta to every node captured at
      // mousedown (single-node drags are just a group of one). Keys
      // are graph NodeIds in the unified position store.
      if (nodeDrag.groupStart.size > 0) {
        setNodePositions((prev) => {
          const next = new Map(prev);
          for (const [nid, p0] of nodeDrag.groupStart) {
            next.set(nid, clampToBounds(
              p0.x + dx, p0.y + dy,
              nodeWidth(nid), nodeHeight(nid),
              boundsRef.current.w, boundsRef.current.h,
            ));
          }
          return next;
        });
      }
    };

    const onUp = () => {
      // Persist positions on release.
      saveNodePositions(nodePosRef.current);
      setNodeDrag(null);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [nodeDrag]);

  // ── Wheel handler (zoom around cursor, or pan if no modifier) ────────
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      if (e.ctrlKey || e.metaKey) {
        setView((v) => {
          const factor = Math.exp(-e.deltaY * 0.0015);
          const zoom = clampZoom(v.zoom * factor);
          const k = zoom / v.zoom;
          return clampViewToBounds({ zoom, tx: mx - (mx - v.tx) * k, ty: my - (my - v.ty) * k });
        });
      } else {
        setView((v) => clampViewToBounds({ ...v, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY }));
      }
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, []);

  // ── Del / Backspace removes multi-selected inputs; Esc clears ────────
  useEffect(() => {
    const isEditable = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      if (isEditable(e.target)) return;
      if (e.key === "Escape") {
        if (selInputsRef.current.size === 0 && selBusesRef.current.size === 0) {
          setSelectedWire(null);
          return;
        }
        e.preventDefault();
        clearMultiSelect();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (!onRemoveInput) return;
        const ids = Array.from(selInputsRef.current);
        if (ids.length === 0) return;
        e.preventDefault();
        for (const id of ids) onRemoveInput(id);
        clearMultiSelect();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clearMultiSelect, onRemoveInput]);

  // ── Spacebar (hold for hand-tool pan cursor) ─────────────────────────
  useEffect(() => {
    const isEditable = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat && !isEditable(e.target)) {
        e.preventDefault();
        setSpaceDown(true);
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceDown(false);
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, []);

  // ── Canvas pan (middle-mouse or space+left) ──────────────────────────
  const handleWrapMouseDown = useCallback((e: React.MouseEvent) => {
    const isMiddle = e.button === 1;
    const isSpacePan = e.button === 0 && spaceDown;
    if (isMiddle || isSpacePan) {
      e.preventDefault();
      setPanning({
        startClientX: e.clientX,
        startClientY: e.clientY,
        startTx: viewRef.current.tx,
        startTy: viewRef.current.ty,
      });
      return;
    }
    // Left-click on the background (not on a node, port, or wire) starts
    // a marquee selection. The mousedown target must be the wrap or the
    // transformed canvas — anything inside a node bubbles up here with a
    // different target.
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const onBackground =
      target === wrapRef.current ||
      target.classList.contains(styles.canvas) ||
      target.classList.contains(styles.canvasTransform);
    if (!onBackground) return;
    const { x, y } = toCanvas(e.clientX, e.clientY);
    setMarquee({ startX: x, startY: y, curX: x, curY: y });
  }, [spaceDown, toCanvas]);

  useEffect(() => {
    if (!panning) return;
    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - panning.startClientX;
      const dy = e.clientY - panning.startClientY;
      setView((v) => clampViewToBounds({ ...v, tx: panning.startTx + dx, ty: panning.startTy + dy }));
    };
    const onUp = () => setPanning(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [panning]);

  // ── Marquee drag → multi-select ──────────────────────────────────────
  useEffect(() => {
    if (!marquee) return;
    const onMove = (e: MouseEvent) => {
      const { x, y } = toCanvas(e.clientX, e.clientY);
      setMarquee((m) => (m ? { ...m, curX: x, curY: y } : null));
    };
    const onUp = () => {
      // Read marquee via ref, compute hits, dispatch side effects, then
      // clear marquee state. Doing this inside setMarquee would
      // double-fire under React 18 StrictMode (same class of bug as the
      // node drag-to-connect we already fixed).
      const m = marqueeRef.current;
      if (!m) return;
      const x0 = Math.min(m.startX, m.curX);
      const y0 = Math.min(m.startY, m.curY);
      const x1 = Math.max(m.startX, m.curX);
      const y1 = Math.max(m.startY, m.curY);
      if (x1 - x0 < 4 && y1 - y0 < 4) {
        // Plain click on background → clear selection.
        clearMultiSelect();
      } else {
        const hitInputs = new Set<string>();
        const hitBuses = new Set<BusId>();
        for (const [nid, p] of nodePosRef.current) {
          if (isInputNodeId(nid)) {
            if (p.x + INPUT_W >= x0 && p.x <= x1 && p.y + INPUT_H >= y0 && p.y <= y1) {
              const iid = inputIdFromNodeId(nid);
              if (iid) hitInputs.add(iid);
            }
          } else if (isBusNodeId(nid)) {
            if (p.x + BUS_W >= x0 && p.x <= x1 && p.y + BUS_H >= y0 && p.y <= y1) {
              const bid = busIdFromNodeId(nid);
              if (bid) hitBuses.add(bid);
            }
          }
        }
        setSelInputs(hitInputs);
        setSelBuses(hitBuses);
      }
      setMarquee(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [marquee, toCanvas, clearMultiSelect]);

  const zoomBy = useCallback((factor: number) => {
    const wrap = wrapRef.current;
    const rect = wrap?.getBoundingClientRect();
    const mx = rect ? rect.width / 2 : 0;
    const my = rect ? rect.height / 2 : 0;
    setView((v) => {
      const zoom = clampZoom(v.zoom * factor);
      const k = zoom / v.zoom;
      return clampViewToBounds({ zoom, tx: mx - (mx - v.tx) * k, ty: my - (my - v.ty) * k });
    });
  }, [clampViewToBounds]);

  const resetView = useCallback(() => {
    setView(clampViewToBounds({ tx: 0, ty: 0, zoom: 1 }));
  }, [clampViewToBounds]);

  // ── Group management ────────────────────────────────────────────────
  // Frontend-only: creating / removing a group is a localStorage write.
  // The engine has no idea these exist; the adapter will translate them
  // when the backend generalizes in Phase G-3.
  const addGroup = useCallback(() => {
    const id = nextGroupId();
    const nid = groupNodeId(id);
    setLocalGroups((prev) => {
      const next = new Map(prev);
      next.set(id, { name: `Group ${prev.size + 1}` });
      return next;
    });
    // Drop the new node near the viewport centre so the user actually
    // sees it without having to pan around.
    const wrap = wrapRef.current;
    const rect = wrap?.getBoundingClientRect();
    const cx = rect ? rect.width / 2 : 300;
    const cy = rect ? rect.height / 2 : 200;
    const v = viewRef.current;
    const wx = (cx - v.tx) / v.zoom - GROUP_W / 2;
    const wy = (cy - v.ty) / v.zoom - GROUP_H / 2;
    const { x: clampedX, y: clampedY } = clampToBounds(
      wx, wy, GROUP_W, GROUP_H, boundsRef.current.w, boundsRef.current.h,
    );
    setNodePositions((prev) => {
      const next = new Map(prev);
      next.set(nid, { x: clampedX, y: clampedY });
      return next;
    });
    saveNodePositions(new Map(nodePosRef.current).set(nid, {
      x: clampedX,
      y: clampedY,
    }));
  }, []);

  const removeGroup = useCallback((gid: string) => {
    const nid = groupNodeId(gid);
    setLocalGroups((prev) => {
      const next = new Map(prev);
      next.delete(gid);
      return next;
    });
    setLocalEdges((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [eid, edge] of prev) {
        if (edge.fromNode === nid || edge.toNode === nid) {
          next.delete(eid);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  // ── Stable id-based handlers (let InputNode/BusNode memoize) ─────────
  const nodeDragRef = useRef(nodeDrag);
  useEffect(() => { nodeDragRef.current = nodeDrag; }, [nodeDrag]);

  const onInputSelect = useCallback((id: string) => {
    if (suppressNextClick.current) { suppressNextClick.current = false; return; }
    if (nodeDragRef.current?.moved) return;
    clearMultiSelect();
    onSelectInput(id);
  }, [onSelectInput, clearMultiSelect]);
  const onBusSelect = useCallback((id: BusId) => {
    if (suppressNextClick.current) { suppressNextClick.current = false; return; }
    if (nodeDragRef.current?.moved) return;
    clearMultiSelect();
    onSelectBus(id);
  }, [onSelectBus, clearMultiSelect]);
  const onInputHoverEnter = useCallback((id: string) => setHoverInput(id), []);
  const onInputHoverLeave = useCallback((id: string) =>
    setHoverInput((c) => (c === id ? null : c)), []);
  const onBusHoverEnter = useCallback((id: BusId) => setHoverBus(id), []);
  const onBusHoverLeave = useCallback((id: BusId) =>
    setHoverBus((c) => (c === id ? null : c)), []);
  const onInputNodeMouseDown = useCallback((id: string, e: React.MouseEvent) =>
    handleNodeMouseDown("input", id, e), [handleNodeMouseDown]);
  const onBusNodeMouseDown = useCallback((id: string, e: React.MouseEvent) =>
    handleNodeMouseDown("bus", id, e), [handleNodeMouseDown]);
  const onGroupNodeMouseDown = useCallback((id: string, e: React.MouseEvent) =>
    handleNodeMouseDown("group", id, e), [handleNodeMouseDown]);

  // Start a drag-connect from a group's output port.
  const onGroupPortMouseDown = useCallback(
    (groupId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const nid = groupNodeId(groupId);
      const pos = nodePosRef.current.get(nid);
      if (!pos) return;
      const startX = pos.x + GROUP_W;
      const startY = pos.y + GROUP_H / 2;
      setDrag({
        fromNodeId: nid,
        fromInputId: "",
        startX,
        startY,
        curX: startX,
        curY: startY,
        hoverBusId: null,
        hoverGroupId: null,
        dropOk: true,
        dropReason: null,
      });
    },
    [],
  );

  // Precompute "input has any enabled send" once.
  const inputsWithConnections = useMemo(() => {
    const s = new Set<string>();
    for (const send of sends) if (send.enabled) s.add(send.inputId);
    return s;
  }, [sends]);

  // Inputs that have an enabled send to at least one running bus — these
  // can be tapped at the pre-gain point because their device samples are
  // being pumped through that bus's input ring right now.
  const inputsOnRunningBus = useMemo(() => {
    const runningBuses = new Set<BusId>();
    for (const b of buses) {
      if (b.state === "running" || b.state === "clipping") runningBuses.add(b.id);
    }
    const s = new Set<string>();
    for (const send of sends) {
      if (send.enabled && runningBuses.has(send.busId)) s.add(send.inputId);
    }
    return s;
  }, [buses, sends]);

  const onInputRecToggle = useCallback(
    (inputId: string) => {
      const spec: TapSpec = { kind: "input_pre", device_id: inputId };
      const rec = findRecording(activeRecordings, spec);
      if (rec) onStopRecording(rec.id);
      else onStartRecording(spec);
    },
    [activeRecordings, onStartRecording, onStopRecording],
  );

  const onBusRecToggle = useCallback(
    (busId: BusId) => {
      const spec: TapSpec = { kind: "bus_out", bus_id: busId };
      const rec = findRecording(activeRecordings, spec);
      if (rec) onStopRecording(rec.id);
      else onStartRecording(spec);
    },
    [activeRecordings, onStartRecording, onStopRecording],
  );

  // Stable wire handlers (id-based) so memo on Wire actually skips renders.
  const onWireClick = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedWire(id);
  }, []);
  const onWireHoverEnter = useCallback((id: string) => setHoverWire(id), []);
  const onWireHoverLeave = useCallback((id: string) =>
    setHoverWire((cur) => (cur === id ? null : cur)), []);

  const dismissOnBackgroundClick = () => {
    setSelectedWire(null);
  };

  const resetLayout = () => {
    try {
      localStorage.removeItem(LS_NODES_V2);
    } catch {}
    const next = new Map<NodeId, NodePos>();
    inputs.forEach((input, i) => {
      next.set(inputNodeId(input.id), {
        x: COL_PAD,
        y: COL_PAD + i * (INPUT_H + INPUT_GAP),
      });
    });
    buses.forEach((bus, i) => {
      next.set(busNodeId(bus.id), {
        x: busColumnX,
        y: COL_PAD + i * (BUS_H + BUS_GAP),
      });
    });
    // Reset must reposition existing group nodes too — otherwise the
    // group renderer would receive `undefined` for their position, the
    // node would fall back to (0, 0), and the user would see the group
    // jump under the input column or be invisible behind other nodes.
    // Lay groups out in a third column to the right of the bus column
    // in their current insertion order. Group ids stay stable; we are
    // only assigning positions.
    const groupColX = Math.min(
      busColumnX + BUS_W + COL_GAP_BETWEEN,
      Math.max(COL_PAD, boundsRef.current.w - GROUP_W - COL_PAD),
    );
    let groupIndex = 0;
    for (const gid of localGroups.keys()) {
      next.set(groupNodeId(gid), {
        x: groupColX,
        y: Math.min(
          Math.max(0, boundsRef.current.h - GROUP_H),
          COL_PAD + groupIndex * (GROUP_H + BUS_GAP),
        ),
      });
      groupIndex += 1;
    }
    setNodePositions(next);
    // Reset is an intentional full reflow: realign the viewport too so the
    // freshly laid-out columns are guaranteed to sit inside the visible area.
    setView(clampViewToBounds({ tx: 0, ty: 0, zoom: 1 }));
  };

  // ── Generalized routing graph ────────────────────────────────────────
  // Phase G-1b consumption: the canonical source of connectivity is now
  // the generalized Graph derived from the bipartite UI model. Wires +
  // the selected-wire popover walk graph.edges; future non-bipartite
  // nodes (group/fx) flow through the same code path without further
  // changes here.
  const bipartiteGraph = useMemo(
    () => bipartiteToGraph(buses, inputs, sends),
    [buses, inputs, sends],
  );

  // Full graph: bipartite + local (group nodes + local edges). Built so
  // addEdge validation sees every existing edge when deciding cycles +
  // duplicates. Failures inside the build (DUP_NODE etc.) are swallowed
  // because the build is idempotent across re-renders.
  const graph: Graph = useMemo(() => {
    let g = bipartiteGraph;
    for (const [gid, meta] of localGroups) {
      const nid = groupNodeId(gid);
      const pos = nodePositions.get(nid);
      const node: GraphNode = {
        id: nid,
        kind: { type: "group" },
        name: meta.name,
        ports: defaultPortsFor({ type: "group" }),
        gain: 1,
        muted: false,
        level: 0,
        uiX: pos?.x ?? 0,
        uiY: pos?.y ?? 0,
      };
      try { g = graphAddNode(g, node); } catch { /* idempotent */ }
    }
    for (const edge of localEdges.values()) {
      try { g = graphAddEdge(g, edge); } catch { /* drop invalid */ }
    }
    return g;
  }, [bipartiteGraph, localGroups, localEdges, nodePositions]);

  // Stable ref so the port-drag effect reads the latest graph without
  // re-subscribing. Used by the addEdge validation during onMove.
  const graphRef = useRef(graph);
  useEffect(() => { graphRef.current = graph; }, [graph]);

  // ── Wires to draw ─────────────────────────────────────────────────────
  // Walks the FULL graph (bipartite + group edges). For each edge,
  // resolves endpoint positions via the unified position store. Wire
  // color uses bus accent when the target is a bus, neutral grey for
  // group-touching edges. Meter flow only fires for backend bipartite
  // edges (the only ones with live audio data).
  interface WireDescriptor {
    edge: GraphEdge;
    ip: { x: number; y: number };
    bp: { x: number; y: number };
    color: string;
    /** Set only for bipartite edges so meter animation can read level. */
    input: AudioInput | null;
    bus: Bus | null;
  }
  const wires = useMemo(() => {
    const out: WireDescriptor[] = [];
    for (const edge of graph.edges.values()) {
      const fromNode = graph.nodes.get(edge.fromNode);
      const toNode = graph.nodes.get(edge.toNode);
      if (!fromNode || !toNode) continue;
      const fromPos = nodePositions.get(edge.fromNode);
      const toPos = nodePositions.get(edge.toNode);
      if (!fromPos || !toPos) continue;
      const fromW = nodeWidthFor(fromNode);
      const fromH = nodeHeightFor(fromNode);
      const toH = nodeHeightFor(toNode);
      const inMeta = asInputNode(fromNode);
      const busMeta = asBusNode(toNode);
      out.push({
        edge,
        ip: { x: fromPos.x + fromW, y: fromPos.y + fromH / 2 },
        bp: { x: toPos.x,           y: toPos.y   + toH   / 2 },
        color: busMeta ? busColor(busMeta.backing.id) : "rgba(170,180,200,0.7)",
        input: inMeta?.backing ?? null,
        bus: busMeta?.backing ?? null,
      });
    }
    return out;
  }, [graph, nodePositions]);

  return (
    <div
      ref={wrapRef}
      className={`${styles.wrap} ${nodeDrag ? styles.wrapDragging : ""} ${
        spaceDown ? styles.wrapPanReady : ""
      } ${panning ? styles.wrapPanning : ""}`}
      onClick={dismissOnBackgroundClick}
      onMouseDown={handleWrapMouseDown}
      onContextMenu={(e) => {
        // Only open the canvas context menu when the right-click hit
        // the empty background — not a node, port, wire, button, etc.
        const target = e.target as HTMLElement;
        if (target.closest("button, [data-node], [data-port], svg path")) return;
        e.preventDefault();
        setBgCtx({ x: e.clientX, y: e.clientY });
      }}
      role="region"
      aria-label="Node graph routing"
    >
      <div className={styles.zoomBar} onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className={styles.zoomBtn}
          onClick={() => zoomBy(1 / 1.2)}
          title="Zoom out"
          aria-label="Zoom out"
        >
          −
        </button>
        <button
          type="button"
          className={styles.zoomReadout}
          onClick={resetView}
          title="Reset zoom (100%)"
        >
          {Math.round(view.zoom * 100)}%
        </button>
        <button
          type="button"
          className={styles.zoomBtn}
          onClick={() => zoomBy(1.2)}
          title="Zoom in"
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          className={styles.resetBtn}
          onClick={resetLayout}
          title="Reset node positions"
        >
          Reset layout
        </button>
        {onAddInput && (
          <button
            type="button"
            className={styles.addInputBtn}
            onClick={onAddInput}
            title="Add input device"
            aria-label="Add input device"
          >
            + Add input
          </button>
        )}
        <button
          type="button"
          className={styles.addGroupBtn}
          onClick={addGroup}
          title="Add a group node (frontend only)"
          aria-label="Add group node"
        >
          + Group
        </button>
      </div>
      <div
        className={styles.canvasTransform}
        style={{
          transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.zoom})`,
          transformOrigin: "0 0",
        }}
      >
      <div className={styles.canvas} style={{ width: canvasW, height: canvasH }}>
        <ColumnLabel x={COL_PAD} label="Inputs (drag to rearrange)" />
        <ColumnLabel x={busColumnX} label="Buses" />

        {/* SVG wires layer */}
        <svg
          className={styles.wiresLayer}
          width={canvasW}
          height={canvasH}
          viewBox={`0 0 ${canvasW} ${canvasH}`}
        >
          <defs>
            <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Background grid */}
          <pattern id="nodeGrid" width="20" height="20" patternUnits="userSpaceOnUse">
            <circle cx="0.5" cy="0.5" r="0.5" fill="rgba(255,255,255,0.04)" />
          </pattern>
          <rect width={canvasW} height={canvasH} fill="url(#nodeGrid)" />

          {/* Render wires (selected/hovered last for z-order). Wires
              touching a group node are local-only and have no live
              audio data → meter flow is suppressed. */}
          {wires.map((w) => {
            const id = w.edge.id;
            const isHover = hoverWire === id;
            const isSelected = selectedWire === id;
            const isLevelFlow =
              !!w.bus && !!w.input &&
              w.bus.enabled && !w.edge.muted && !w.input.muted && w.input.level > 0.05;
            return (
              <Wire
                key={id}
                id={id}
                fromX={w.ip.x}
                fromY={w.ip.y}
                toX={w.bp.x}
                toY={w.bp.y}
                color={w.color}
                gain={w.edge.gain}
                muted={w.edge.muted}
                flowing={isLevelFlow}
                flowSpeed={w.input?.level ?? 0}
                hovered={isHover}
                selected={isSelected}
                onClick={onWireClick}
                onMouseEnter={onWireHoverEnter}
                onMouseLeave={onWireHoverLeave}
              />
            );
          })}

          {/* Ghost wire while dragging. Invalid drop (cycle / port
              mismatch) paints the ghost red AND pulses to draw the
              eye, plus a tooltip explains the rejection. */}
          {drag && (() => {
            const hasTarget = !!drag.hoverBusId || !!drag.hoverGroupId;
            const invalid = hasTarget && !drag.dropOk;
            const targetColor = drag.hoverBusId
              ? busColor(drag.hoverBusId)
              : "rgba(170,180,200,0.85)"; // group accent
            return (
              <Wire
                fromX={drag.startX}
                fromY={drag.startY}
                toX={drag.curX}
                toY={drag.curY}
                color={
                  invalid
                    ? "var(--am-drop-invalid, #EF4444)"
                    : hasTarget
                    ? targetColor
                    : "rgba(255,255,255,0.4)"
                }
                invalid={invalid}
                gain={0.75}
                muted={false}
                flowing={false}
                flowSpeed={0}
                hovered={true}
                selected={false}
                dashed
              />
            );
          })()}
        </svg>

        {/* Drop-rejection tooltip — only when hovering an invalid bus */}
        {drag && drag.dropReason && (
          <div
            className={styles.dropTooltip}
            style={{ left: drag.curX + 14, top: drag.curY + 14 }}
            role="status"
            aria-live="polite"
          >
            {drag.dropReason}
          </div>
        )}

        {/* Marquee box */}
        {marquee && (() => {
          const x0 = Math.min(marquee.startX, marquee.curX);
          const y0 = Math.min(marquee.startY, marquee.curY);
          const w = Math.abs(marquee.curX - marquee.startX);
          const h = Math.abs(marquee.curY - marquee.startY);
          return (
            <div
              className={styles.marquee}
              style={{ left: x0, top: y0, width: w, height: h }}
              aria-hidden
            />
          );
        })()}

        {/* Input nodes */}
        {inputs.map((input) => {
          const pos = inputPositions.get(input.id);
          if (!pos) return null;
          const isSelected = selection.kind === "input" && selection.inputId === input.id;
          const isHover = hoverInput === input.id;
          const hasConnections = inputsWithConnections.has(input.id);
          const isMoving = nodeDrag?.kind === "input" && nodeDrag.id === input.id;
          const isMulti = selInputs.has(input.id);
          const preSpec: TapSpec = { kind: "input_pre", device_id: input.id };
          const recArmed = !!findRecording(activeRecordings, preSpec);
          const recDisabled = !inputsOnRunningBus.has(input.id);
          return (
            <InputNode
              key={input.id}
              input={input}
              x={pos.x}
              y={pos.y}
              selected={isSelected}
              hovered={isHover}
              hasConnections={hasConnections}
              dragging={drag?.fromInputId === input.id}
              moving={isMoving}
              multiSelected={isMulti}
              recArmed={recArmed}
              recDisabled={recDisabled}
              onMouseEnter={onInputHoverEnter}
              onMouseLeave={onInputHoverLeave}
              onSelect={onInputSelect}
              onNodeMouseDown={onInputNodeMouseDown}
              onPortMouseDown={handlePortMouseDown}
              onRecToggle={onInputRecToggle}
              onGainChange={(v) => onInputGainChange(input.id, v)}
              fxCount={countInputFx(input.dsp)}
              onFxOpen={openInputFx}
            />
          );
        })}

        {/* Bus nodes */}
        {buses.map((bus) => {
          const pos = busPositions.get(bus.id);
          if (!pos) return null;
          const isSelected = selection.kind === "bus" && selection.busId === bus.id;
          const isHover = hoverBus === bus.id;
          const isDragTarget = drag?.hoverBusId === bus.id;
          const isMoving = nodeDrag?.kind === "bus" && nodeDrag.id === bus.id;
          const isMulti = selBuses.has(bus.id);
          const busOutSpec: TapSpec = { kind: "bus_out", bus_id: bus.id };
          const recArmed = !!findRecording(activeRecordings, busOutSpec);
          const recDisabled =
            bus.state !== "running" && bus.state !== "clipping";
          return (
            <BusNode
              key={bus.id}
              bus={bus}
              x={pos.x}
              y={pos.y}
              selected={isSelected}
              hovered={isHover}
              dragTarget={isDragTarget}
              moving={isMoving}
              multiSelected={isMulti}
              recArmed={recArmed}
              recDisabled={recDisabled}
              onMouseEnter={onBusHoverEnter}
              onMouseLeave={onBusHoverLeave}
              onSelect={onBusSelect}
              onNodeMouseDown={onBusNodeMouseDown}
              onRecToggle={onBusRecToggle}
              onVolumeChange={(v) => onBusVolumeChange(bus.id, v)}
              fxCount={countBusFx(bus)}
              onFxOpen={openBusFx}
            />
          );
        })}

        {/* Group nodes (frontend-only DAG demo nodes) */}
        {Array.from(localGroups.entries()).map(([gid, meta]) => {
          const nid = groupNodeId(gid);
          const pos = nodePositions.get(nid);
          if (!pos) return null;
          const isMoving = nodeDrag?.kind === "group" && nodeDrag.id === gid;
          const isDragTarget = drag?.hoverGroupId === gid;
          return (
            <GroupNode
              key={nid}
              id={gid}
              name={meta.name}
              x={pos.x}
              y={pos.y}
              moving={isMoving}
              dragTarget={isDragTarget}
              onNodeMouseDown={onGroupNodeMouseDown}
              onPortMouseDown={onGroupPortMouseDown}
              onRemove={removeGroup}
            />
          );
        })}

        {/* Wire detail panel for selected wire */}
        {selectedWire &&
          (() => {
            const edge = graph.edges.get(selectedWire);
            if (!edge) return null;
            const fromNode = graph.nodes.get(edge.fromNode);
            const toNode = graph.nodes.get(edge.toNode);
            if (!fromNode || !toNode) return null;
            const inMeta = asInputNode(fromNode);
            const busMeta = asBusNode(toNode);
            if (!inMeta || !busMeta) return null;
            const input = inMeta.backing;
            const bus = busMeta.backing;
            const ip = portOf("input", input.id);
            const bp = portOf("bus", bus.id);
            if (!ip || !bp) return null;
            const send: Send = {
              inputId: input.id,
              busId: bus.id,
              enabled: true,
              gain: edge.gain,
              muted: edge.muted,
            };
            const midX = (ip.x + bp.x) / 2;
            const midY = (ip.y + bp.y) / 2;
            return (
              <WirePopover
                x={midX}
                y={midY}
                input={input}
                bus={bus}
                send={send}
                activeRecordings={activeRecordings}
                recDisabled={
                  bus.state !== "running" && bus.state !== "clipping"
                }
                onGainChange={(v) => onSendGainChange(input.id, bus.id, v)}
                onMuteToggle={() => onSendMuted(input.id, bus.id, !edge.muted)}
                onRemove={() => {
                  onToggleSend(input.id, bus.id);
                  setSelectedWire(null);
                }}
                onClose={() => setSelectedWire(null)}
                onStartRecording={onStartRecording}
                onStopRecording={onStopRecording}
              />
            );
          })()}
      </div>
      </div>

      {openFx && (
        <NodeFxPopover
          target={openFx}
          inputs={inputs}
          buses={buses}
          onInputDsp={onInputDsp}
          onBusEq={onBusEq}
          onBusLimiter={onBusLimiter}
          onClose={() => setOpenFx(null)}
        />
      )}

      {bgCtx && (
        <>
          <div
            className={styles.bgCtxBackdrop}
            onClick={() => setBgCtx(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setBgCtx(null);
            }}
            aria-hidden
          />
          <div
            className={styles.bgCtxMenu}
            role="menu"
            aria-label="Canvas actions"
            style={{ left: bgCtx.x, top: bgCtx.y }}
          >
            {onAddInput && (
              <button
                role="menuitem"
                className={styles.bgCtxItem}
                onClick={() => {
                  onAddInput();
                  setBgCtx(null);
                }}
              >
                + Add input device…
              </button>
            )}
            <button
              role="menuitem"
              className={styles.bgCtxItem}
              onClick={() => {
                resetView();
                setBgCtx(null);
              }}
            >
              Reset zoom
            </button>
            <button
              role="menuitem"
              className={styles.bgCtxItem}
              onClick={() => {
                resetLayout();
                setBgCtx(null);
              }}
            >
              Reset layout
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ── Sub-components ──────────────────────────────────────────────────── */

function ColumnLabel({ x, label }: { x: number; label: string }) {
  return (
    <div className={styles.columnLabel} style={{ left: x }}>
      {label}
    </div>
  );
}

interface WireProps {
  id?: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  color: string;
  gain: number;
  muted: boolean;
  flowing: boolean;
  flowSpeed: number;
  hovered: boolean;
  selected: boolean;
  dashed?: boolean;
  /** Pulse the wire to signal an invalid drop target. Ghost-wire only. */
  invalid?: boolean;
  onClick?: (id: string, e: React.MouseEvent) => void;
  onMouseEnter?: (id: string) => void;
  onMouseLeave?: (id: string) => void;
}

const Wire = memo(function Wire({
  id,
  fromX,
  fromY,
  toX,
  toY,
  color,
  gain,
  muted,
  flowing,
  flowSpeed,
  hovered,
  selected,
  dashed,
  invalid,
  onClick,
  onMouseEnter,
  onMouseLeave,
}: WireProps) {
  const dx = toX - fromX;
  const c1x = fromX + Math.abs(dx) * 0.5;
  const c1y = fromY;
  const c2x = toX - Math.abs(dx) * 0.5;
  const c2y = toY;
  const path = `M ${fromX} ${fromY} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${toX} ${toY}`;

  const baseStroke = Math.max(2, gain * 6);
  const stroke = hovered || selected ? baseStroke + 2 : baseStroke;
  const opacity = muted ? 0.32 : 1;

  return (
    <g
      className={`${styles.wire} ${hovered ? styles.wireHover : ""} ${
        selected ? styles.wireSelected : ""
      } ${invalid ? styles.wireInvalid : ""}`}
      onClick={onClick && id ? (e) => onClick(id, e) : undefined}
      onMouseEnter={onMouseEnter && id ? () => onMouseEnter(id) : undefined}
      onMouseLeave={onMouseLeave && id ? () => onMouseLeave(id) : undefined}
    >
      {/* Invisible thick hit zone */}
      <path d={path} stroke="transparent" strokeWidth={18} fill="none" />
      {/* Glow when selected */}
      {selected && (
        <path
          d={path}
          stroke={color}
          strokeWidth={stroke + 6}
          fill="none"
          opacity={0.32}
          filter="url(#glow)"
        />
      )}
      {/* Main wire */}
      <path
        d={path}
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        fill="none"
        opacity={opacity}
        strokeDasharray={dashed ? "6 6" : muted ? "4 4" : undefined}
      />
      {/* Animated signal flow */}
      {flowing && (
        <path
          d={path}
          stroke="white"
          strokeWidth={Math.max(1, stroke * 0.4)}
          strokeLinecap="round"
          fill="none"
          opacity={0.7}
          strokeDasharray="4 14"
          style={{
            animation: `am-wire-flow ${Math.max(0.5, 1.4 - flowSpeed)}s linear infinite`,
          }}
        />
      )}
    </g>
  );
});

interface InputNodeProps {
  input: AudioInput;
  x: number;
  y: number;
  selected: boolean;
  hovered: boolean;
  hasConnections: boolean;
  dragging: boolean;
  moving: boolean;
  multiSelected: boolean;
  recArmed: boolean;
  recDisabled: boolean;
  onMouseEnter: (id: string) => void;
  onMouseLeave: (id: string) => void;
  onSelect: (id: string) => void;
  onNodeMouseDown: (id: string, e: React.MouseEvent) => void;
  onPortMouseDown: (id: string, e: React.MouseEvent) => void;
  onRecToggle: (id: string) => void;
  onGainChange: (v: number) => void;
  fxCount: number;
  onFxOpen: (id: string, e: React.MouseEvent) => void;
}

const InputNode = memo(function InputNode({
  input,
  x,
  y,
  selected,
  hovered,
  hasConnections,
  dragging,
  moving,
  multiSelected,
  recArmed,
  recDisabled,
  onMouseEnter,
  onMouseLeave,
  onSelect,
  onNodeMouseDown,
  onPortMouseDown,
  onRecToggle,
  onGainChange,
  fxCount,
  onFxOpen,
}: InputNodeProps) {
  const id = input.id;
  return (
    <div
      className={`${styles.inputNode} ${selected ? styles.nodeSelected : ""} ${
        hovered ? styles.nodeHovered : ""
      } ${input.muted ? styles.nodeMuted : ""} ${dragging ? styles.nodeDragging : ""} ${
        moving ? styles.nodeMoving : ""
      } ${multiSelected ? styles.nodeMultiSelected : ""}`}
      style={{ left: x, top: y, width: INPUT_W, height: INPUT_H }}
      onMouseDown={(e) => onNodeMouseDown(id, e)}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(id);
      }}
      onMouseEnter={() => onMouseEnter(id)}
      onMouseLeave={() => onMouseLeave(id)}
    >
      <span className={styles.nodeIcon} aria-hidden>
        {iconForKind(input.kind)}
      </span>
      <div className={styles.nodeText}>
        <div className={styles.nodeName}>{input.name}</div>
        <div className={styles.nodeSub}>
          <span className={styles.levelBar} aria-hidden>
            <span
              className={styles.levelFill}
              style={{ width: `${Math.min(1, input.level) * 100}%` }}
            />
          </span>
        </div>
        <div
          className={styles.nodeGainRow}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={input.gain}
            onChange={(e) => onGainChange(Number(e.target.value))}
            className={styles.nodeGainSlider}
            style={{ accentColor: "var(--am-accent)" }}
            aria-label={`Gain for ${input.name}`}
            title="Mic gain (0.75 = unity, up to +20 dB)"
          />
          <span className={styles.nodeGainReadout}>{gainToDb(input.gain)}</span>
        </div>
      </div>
      <button
        className={`${styles.outputPort} ${hasConnections ? styles.portConnected : ""}`}
        onMouseDown={(e) => onPortMouseDown(id, e)}
        onClick={(e) => e.stopPropagation()}
        aria-label={`Drag from ${input.name} to connect to a bus`}
        title="Drag to a bus to connect"
      >
        <span className={styles.portInner} />
      </button>
      <button
        type="button"
        className={`${styles.fxBadge} ${fxCount > 0 ? styles.fxBadgeActive : ""}`}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onFxOpen(id, e);
        }}
        title={fxCount > 0 ? `${fxCount} effect(s) — click to edit` : "Add effects"}
        aria-label={`Effects for ${input.name}`}
      >
        FX{fxCount > 0 ? ` ${fxCount}` : ""}
      </button>
      {!(recDisabled && !recArmed) && (
        <button
          type="button"
          className={`${styles.recBadge} ${recArmed ? styles.recBadgeArmed : ""} ${recDisabled ? styles.recBadgeDisabled : ""}`}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            if (!recDisabled || recArmed) onRecToggle(id);
          }}
          disabled={recDisabled && !recArmed}
          title={recArmed ? "Stop recording (pre-gain)" : "Record pre-gain"}
          aria-pressed={recArmed}
          aria-label={recArmed ? "Stop recording" : "Record pre-gain"}
        >
          <RecordIcon size={10} />
        </button>
      )}
    </div>
  );
});

interface BusNodeProps {
  bus: Bus;
  x: number;
  y: number;
  selected: boolean;
  hovered: boolean;
  dragTarget: boolean;
  moving: boolean;
  multiSelected: boolean;
  recArmed: boolean;
  recDisabled: boolean;
  onMouseEnter: (id: BusId) => void;
  onMouseLeave: (id: BusId) => void;
  onSelect: (id: BusId) => void;
  onNodeMouseDown: (id: string, e: React.MouseEvent) => void;
  onRecToggle: (id: BusId) => void;
  onVolumeChange: (v: number) => void;
  fxCount: number;
  onFxOpen: (id: BusId, e: React.MouseEvent) => void;
}

const BusNode = memo(function BusNode({
  bus,
  x,
  y,
  selected,
  hovered,
  dragTarget,
  moving,
  multiSelected,
  recArmed,
  recDisabled,
  onMouseEnter,
  onMouseLeave,
  onSelect,
  onNodeMouseDown,
  onRecToggle,
  onVolumeChange,
  fxCount,
  onFxOpen,
}: BusNodeProps) {
  const id = bus.id;
  return (
    <div
      className={`${styles.busNode} ${selected ? styles.nodeSelected : ""} ${
        hovered ? styles.nodeHovered : ""
      } ${dragTarget ? styles.busNodeDragTarget : ""} ${
        bus.state === "running" || bus.state === "clipping" ? styles.busNodeLive : ""
      } ${bus.state === "error" ? styles.busNodeError : ""} ${
        moving ? styles.nodeMoving : ""
      } ${multiSelected ? styles.nodeMultiSelected : ""}`}
      style={{
        left: x,
        top: y,
        width: BUS_W,
        height: BUS_H,
        ["--bus-accent" as any]: busColor(bus.id),
        ["--bus-accent-muted" as any]: `var(--am-bus-${bus.id.toLowerCase()}-muted)`,
      }}
      onMouseDown={(e) => onNodeMouseDown(id, e)}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(id);
      }}
      onMouseEnter={() => onMouseEnter(id)}
      onMouseLeave={() => onMouseLeave(id)}
    >
      <span className={styles.inputPort} aria-hidden>
        <span className={styles.portInner} />
      </span>
      <span className={styles.nodeIcon} aria-hidden style={{ color: busColor(bus.id) }}>
        {iconForBusRole(bus.role)}
      </span>
      <div className={styles.busNodeText}>
        <div className={styles.busNodeHeader}>
          <span className={styles.busNodeLabel}>{bus.label}</span>
          <span className={styles.busNodeId}>{bus.id}</span>
        </div>
        <div className={styles.busNodeMeter} aria-hidden>
          <span
            className={styles.busNodeMeterFill}
            style={{
              width: `${Math.min(1, bus.level) * 100}%`,
              background: busColor(bus.id),
            }}
          />
        </div>
        <div
          className={styles.nodeGainRow}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={bus.volume}
            onChange={(e) => onVolumeChange(Number(e.target.value))}
            className={styles.nodeGainSlider}
            style={{ accentColor: busColor(bus.id) }}
            aria-label={`Volume for ${bus.label}`}
            title="Bus volume (0.75 = unity, up to +20 dB)"
          />
          <span className={styles.nodeGainReadout}>{gainToDb(bus.volume)}</span>
        </div>
        <div className={styles.busNodeState}>
          <span className={styles.busStateDot} style={{ background: stateDotColor(bus.state) }} />
          <span>{stateLabel(bus.state)}</span>
        </div>
      </div>
      <button
        type="button"
        className={`${styles.fxBadge} ${fxCount > 0 ? styles.fxBadgeActive : ""}`}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onFxOpen(bus.id, e);
        }}
        title={fxCount > 0 ? `${fxCount} effect(s) — click to edit` : "Add effects"}
        aria-label={`Effects for ${bus.label}`}
      >
        FX{fxCount > 0 ? ` ${fxCount}` : ""}
      </button>
      {!(recDisabled && !recArmed) && (
        <button
          type="button"
          className={`${styles.recBadge} ${recArmed ? styles.recBadgeArmed : ""} ${recDisabled ? styles.recBadgeDisabled : ""}`}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            if (!recDisabled || recArmed) onRecToggle(bus.id);
          }}
          disabled={recDisabled && !recArmed}
          title={recArmed ? `Stop ${bus.label} recording` : `Record ${bus.label} output`}
          aria-pressed={recArmed}
          aria-label={recArmed ? "Stop recording" : "Record bus output"}
        >
          <RecordIcon size={10} />
        </button>
      )}
    </div>
  );
});

/* ── Group node (frontend-only DAG demo) ───────────────────────────── */

interface GroupNodeProps {
  id: string;
  name: string;
  x: number;
  y: number;
  moving: boolean;
  dragTarget: boolean;
  onNodeMouseDown: (id: string, e: React.MouseEvent) => void;
  onPortMouseDown: (id: string, e: React.MouseEvent) => void;
  onRemove: (id: string) => void;
}

const GroupNode = memo(function GroupNode({
  id,
  name,
  x,
  y,
  moving,
  dragTarget,
  onNodeMouseDown,
  onPortMouseDown,
  onRemove,
}: GroupNodeProps) {
  return (
    <div
      className={`${styles.groupNode} ${moving ? styles.nodeMoving : ""} ${
        dragTarget ? styles.busNodeDragTarget : ""
      }`}
      style={{ left: x, top: y, width: GROUP_W, height: GROUP_H }}
      onMouseDown={(e) => onNodeMouseDown(id, e)}
    >
      <span className={styles.groupInputPort} aria-hidden>
        <span className={styles.portInner} />
      </span>
      <div className={styles.groupNodeText}>
        <div className={styles.groupNodeLabel}>{name}</div>
        <div className={styles.groupNodeSub}>Group</div>
      </div>
      <button
        type="button"
        className={styles.groupRemoveBtn}
        onClick={(e) => {
          e.stopPropagation();
          onRemove(id);
        }}
        title="Remove group"
        aria-label={`Remove ${name}`}
      >
        <XIcon size={10} />
      </button>
      <button
        className={styles.groupOutputPort}
        onMouseDown={(e) => onPortMouseDown(id, e)}
        onClick={(e) => e.stopPropagation()}
        aria-label={`Drag from ${name} to connect to a bus`}
        title="Drag to a bus to connect"
      >
        <span className={styles.portInner} />
      </button>
    </div>
  );
});

function WirePopover({
  x,
  y,
  input,
  bus,
  send,
  activeRecordings,
  recDisabled,
  onGainChange,
  onMuteToggle,
  onRemove,
  onClose,
  onStartRecording,
  onStopRecording,
}: {
  x: number;
  y: number;
  input: AudioInput;
  bus: Bus;
  send: Send;
  activeRecordings: ActiveRecording[];
  recDisabled: boolean;
  onGainChange: (v: number) => void;
  onMuteToggle: () => void;
  onRemove: () => void;
  onClose: () => void;
  onStartRecording: (spec: TapSpec) => void;
  onStopRecording: (id: string) => void;
}) {
  const postSpec: TapSpec = {
    kind: "input_post",
    device_id: input.id,
    bus_id: bus.id,
  };
  const postRec = findRecording(activeRecordings, postSpec);
  return (
    <div
      className={styles.wirePopover}
      style={{
        left: x,
        top: y,
        ["--bus-accent" as any]: busColor(bus.id),
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className={styles.wirePopoverHeader}>
        <span className={styles.wirePopoverFrom}>{input.name}</span>
        <span className={styles.wirePopoverArrow}>→</span>
        <span className={styles.wirePopoverTo}>{bus.label}</span>
        <button className={styles.wirePopoverClose} onClick={onClose} aria-label="Close">
          <XIcon size={12} />
        </button>
      </div>
      <div className={styles.wirePopoverRow}>
        <span className={styles.wirePopoverLabel}>Gain</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={send.gain}
          onChange={(e) => onGainChange(Number(e.target.value))}
          className={styles.wirePopoverSlider}
          style={{ accentColor: busColor(bus.id) }}
        />
        <span className={styles.wirePopoverGain}>{gainToDb(send.gain)}</span>
      </div>
      <div className={styles.wirePopoverActions}>
        <button
          className={`${styles.wirePopoverBtn} ${send.muted ? styles.wirePopoverBtnActive : ""}`}
          onClick={onMuteToggle}
        >
          <MuteIcon size={12} />
          <span>{send.muted ? "Muted" : "Mute"}</span>
        </button>
        <button
          className={`${styles.wirePopoverBtn} ${postRec ? styles.wirePopoverBtnRec : ""}`}
          onClick={() => {
            if (postRec) onStopRecording(postRec.id);
            else if (!recDisabled) onStartRecording(postSpec);
          }}
          disabled={recDisabled && !postRec}
          title={
            postRec
              ? "Stop send recording"
              : recDisabled
                ? "Bus not running — cannot record"
                : "Record this send (post-gain)"
          }
          aria-pressed={!!postRec}
        >
          <RecordIcon size={12} />
          <span>{postRec ? "Recording" : "REC"}</span>
        </button>
        <button className={styles.wirePopoverRemove} onClick={onRemove}>
          <XIcon size={12} />
          <span>Disconnect</span>
        </button>
      </div>
    </div>
  );
}

/* ── Helpers ─────────────────────────────────────────────────────────── */

function busColor(id: BusId): string {
  // Hard-code the resolved hex rather than var() so SVG strokes work in
  // older browsers and stay consistent through filters.
  switch (id) {
    case "A1": return "#FBBF24";
    case "A2": return "#F59E0B";
    case "B1": return "#A855F7";
    case "B2": return "#EF4444";
    default:   return "#9AA3B2";
  }
}

function stateDotColor(state: Bus["state"]): string {
  switch (state) {
    case "running":      return "#22C55E";
    case "clipping":     return "#EF4444";
    case "silent":       return "#F59E0B";
    case "error":        return "#EF4444";
    case "unconfigured": return "#6B7280";
    case "idle":
    default:             return "#6B7280";
  }
}

function stateLabel(state: Bus["state"]): string {
  switch (state) {
    case "running":      return "Live";
    case "clipping":     return "Clip";
    case "silent":       return "Silent";
    case "error":        return "Error";
    case "unconfigured": return "No device";
    case "idle":
    default:             return "Idle";
  }
}
