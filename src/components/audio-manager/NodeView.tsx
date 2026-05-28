import { useCallback, useEffect, useRef, useState } from "react";
import {
  iconForBusRole,
  iconForKind,
  MuteIcon,
  XIcon,
} from "./Icon";
import type {
  AudioInput,
  Bus,
  BusId,
  DetailSelection,
  Send,
} from "./types";
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
  onToggleSend: (inputId: string, busId: BusId) => void;
  onSendGainChange: (inputId: string, busId: BusId, v: number) => void;
  onSendMuted: (inputId: string, busId: BusId, muted: boolean) => void;
  onSelectInput: (id: string) => void;
  onSelectBus: (id: BusId) => void;
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
}

type NodePos = { x: number; y: number };

const LS_INPUTS = "am.nodePositions.inputs";
const LS_BUSES  = "am.nodePositions.buses";

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
  onToggleSend,
  onSendGainChange,
  onSendMuted,
  onSelectInput,
  onSelectBus,
}: NodeViewProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [nodeDrag, setNodeDrag] = useState<NodeDragState | null>(null);
  const [hoverInput, setHoverInput] = useState<string | null>(null);
  const [hoverBus, setHoverBus] = useState<BusId | null>(null);
  const [hoverWire, setHoverWire] = useState<string | null>(null);
  const [selectedWire, setSelectedWire] = useState<string | null>(null);

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
  const allPositions = [
    ...Array.from(inputPositions.values()).map((p) => ({ x: p.x + INPUT_W, y: p.y + INPUT_H })),
    ...Array.from(busPositions.values()).map((p) => ({ x: p.x + BUS_W, y: p.y + BUS_H })),
  ];
  const canvasW = Math.max(
    COL_PAD + INPUT_W + COL_GAP_BETWEEN + BUS_W + COL_PAD,
    ...allPositions.map((p) => p.x + COL_PAD),
    400,
  );
  const canvasH = Math.max(
    400,
    ...allPositions.map((p) => p.y + COL_PAD),
  );

  // ── Mouse handlers for drag-to-connect ────────────────────────────────
  const handlePortMouseDown = useCallback(
    (inputId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const port = portOf("input", inputId);
      if (!port) return;
      setDrag({
        fromInputId: inputId,
        startX: port.x,
        startY: port.y,
        curX: port.x,
        curY: port.y,
        hoverBusId: null,
      });
    },
    [inputPositions],
  );

  // ── Mouse handlers for moving a node ──────────────────────────────────
  const handleNodeMouseDown = useCallback(
    (kind: "input" | "bus", id: string, e: React.MouseEvent) => {
      // Only left mouse button initiates a drag.
      if (e.button !== 0) return;
      // Ignore clicks on interactive children (ports, buttons).
      const target = e.target as HTMLElement;
      if (target.closest("button")) return;
      const pos = kind === "input" ? inputPositions.get(id) : busPositions.get(id);
      if (!pos) return;
      setNodeDrag({
        kind,
        id,
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        startNodeX: pos.x,
        startNodeY: pos.y,
        moved: false,
      });
      e.preventDefault();
    },
    [inputPositions, busPositions],
  );

  useEffect(() => {
    if (!drag) return;
    const wrap = wrapRef.current;
    if (!wrap) return;

    const onMove = (e: MouseEvent) => {
      const rect = wrap.getBoundingClientRect();
      const x = e.clientX - rect.left + wrap.scrollLeft;
      const y = e.clientY - rect.top + wrap.scrollTop;

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
      setDrag((d) => {
        if (d && d.hoverBusId) {
          onToggleSend(d.fromInputId, d.hoverBusId);
        }
        return null;
      });
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, onToggleSend]);

  // ── Node-drag effect (moving a node around the canvas) ───────────────
  useEffect(() => {
    if (!nodeDrag) return;

    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - nodeDrag.startMouseX;
      const dy = e.clientY - nodeDrag.startMouseY;
      const newX = Math.max(0, nodeDrag.startNodeX + dx);
      const newY = Math.max(0, nodeDrag.startNodeY + dy);
      // Mark moved so a click-without-drag still acts as a regular click.
      setNodeDrag((d) => (d && (dx !== 0 || dy !== 0) ? { ...d, moved: true } : d));
      if (nodeDrag.kind === "input") {
        setInputPositions((prev) => {
          const next = new Map(prev);
          next.set(nodeDrag.id, { x: newX, y: newY });
          return next;
        });
      } else {
        setBusPositions((prev) => {
          const next = new Map(prev);
          next.set(nodeDrag.id, { x: newX, y: newY });
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

  // ── Wires to draw ─────────────────────────────────────────────────────
  const wires = sends
    .filter((s) => s.enabled)
    .map((s) => {
      const ip = portOf("input", s.inputId);
      const bp = portOf("bus", s.busId);
      const input = inputs.find((i) => i.id === s.inputId);
      const bus = buses.find((b) => b.id === s.busId);
      if (!ip || !bp || !input || !bus) return null;
      return { send: s, ip, bp, input, bus };
    })
    .filter(Boolean) as Array<{
      send: Send;
      ip: { x: number; y: number };
      bp: { x: number; y: number };
      input: AudioInput;
      bus: Bus;
    }>;

  return (
    <div
      ref={wrapRef}
      className={`${styles.wrap} ${nodeDrag ? styles.wrapDragging : ""}`}
      onClick={dismissOnBackgroundClick}
      role="region"
      aria-label="Node graph routing"
    >
      <button
        type="button"
        className={styles.resetBtn}
        onClick={(e) => {
          e.stopPropagation();
          resetLayout();
        }}
        title="Reset node positions"
      >
        Reset layout
      </button>
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
            const id = `${w.send.inputId}|${w.send.busId}`;
            const isHover = hoverWire === id;
            const isSelected = selectedWire === id;
            const isLevelFlow =
              w.bus.enabled && !w.send.muted && !w.input.muted && w.input.level > 0.05;
            return (
              <Wire
                key={id}
                fromX={w.ip.x}
                fromY={w.ip.y}
                toX={w.bp.x}
                toY={w.bp.y}
                color={busColor(w.bus.id)}
                gain={w.send.gain}
                muted={w.send.muted}
                flowing={isLevelFlow}
                flowSpeed={w.input.level}
                hovered={isHover}
                selected={isSelected}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedWire(id);
                }}
                onMouseEnter={() => setHoverWire(id)}
                onMouseLeave={() =>
                  setHoverWire((cur) => (cur === id ? null : cur))
                }
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

        {/* Input nodes */}
        {inputs.map((input) => {
          const pos = inputPositions.get(input.id);
          if (!pos) return null;
          const isSelected = selection.kind === "input" && selection.inputId === input.id;
          const isHover = hoverInput === input.id;
          const hasConnections = sends.some((s) => s.inputId === input.id && s.enabled);
          const isMoving = nodeDrag?.kind === "input" && nodeDrag.id === input.id;
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
              onMouseEnter={() => setHoverInput(input.id)}
              onMouseLeave={() => setHoverInput((c) => (c === input.id ? null : c))}
              onSelect={() => {
                if (!nodeDrag?.moved) onSelectInput(input.id);
              }}
              onNodeMouseDown={(e) => handleNodeMouseDown("input", input.id, e)}
              onPortMouseDown={(e) => handlePortMouseDown(input.id, e)}
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
              onMouseEnter={() => setHoverBus(bus.id)}
              onMouseLeave={() => setHoverBus((c) => (c === bus.id ? null : c))}
              onSelect={() => {
                if (!nodeDrag?.moved) onSelectBus(bus.id);
              }}
              onNodeMouseDown={(e) => handleNodeMouseDown("bus", bus.id, e)}
            />
          );
        })}

        {/* Wire detail panel for selected wire */}
        {selectedWire &&
          (() => {
            const [inputId, busId] = selectedWire.split("|") as [string, BusId];
            const send = sends.find(
              (s) => s.inputId === inputId && s.busId === busId,
            );
            const input = inputs.find((i) => i.id === inputId);
            const bus = buses.find((b) => b.id === busId);
            const ip = portOf("input", inputId);
            const bp = portOf("bus", busId);
            if (!send || !input || !bus || !ip || !bp) return null;
            const midX = (ip.x + bp.x) / 2;
            const midY = (ip.y + bp.y) / 2;
            return (
              <WirePopover
                x={midX}
                y={midY}
                input={input}
                bus={bus}
                send={send}
                onGainChange={(v) => onSendGainChange(inputId, busId, v)}
                onMuteToggle={() => onSendMuted(inputId, busId, !send.muted)}
                onRemove={() => {
                  onToggleSend(inputId, busId);
                  setSelectedWire(null);
                }}
                onClose={() => setSelectedWire(null)}
              />
            );
          })()}
      </div>
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
  onClick?: (e: React.MouseEvent) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

function Wire({
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
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
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
}

function InputNode({
  input,
  x,
  y,
  selected,
  hovered,
  hasConnections,
  dragging,
  moving,
  onMouseEnter,
  onMouseLeave,
  onSelect,
  onNodeMouseDown,
  onPortMouseDown,
}: {
  input: AudioInput;
  x: number;
  y: number;
  selected: boolean;
  hovered: boolean;
  hasConnections: boolean;
  dragging: boolean;
  moving: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onSelect: () => void;
  onNodeMouseDown: (e: React.MouseEvent) => void;
  onPortMouseDown: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      className={`${styles.inputNode} ${selected ? styles.nodeSelected : ""} ${
        hovered ? styles.nodeHovered : ""
      } ${input.muted ? styles.nodeMuted : ""} ${dragging ? styles.nodeDragging : ""} ${
        moving ? styles.nodeMoving : ""
      }`}
      style={{ left: x, top: y, width: INPUT_W, height: INPUT_H }}
      onMouseDown={onNodeMouseDown}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
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
        onMouseDown={onPortMouseDown}
        onClick={(e) => e.stopPropagation()}
        aria-label={`Drag from ${input.name} to connect to a bus`}
        title="Drag to a bus to connect"
      >
        <span className={styles.portInner} />
      </button>
    </div>
  );
}

function BusNode({
  bus,
  x,
  y,
  selected,
  hovered,
  dragTarget,
  moving,
  onMouseEnter,
  onMouseLeave,
  onSelect,
  onNodeMouseDown,
}: {
  bus: Bus;
  x: number;
  y: number;
  selected: boolean;
  hovered: boolean;
  dragTarget: boolean;
  moving: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onSelect: () => void;
  onNodeMouseDown: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      className={`${styles.busNode} ${selected ? styles.nodeSelected : ""} ${
        hovered ? styles.nodeHovered : ""
      } ${dragTarget ? styles.busNodeDragTarget : ""} ${
        bus.state === "running" || bus.state === "clipping" ? styles.busNodeLive : ""
      } ${bus.state === "error" ? styles.busNodeError : ""} ${
        moving ? styles.nodeMoving : ""
      }`}
      style={{
        left: x,
        top: y,
        width: BUS_W,
        height: BUS_H,
        ["--bus-accent" as any]: busColor(bus.id),
        ["--bus-accent-muted" as any]: `var(--am-bus-${bus.id.toLowerCase()}-muted)`,
      }}
      onMouseDown={onNodeMouseDown}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
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
    </div>
  );
}

function WirePopover({
  x,
  y,
  input,
  bus,
  send,
  onGainChange,
  onMuteToggle,
  onRemove,
  onClose,
}: {
  x: number;
  y: number;
  input: AudioInput;
  bus: Bus;
  send: Send;
  onGainChange: (v: number) => void;
  onMuteToggle: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
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

function gainToDb(g: number): string {
  if (g < 0.001) return "-∞ dB";
  const db = (g - 0.75) * 80;
  return `${db > 0 ? "+" : ""}${db.toFixed(0)} dB`;
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
