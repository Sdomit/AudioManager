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
  Send,
  TapSpec,
} from "./types";
import { gainToDb } from "./units";
import { bipartiteToGraph } from "./graphAdapter";
import { asBusNode, asInputNode, type GraphEdge } from "./graph";
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
const COL_PAD = 14;
const COL_GAP_BETWEEN = 160; // horizontal space between input column and bus column for wires

interface DragState {
  fromInputId: string;
  startX: number;
  startY: number;
  curX: number;
  curY: number;
  hoverBusId: BusId | null;
}

interface NodeDragState {
  kind: "input" | "bus";
  id: string;
  startMouseX: number;
  startMouseY: number;
  startNodeX: number;
  startNodeY: number;
  moved: boolean;
  /** Starting positions of ALL selected nodes (group drag), keyed by id. */
  groupStart: Map<string, NodePos>;
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

const LS_INPUTS = "am.nodePositions.inputs";
const LS_BUSES  = "am.nodePositions.buses";
const LS_VIEW   = "am.nodeView.viewport";

function loadStored(key: string): Map<string, NodePos> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const arr = JSON.parse(raw) as Array<[string, NodePos]>;
    return new Map(arr);
  } catch {
    return null;
  }
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
}: NodeViewProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
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

  // ── Node positions (state, with localStorage persistence) ─────────────
  const [inputPositions, setInputPositions] = useState<Map<string, NodePos>>(() => {
    const stored = loadStored(LS_INPUTS);
    if (stored) return stored;
    const m = new Map<string, NodePos>();
    inputs.forEach((input, i) => {
      m.set(input.id, { x: COL_PAD, y: COL_PAD + i * (INPUT_H + INPUT_GAP) });
    });
    return m;
  });

  const [busPositions, setBusPositions] = useState<Map<string, NodePos>>(() => {
    const stored = loadStored(LS_BUSES);
    if (stored) return stored;
    const m = new Map<string, NodePos>();
    const busColX = COL_PAD + INPUT_W + COL_GAP_BETWEEN;
    buses.forEach((bus, i) => {
      m.set(bus.id, { x: busColX, y: COL_PAD + i * (BUS_H + BUS_GAP) });
    });
    return m;
  });

  // Sync when inputs/buses list changes (add defaults, prune removed)
  useEffect(() => {
    setInputPositions((prev) => {
      const next = new Map(prev);
      let changed = false;
      inputs.forEach((input, i) => {
        if (!next.has(input.id)) {
          next.set(input.id, { x: COL_PAD, y: COL_PAD + i * (INPUT_H + INPUT_GAP) });
          changed = true;
        }
      });
      for (const id of Array.from(next.keys())) {
        if (!inputs.find((i) => i.id === id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [inputs]);

  useEffect(() => {
    setBusPositions((prev) => {
      const next = new Map(prev);
      let changed = false;
      const busColX = COL_PAD + INPUT_W + COL_GAP_BETWEEN;
      buses.forEach((bus, i) => {
        if (!next.has(bus.id)) {
          next.set(bus.id, { x: busColX, y: COL_PAD + i * (BUS_H + BUS_GAP) });
          changed = true;
        }
      });
      for (const id of Array.from(next.keys())) {
        if (!buses.find((b) => b.id === id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [buses]);

  // Refs for the global mousemove/mouseup handlers to read latest positions.
  const inputPosRef = useRef(inputPositions);
  const busPosRef   = useRef(busPositions);
  useEffect(() => { inputPosRef.current = inputPositions; }, [inputPositions]);
  useEffect(() => { busPosRef.current   = busPositions;   }, [busPositions]);

  // Derived port coords ────────────────────────────────────────────────
  const portOf = (kind: "input" | "bus", id: string): NodePos | null => {
    if (kind === "input") {
      const p = inputPositions.get(id);
      return p ? { x: p.x + INPUT_W, y: p.y + INPUT_H / 2 } : null;
    }
    const p = busPositions.get(id);
    return p ? { x: p.x, y: p.y + BUS_H / 2 } : null;
  };

  // Compute canvas size based on actual node positions so it grows if
  // nodes are dragged beyond the default footprint.
  const { canvasW, canvasH } = useMemo(() => {
    const all = [
      ...Array.from(inputPositions.values()).map((p) => ({ x: p.x + INPUT_W, y: p.y + INPUT_H })),
      ...Array.from(busPositions.values()).map((p) => ({ x: p.x + BUS_W, y: p.y + BUS_H })),
    ];
    return {
      canvasW: Math.max(
        COL_PAD + INPUT_W + COL_GAP_BETWEEN + BUS_W + COL_PAD,
        ...all.map((p) => p.x + COL_PAD),
        400,
      ),
      canvasH: Math.max(400, ...all.map((p) => p.y + COL_PAD)),
    };
  }, [inputPositions, busPositions]);

  // ── Mouse handlers for drag-to-connect ────────────────────────────────
  const handlePortMouseDown = useCallback(
    (inputId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const pos = inputPosRef.current.get(inputId);
      if (!pos) return;
      const startX = pos.x + INPUT_W;
      const startY = pos.y + INPUT_H / 2;
      setDrag({
        fromInputId: inputId,
        startX,
        startY,
        curX: startX,
        curY: startY,
        hoverBusId: null,
      });
    },
    [],
  );

  // ── Mouse handlers for moving a node ──────────────────────────────────
  const handleNodeMouseDown = useCallback(
    (kind: "input" | "bus", id: string, e: React.MouseEvent) => {
      // Only left mouse button initiates a drag.
      if (e.button !== 0) return;
      // Ignore clicks on interactive children (ports, buttons).
      const target = e.target as HTMLElement;
      if (target.closest("button")) return;
      const pos = kind === "input" ? inputPosRef.current.get(id) : busPosRef.current.get(id);
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
        } else {
          setSelBuses((s) => {
            const next = new Set(s);
            const bid = id as BusId;
            if (next.has(bid)) next.delete(bid);
            else next.add(bid);
            return next;
          });
        }
        e.preventDefault();
        return;
      }
      // Capture starting positions for every selected node so group
      // drag moves them together. If this node isn't already in the
      // selection, treat as a single-node drag (group of one).
      const groupStart = new Map<string, NodePos>();
      const inMulti =
        (kind === "input" && selInputsRef.current.has(id)) ||
        (kind === "bus" && selBusesRef.current.has(id as BusId));
      if (inMulti) {
        for (const inId of selInputsRef.current) {
          const p = inputPosRef.current.get(inId);
          if (p) groupStart.set(`i:${inId}`, p);
        }
        for (const bId of selBusesRef.current) {
          const p = busPosRef.current.get(bId);
          if (p) groupStart.set(`b:${bId}`, p);
        }
      } else {
        groupStart.set(kind === "input" ? `i:${id}` : `b:${id}`, pos);
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

      let hoverBusId: BusId | null = null;
      for (const [id, pos] of busPosRef.current) {
        const portX = pos.x;
        const portY = pos.y + BUS_H / 2;
        const dx = x - portX;
        const dy = y - portY;
        if (dx * dx + dy * dy < 32 * 32) {
          hoverBusId = id as BusId;
          break;
        }
      }

      setDrag((d) => (d ? { ...d, curX: x, curY: y, hoverBusId } : null));
    };

    const onUp = () => {
      // Read drag state via the ref, never inside the setDrag updater.
      // React 18 StrictMode invokes updaters twice; a side effect like
      // onToggleSend in there would double-fire and net-cancel itself,
      // which is why connections appeared in Flow/Matrix but vanished
      // from NodeView on release.
      const d = dragRef.current;
      if (d && d.hoverBusId) {
        onToggleSend(d.fromInputId, d.hoverBusId);
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
      // mousedown (single-node drags are just a group of one).
      const inputDeltas: Array<[string, NodePos]> = [];
      const busDeltas: Array<[string, NodePos]> = [];
      for (const [key, p0] of nodeDrag.groupStart) {
        const x = Math.max(0, p0.x + dx);
        const y = Math.max(0, p0.y + dy);
        if (key.startsWith("i:")) inputDeltas.push([key.slice(2), { x, y }]);
        else busDeltas.push([key.slice(2), { x, y }]);
      }
      if (inputDeltas.length) {
        setInputPositions((prev) => {
          const next = new Map(prev);
          for (const [id, p] of inputDeltas) next.set(id, p);
          return next;
        });
      }
      if (busDeltas.length) {
        setBusPositions((prev) => {
          const next = new Map(prev);
          for (const [id, p] of busDeltas) next.set(id, p);
          return next;
        });
      }
    };

    const onUp = () => {
      // Persist positions on release.
      try {
        localStorage.setItem(
          LS_INPUTS,
          JSON.stringify(Array.from(inputPosRef.current.entries())),
        );
        localStorage.setItem(
          LS_BUSES,
          JSON.stringify(Array.from(busPosRef.current.entries())),
        );
      } catch {}
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
          return { zoom, tx: mx - (mx - v.tx) * k, ty: my - (my - v.ty) * k };
        });
      } else {
        setView((v) => ({ ...v, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY }));
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
      setView((v) => ({ ...v, tx: panning.startTx + dx, ty: panning.startTy + dy }));
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
      setMarquee((m) => {
        if (!m) return null;
        const x0 = Math.min(m.startX, m.curX);
        const y0 = Math.min(m.startY, m.curY);
        const x1 = Math.max(m.startX, m.curX);
        const y1 = Math.max(m.startY, m.curY);
        // No drag: a plain click on background just clears selection.
        if (x1 - x0 < 4 && y1 - y0 < 4) {
          clearMultiSelect();
          return null;
        }
        const hitInputs = new Set<string>();
        for (const [id, p] of inputPosRef.current) {
          if (p.x + INPUT_W >= x0 && p.x <= x1 && p.y + INPUT_H >= y0 && p.y <= y1) {
            hitInputs.add(id);
          }
        }
        const hitBuses = new Set<BusId>();
        for (const [id, p] of busPosRef.current) {
          if (p.x + BUS_W >= x0 && p.x <= x1 && p.y + BUS_H >= y0 && p.y <= y1) {
            hitBuses.add(id as BusId);
          }
        }
        setSelInputs(hitInputs);
        setSelBuses(hitBuses);
        return null;
      });
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
      return { zoom, tx: mx - (mx - v.tx) * k, ty: my - (my - v.ty) * k };
    });
  }, []);

  const resetView = useCallback(() => {
    setView({ tx: 0, ty: 0, zoom: 1 });
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
      localStorage.removeItem(LS_INPUTS);
      localStorage.removeItem(LS_BUSES);
    } catch {}
    const ip = new Map<string, NodePos>();
    inputs.forEach((input, i) => {
      ip.set(input.id, { x: COL_PAD, y: COL_PAD + i * (INPUT_H + INPUT_GAP) });
    });
    setInputPositions(ip);
    const bp = new Map<string, NodePos>();
    const busColX = COL_PAD + INPUT_W + COL_GAP_BETWEEN;
    buses.forEach((bus, i) => {
      bp.set(bus.id, { x: busColX, y: COL_PAD + i * (BUS_H + BUS_GAP) });
    });
    setBusPositions(bp);
  };

  // ── Generalized routing graph ────────────────────────────────────────
  // Phase G-1b consumption: the canonical source of connectivity is now
  // the generalized Graph derived from the bipartite UI model. Wires +
  // the selected-wire popover walk graph.edges; future non-bipartite
  // nodes (group/fx) flow through the same code path without further
  // changes here.
  const graph = useMemo(
    () => bipartiteToGraph(buses, inputs, sends),
    [buses, inputs, sends],
  );

  // ── Wires to draw ─────────────────────────────────────────────────────
  const wires = useMemo(() => {
    const out: Array<{
      edge: GraphEdge;
      ip: { x: number; y: number };
      bp: { x: number; y: number };
      input: AudioInput;
      bus: Bus;
    }> = [];
    for (const edge of graph.edges.values()) {
      const fromNode = graph.nodes.get(edge.fromNode);
      const toNode = graph.nodes.get(edge.toNode);
      if (!fromNode || !toNode) continue;
      const inMeta = asInputNode(fromNode);
      const busMeta = asBusNode(toNode);
      if (!inMeta || !busMeta) continue; // skip non-bipartite edges this turn
      const ipPos = inputPositions.get(inMeta.backing.id);
      const bpPos = busPositions.get(busMeta.backing.id);
      if (!ipPos || !bpPos) continue;
      out.push({
        edge,
        ip: { x: ipPos.x + INPUT_W, y: ipPos.y + INPUT_H / 2 },
        bp: { x: bpPos.x, y: bpPos.y + BUS_H / 2 },
        input: inMeta.backing,
        bus: busMeta.backing,
      });
    }
    return out;
  }, [graph, inputPositions, busPositions]);

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
        <ColumnLabel x={COL_PAD + INPUT_W + COL_GAP_BETWEEN} label="Buses" />

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

          {/* Render wires (selected/hovered last for z-order) */}
          {wires.map((w) => {
            const id = w.edge.id;
            const isHover = hoverWire === id;
            const isSelected = selectedWire === id;
            const isLevelFlow =
              w.bus.enabled && !w.edge.muted && !w.input.muted && w.input.level > 0.05;
            return (
              <Wire
                key={id}
                id={id}
                fromX={w.ip.x}
                fromY={w.ip.y}
                toX={w.bp.x}
                toY={w.bp.y}
                color={busColor(w.bus.id)}
                gain={w.edge.gain}
                muted={w.edge.muted}
                flowing={isLevelFlow}
                flowSpeed={w.input.level}
                hovered={isHover}
                selected={isSelected}
                onClick={onWireClick}
                onMouseEnter={onWireHoverEnter}
                onMouseLeave={onWireHoverLeave}
              />
            );
          })}

          {/* Ghost wire while dragging */}
          {drag && (
            <Wire
              fromX={drag.startX}
              fromY={drag.startY}
              toX={drag.curX}
              toY={drag.curY}
              color={drag.hoverBusId ? busColor(drag.hoverBusId) : "rgba(255,255,255,0.4)"}
              gain={0.75}
              muted={false}
              flowing={false}
              flowSpeed={0}
              hovered={true}
              selected={false}
              dashed
            />
          )}
        </svg>

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
      }`}
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
        <div className={styles.busNodeState}>
          <span className={styles.busStateDot} style={{ background: stateDotColor(bus.state) }} />
          <span>{stateLabel(bus.state)}</span>
        </div>
      </div>
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
