import { MeterCanvas } from "./MeterCanvas";

interface StereoMeterProps {
  /** Post-stereo left/right levels 0..1.2. Absent before the first meter poll. */
  levelL?: number;
  levelR?: number;
  /** Single-level fallback used when levelL/levelR are undefined. */
  level?: number;
  /** Source channel count. 1 (mono) renders a single bar; anything else two. */
  channels?: number;
  /** Fallback width in CSS px, forwarded to MeterCanvas. */
  width?: number;
  /** Total height in CSS px; split across the two bars in stereo mode. */
  height?: number;
  peakHold?: boolean;
  variant?: "bus" | "input";
}

/**
 * Stereo meter (#feature10): two stacked L/R bars that follow the post-stereo
 * signal, so pan / mono-fold / width are visible. A mono source (channels === 1)
 * collapses to a single bar — its one working channel — rather than showing two
 * identical (and misleading) bars.
 *
 * Built from two `MeterCanvas` instances to reuse the existing gradient, peak
 * hold, and resize behaviour.
 */
export function StereoMeter({
  levelL,
  levelR,
  level = 0,
  channels,
  width,
  height = 10,
  peakHold,
  variant = "input",
}: StereoMeterProps) {
  const l = levelL ?? level;
  const r = levelR ?? level;
  const mono = (channels ?? 2) === 1;

  if (mono) {
    return (
      <MeterCanvas
        level={l}
        width={width}
        height={height}
        peakHold={peakHold}
        variant={variant}
      />
    );
  }

  const gap = 2;
  const barH = Math.max(2, Math.floor((height - gap) / 2));
  return (
    <div
      aria-hidden
      style={{
        display: "flex",
        flexDirection: "column",
        gap,
        width: "100%",
        flex: 1,
        minWidth: 0,
      }}
    >
      <MeterCanvas level={l} width={width} height={barH} peakHold={peakHold} variant={variant} />
      <MeterCanvas level={r} width={width} height={barH} peakHold={peakHold} variant={variant} />
    </div>
  );
}
