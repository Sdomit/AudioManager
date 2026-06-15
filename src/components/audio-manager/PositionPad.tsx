import { useRef } from "react";

interface PositionPadProps {
  /** Azimuth in degrees: 0 = front (top), +90 = right, ±180 = behind (bottom). */
  azimuthDeg: number;
  /** Distance 0 (at the head, center) .. 1 (far, rim). */
  distance: number;
  onChange: (azimuthDeg: number, distance: number) => void;
  /** Rendered size in CSS px (square). */
  size?: number;
}

const VB = 120; // viewBox units (square)
const C = VB / 2; // center
const R = 50; // max handle radius (margin leaves room for F/B/L/R labels)

/** Polar (azimuth°, distance) → viewBox x/y. Front = up, right = +x. */
function toXY(azimuthDeg: number, distance: number): { x: number; y: number } {
  const a = (azimuthDeg * Math.PI) / 180;
  const r = Math.max(0, Math.min(1, distance)) * R;
  return { x: C + r * Math.sin(a), y: C - r * Math.cos(a) };
}

/** viewBox x/y → polar (azimuth° in -180..180, distance 0..1). */
function toPolar(x: number, y: number): { azimuthDeg: number; distance: number } {
  const dx = x - C;
  const dy = y - C;
  const distance = Math.min(1, Math.hypot(dx, dy) / R);
  const azimuthDeg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return { azimuthDeg, distance };
}

/**
 * Top-down "POSITION" pad (#binaural). The listener is at the centre facing up;
 * dragging the handle sets azimuth (direction) and distance (radius). Wired to
 * `SpatialConfig.azimuth_deg` / `distance`, it drives the binaural spatialiser.
 *
 * Hand-rolled pointer drag (pointer capture), matching EqGraph — no drag library.
 */
export function PositionPad({ azimuthDeg, distance, onChange, size = 132 }: PositionPadProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);

  const emitFromEvent = (e: { clientX: number; clientY: number }) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const x = ((e.clientX - rect.left) / rect.width) * VB;
    const y = ((e.clientY - rect.top) / rect.height) * VB;
    const p = toPolar(x, y);
    onChange(p.azimuthDeg, p.distance);
  };

  const handle = toXY(azimuthDeg, distance);

  const onKeyDown = (e: React.KeyboardEvent) => {
    let az = azimuthDeg;
    let d = distance;
    switch (e.key) {
      case "ArrowLeft":
        az -= 5;
        break;
      case "ArrowRight":
        az += 5;
        break;
      case "ArrowUp":
        d += 0.05;
        break;
      case "ArrowDown":
        d -= 0.05;
        break;
      case "Home":
        az = 0;
        d = 0;
        break;
      default:
        return;
    }
    e.preventDefault();
    if (az > 180) az -= 360;
    if (az < -180) az += 360;
    onChange(az, Math.max(0, Math.min(1, d)));
  };

  const label = (() => {
    if (distance < 0.02) return "centre";
    const a = Math.round(azimuthDeg);
    const side = a === 0 ? "front" : Math.abs(a) === 180 ? "behind" : a > 0 ? "right" : "left";
    return `${Math.abs(a)}° ${side}, distance ${Math.round(distance * 100)}%`;
  })();

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${VB} ${VB}`}
      width={size}
      height={size}
      role="slider"
      tabIndex={0}
      aria-label={`3D position: ${label}. Arrow keys move; Home centres.`}
      aria-valuetext={label}
      style={{ touchAction: "none", cursor: "crosshair", display: "block" }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        emitFromEvent(e);
      }}
      onPointerMove={(e) => {
        if (e.buttons !== 1) return;
        emitFromEvent(e);
      }}
      onDoubleClick={() => onChange(0, 0)}
      onKeyDown={onKeyDown}
    >
      {/* Backdrop */}
      <circle cx={C} cy={C} r={R + 6} fill="var(--am-surface-2, rgba(255,255,255,0.04))" stroke="var(--am-border, rgba(255,255,255,0.14))" />
      {/* Range rings */}
      {[0.33, 0.66, 1].map((f) => (
        <circle
          key={f}
          cx={C}
          cy={C}
          r={R * f}
          fill="none"
          stroke="var(--am-border, rgba(255,255,255,0.12))"
          strokeWidth={0.6}
        />
      ))}
      {/* Crosshair */}
      <line x1={C} y1={C - R} x2={C} y2={C + R} stroke="var(--am-border, rgba(255,255,255,0.10))" strokeWidth={0.6} />
      <line x1={C - R} y1={C} x2={C + R} y2={C} stroke="var(--am-border, rgba(255,255,255,0.10))" strokeWidth={0.6} />
      {/* Head marker at centre */}
      <circle cx={C} cy={C} r={3} fill="var(--am-text-dim, rgba(255,255,255,0.45))" />
      {/* Direction labels */}
      {[
        { t: "F", x: C, y: 9 },
        { t: "B", x: C, y: VB - 4 },
        { t: "L", x: 7, y: C + 3 },
        { t: "R", x: VB - 7, y: C + 3 },
      ].map((l) => (
        <text
          key={l.t}
          x={l.x}
          y={l.y}
          textAnchor="middle"
          fontSize={9}
          fill="var(--am-text-dim, rgba(255,255,255,0.5))"
        >
          {l.t}
        </text>
      ))}
      {/* Lead line from head to handle */}
      <line x1={C} y1={C} x2={handle.x} y2={handle.y} stroke="var(--am-accent, #4f8cff)" strokeWidth={1} opacity={0.5} />
      {/* Handle */}
      <circle cx={handle.x} cy={handle.y} r={7} fill="var(--am-accent, #4f8cff)" stroke="#000" strokeWidth={0.5} />
    </svg>
  );
}
