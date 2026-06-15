/**
 * Reusable DSP editing controls.
 *
 * `InputDspControls` edits a full per-input chain (HPF → Gate → EQ →
 * Compressor → Limiter). `BusLimiterControls` edits the per-bus final limiter.
 *
 * Both are controlled: they call `onChange` with the complete next config on
 * every edit. The parent hook throttles the resulting IPC write (one invoke
 * per animation frame) and the backend re-clamps every value, so the sliders
 * here only need sensible travel — see `DSP_RANGE` in `dspDefaults.ts`.
 */

import { useId, useRef, useState } from "react";

import { orderedInputFx, reorderInputFx, type InputFxKey } from "./inputFx";
import type {
  BandKind,
  CompressorConfig,
  DenoiseConfig,
  DspConfig,
  EqBand,
  EqConfig,
  GateConfig,
  HpfConfig,
  LimiterConfig,
  StereoConfig,
} from "../../types/engine";
import {
  BAND_KINDS,
  bandUsesGain,
  bandUsesQ,
  defaultDspConfig,
  defaultStereo,
  DSP_RANGE,
  isStereoActive,
} from "./dspDefaults";
import { EqGraph } from "./EqGraph";
import styles from "./DspControls.module.css";

/* ── Primitives ─────────────────────────────────────────────────────────── */

function Param({
  label,
  value,
  range,
  unit,
  precision = 0,
  disabled,
  format,
  onReset,
  onChange,
}: {
  label: string;
  value: number;
  range: readonly [number, number, number];
  unit?: string;
  precision?: number;
  disabled?: boolean;
  /** Custom readout (overrides `value.toFixed`/`unit`), e.g. pan "L50". */
  format?: (v: number) => string;
  /** Double-click on the slider snaps back to this value (e.g. recenter). */
  onReset?: () => void;
  onChange: (v: number) => void;
}) {
  const [min, max, step] = range;
  const id = useId();
  return (
    <div className={styles.param} data-disabled={disabled ? "" : undefined}>
      <label className={styles.paramLabel} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={onReset}
        className={styles.slider}
      />
      <span className={styles.paramValue}>
        {format ? (
          format(value)
        ) : (
          <>
            {value.toFixed(precision)}
            {unit ? <span className={styles.unit}>{unit}</span> : null}
          </>
        )}
      </span>
    </div>
  );
}

function fmtPan(pan: number): string {
  if (pan === 0) return "C";
  const pct = Math.round(Math.abs(pan) * 100);
  return pan < 0 ? `L${pct}` : `R${pct}`;
}

/** Stereo image controls (#34). Always visible (no enable toggle): the controls
 *  default to transparent, and Reset restores that. */
export function StereoSection({
  stereo,
  onChange,
}: {
  stereo: StereoConfig;
  onChange: (next: StereoConfig) => void;
}) {
  const patch = (p: Partial<StereoConfig>) => onChange({ ...stereo, ...p });
  const active = isStereoActive(stereo);
  return (
    <div className={styles.effect} data-on={active ? "" : undefined}>
      <div className={styles.effectHeader}>
        <span className={styles.effectTitle}>Stereo</span>
        <button
          type="button"
          className={styles.stereoReset}
          disabled={!active}
          onClick={() => onChange(defaultStereo())}
        >
          Reset
        </button>
      </div>
      <div className={styles.params}>
        <Param
          label="Pan"
          value={stereo.pan}
          range={DSP_RANGE.stereoPan}
          format={fmtPan}
          onReset={() => patch({ pan: 0 })}
          onChange={(v) => patch({ pan: v })}
        />
        <div className={styles.toggleRow}>
          <button
            type="button"
            className={styles.pill}
            data-on={stereo.mono ? "" : undefined}
            aria-pressed={stereo.mono}
            title="Sum to mono"
            onClick={() => patch({ mono: !stereo.mono })}
          >
            Mono
          </button>
          <button
            type="button"
            className={styles.pill}
            data-on={stereo.swap ? "" : undefined}
            aria-pressed={stereo.swap}
            title="Swap left / right"
            onClick={() => patch({ swap: !stereo.swap })}
          >
            Swap L/R
          </button>
          <button
            type="button"
            className={styles.pill}
            data-on={stereo.invert_left ? "" : undefined}
            aria-pressed={stereo.invert_left}
            title="Invert left polarity"
            onClick={() => patch({ invert_left: !stereo.invert_left })}
          >
            Ø L
          </button>
          <button
            type="button"
            className={styles.pill}
            data-on={stereo.invert_right ? "" : undefined}
            aria-pressed={stereo.invert_right}
            title="Invert right polarity"
            onClick={() => patch({ invert_right: !stereo.invert_right })}
          >
            Ø R
          </button>
        </div>
        <Param
          label="Center"
          value={stereo.center_level}
          range={DSP_RANGE.stereoCenter}
          unit="×"
          precision={2}
          onReset={() => patch({ center_level: 1 })}
          onChange={(v) => patch({ center_level: v })}
        />
        <Param
          label="Width"
          value={stereo.width}
          range={DSP_RANGE.stereoWidth}
          unit="×"
          precision={2}
          onReset={() => patch({ width: 1 })}
          onChange={(v) => patch({ width: v })}
        />
      </div>
    </div>
  );
}

function EffectSection({
  title,
  enabled,
  onToggle,
  children,
}: {
  title: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className={styles.effect} data-on={enabled ? "" : undefined}>
      <div className={styles.effectHeader}>
        <span className={styles.effectTitle}>{title}</span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`${title} ${enabled ? "on" : "off"}`}
          className={styles.toggle}
          data-on={enabled ? "" : undefined}
          onClick={() => onToggle(!enabled)}
        >
          <span className={styles.toggleKnob} />
        </button>
      </div>
      {enabled && children ? (
        <div className={styles.params}>{children}</div>
      ) : null}
    </div>
  );
}

/* ── EQ editor (graph + per-band rows) ──────────────────────────────────── */

/** Shared parametric-EQ editor used by both input and bus chains. Renders the
 *  interactive response graph plus one row per band (shape, freq, gain, Q). */
function EqEditor({
  eq,
  onChange,
}: {
  eq: EqConfig;
  onChange: (next: EqConfig) => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const setBands = (bands: EqBand[]) => onChange({ ...eq, bands });
  const setBand = (i: number, patch: Partial<EqBand>) =>
    setBands(eq.bands.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));

  return (
    <>
      <EqGraph
        bands={eq.bands}
        selected={selected}
        onSelect={setSelected}
        onChange={setBands}
      />
      {eq.bands.map((band, i) => (
        <div
          key={i}
          className={styles.band}
          data-selected={selected === i ? "" : undefined}
        >
          <div className={styles.bandHeader}>
            <span className={styles.bandLabel}>Band {i + 1}</span>
            <select
              className={styles.kindSelect}
              value={band.kind}
              aria-label={`Band ${i + 1} type`}
              onChange={(e) => setBand(i, { kind: e.target.value as BandKind })}
            >
              {BAND_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              role="switch"
              aria-checked={band.enabled}
              aria-label={`Band ${i + 1} ${band.enabled ? "on" : "off"}`}
              className={styles.toggle}
              data-on={band.enabled ? "" : undefined}
              onClick={() => setBand(i, { enabled: !band.enabled })}
            >
              <span className={styles.toggleKnob} />
            </button>
          </div>
          <Param
            label="Freq"
            value={band.freq_hz}
            range={DSP_RANGE.eqFreq}
            unit="Hz"
            disabled={!band.enabled}
            onChange={(v) => setBand(i, { freq_hz: v })}
          />
          {bandUsesGain(band.kind) ? (
            <Param
              label="Gain"
              value={band.gain_db}
              range={DSP_RANGE.eqGain}
              unit="dB"
              precision={1}
              disabled={!band.enabled}
              onChange={(v) => setBand(i, { gain_db: v })}
            />
          ) : null}
          {bandUsesQ(band.kind) ? (
            <Param
              label="Q"
              value={band.q}
              range={DSP_RANGE.eqQ}
              precision={1}
              disabled={!band.enabled}
              onChange={(v) => setBand(i, { q: v })}
            />
          ) : null}
        </div>
      ))}
    </>
  );
}

/* ── Bus EQ + limiter ───────────────────────────────────────────────────── */

export function BusEqControls({
  eq,
  onChange,
}: {
  eq: EqConfig;
  onChange: (next: EqConfig) => void;
}) {
  return (
    <div className={styles.chain}>
      <EffectSection
        title="EQ"
        enabled={eq.enabled}
        onToggle={(enabled) => onChange({ ...eq, enabled })}
      >
        <EqEditor eq={eq} onChange={onChange} />
      </EffectSection>
    </div>
  );
}

/* ── Bus limiter ────────────────────────────────────────────────────────── */

export function BusLimiterControls({
  limiter,
  onChange,
}: {
  limiter: LimiterConfig;
  onChange: (next: LimiterConfig) => void;
}) {
  const set = (patch: Partial<LimiterConfig>) => onChange({ ...limiter, ...patch });
  return (
    <div className={styles.chain}>
      <EffectSection
        title="Limiter"
        enabled={limiter.enabled}
        onToggle={(enabled) => set({ enabled })}
      >
        <Param
          label="Ceiling"
          value={limiter.threshold_db}
          range={DSP_RANGE.limThreshold}
          unit="dB"
          precision={1}
          onChange={(v) => set({ threshold_db: v })}
        />
        <Param
          label="Attack"
          value={limiter.attack_ms}
          range={DSP_RANGE.limAttack}
          unit="ms"
          precision={1}
          onChange={(v) => set({ attack_ms: v })}
        />
        <Param
          label="Release"
          value={limiter.release_ms}
          range={DSP_RANGE.limRelease}
          unit="ms"
          onChange={(v) => set({ release_ms: v })}
        />
      </EffectSection>
    </div>
  );
}

/* ── Input chain ────────────────────────────────────────────────────────── */

/**
 * Drag-to-reorder strip for the per-input effect chain (#feature5).
 *
 * The node canvas reorders effects by wiring fx ports; flow and matrix modes
 * have no canvas, so this compact strip gives them the same control. It lists
 * the enabled effects in their wired order (`dsp.order`) and lets the user drag
 * one chip onto another to splice it before that stage, mutating `dsp.order`
 * via the shared `reorderInputFx` helper. Hand-rolled mouse drag (window-level
 * mouseup, matching NodeView) — no drag library. Hidden when fewer than two
 * effects are enabled (nothing to reorder).
 */
function FxOrderStrip({
  dsp,
  onChange,
}: {
  dsp: DspConfig;
  onChange: (next: DspConfig) => void;
}) {
  const ordered = orderedInputFx(dsp);
  const [dragKey, setDragKey] = useState<InputFxKey | null>(null);
  const [overKey, setOverKey] = useState<InputFxKey | null>(null);
  const dragRef = useRef<InputFxKey | null>(null);
  const overRef = useRef<InputFxKey | null>(null);

  if (ordered.length < 2) return null;

  const begin = (key: InputFxKey) => {
    dragRef.current = key;
    overRef.current = key;
    setDragKey(key);
    setOverKey(key);
    const onUp = () => {
      const from = dragRef.current;
      const before = overRef.current;
      if (from && before && from !== before) {
        onChange(reorderInputFx(dsp, from, before));
      }
      dragRef.current = null;
      overRef.current = null;
      setDragKey(null);
      setOverKey(null);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mouseup", onUp);
  };

  const enter = (key: InputFxKey) => {
    if (!dragRef.current) return;
    overRef.current = key;
    setOverKey(key);
  };

  // Keyboard a11y: swap a focused chip with its adjacent enabled neighbour via
  // Alt+Arrow. Always routes through reorderInputFx so disabled stages keep
  // their place in the full dsp.order (only the moved stage is repositioned).
  const nudge = (key: InputFxKey, dir: -1 | 1) => {
    const keys = ordered.map((f) => f.key);
    const i = keys.indexOf(key);
    const j = i + dir;
    if (j < 0 || j >= keys.length) return;
    const neighbor = keys[j];
    onChange(
      dir === 1
        ? reorderInputFx(dsp, neighbor, key) // pull next neighbour before key
        : reorderInputFx(dsp, key, neighbor), // push key before prev neighbour
    );
  };

  return (
    <div
      role="list"
      aria-label="Effect order — drag a stage to reorder"
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 4,
        marginBottom: 8,
        userSelect: "none",
      }}
    >
      {ordered.map((fx, i) => {
        const dragging = dragKey === fx.key;
        const over = overKey === fx.key && dragKey !== null && !dragging;
        return (
          <button
            key={fx.key}
            type="button"
            role="listitem"
            aria-label={`${fx.label}, position ${i + 1} of ${ordered.length}. Drag to reorder, or Alt+Arrow keys.`}
            onMouseDown={() => begin(fx.key)}
            onMouseEnter={() => enter(fx.key)}
            onKeyDown={(e) => {
              if (e.altKey && e.key === "ArrowLeft") {
                e.preventDefault();
                nudge(fx.key, -1);
              } else if (e.altKey && e.key === "ArrowRight") {
                e.preventDefault();
                nudge(fx.key, 1);
              }
            }}
            style={{
              cursor: "grab",
              padding: "2px 8px",
              borderRadius: 6,
              border: `1px solid ${over ? "var(--am-accent)" : "var(--am-border, rgba(255,255,255,0.14))"}`,
              background: over
                ? "var(--am-accent)"
                : "var(--am-surface-2, rgba(255,255,255,0.06))",
              color: over ? "#000" : "var(--am-text, inherit)",
              fontSize: 11,
              opacity: dragging ? 0.45 : 1,
            }}
          >
            {i > 0 && <span aria-hidden style={{ opacity: 0.4, marginRight: 4 }}>→</span>}
            {fx.label}
          </button>
        );
      })}
    </div>
  );
}

export function InputDspControls({
  dsp,
  onChange,
  onStreamVoice,
}: {
  dsp: DspConfig;
  onChange: (next: DspConfig) => void;
  /** When provided, render a "Stream Voice" preset button (#33) + Reset. */
  onStreamVoice?: () => void;
}) {
  const setDenoise = (patch: Partial<DenoiseConfig>) =>
    onChange({ ...dsp, denoise: { ...dsp.denoise, ...patch } });
  const setHpf = (patch: Partial<HpfConfig>) =>
    onChange({ ...dsp, hpf: { ...dsp.hpf, ...patch } });
  const setGate = (patch: Partial<GateConfig>) =>
    onChange({ ...dsp, gate: { ...dsp.gate, ...patch } });
  const setComp = (patch: Partial<CompressorConfig>) =>
    onChange({ ...dsp, compressor: { ...dsp.compressor, ...patch } });
  const setLim = (patch: Partial<LimiterConfig>) =>
    onChange({ ...dsp, limiter: { ...dsp.limiter, ...patch } });
  const setEqEnabled = (enabled: boolean) =>
    onChange({ ...dsp, eq: { ...dsp.eq, enabled } });

  return (
    <div className={styles.chain}>
      {onStreamVoice && (
        <div className={styles.presetRow}>
          <button
            type="button"
            className={styles.presetBtn}
            onClick={onStreamVoice}
            title="Apply the Stream Voice chain (HP → gate → EQ → comp) and arm B1 protection"
          >
            Stream Voice
          </button>
          <button
            type="button"
            className={styles.stereoReset}
            onClick={() => onChange(defaultDspConfig())}
            title="Reset all stages to defaults (bypassed)"
          >
            Reset
          </button>
        </div>
      )}

      <FxOrderStrip dsp={dsp} onChange={onChange} />

      <EffectSection
        title="Noise suppression (AI)"
        enabled={dsp.denoise.enabled}
        onToggle={(enabled) => setDenoise({ enabled })}
      >
        <p className={styles.note}>
          RNNoise neural denoiser · 48 kHz · adds ~10 ms latency. Best on a
          voice mic. No parameters — it adapts automatically.
        </p>
      </EffectSection>

      <EffectSection
        title="High-pass"
        enabled={dsp.hpf.enabled}
        onToggle={(enabled) => setHpf({ enabled })}
      >
        <Param
          label="Freq"
          value={dsp.hpf.freq_hz}
          range={DSP_RANGE.hpfFreq}
          unit="Hz"
          onChange={(v) => setHpf({ freq_hz: v })}
        />
      </EffectSection>

      <EffectSection
        title="Noise gate"
        enabled={dsp.gate.enabled}
        onToggle={(enabled) => setGate({ enabled })}
      >
        <Param
          label="Threshold"
          value={dsp.gate.threshold_db}
          range={DSP_RANGE.gateThreshold}
          unit="dB"
          onChange={(v) => setGate({ threshold_db: v })}
        />
        <Param
          label="Attack"
          value={dsp.gate.attack_ms}
          range={DSP_RANGE.gateAttack}
          unit="ms"
          precision={1}
          onChange={(v) => setGate({ attack_ms: v })}
        />
        <Param
          label="Release"
          value={dsp.gate.release_ms}
          range={DSP_RANGE.gateRelease}
          unit="ms"
          onChange={(v) => setGate({ release_ms: v })}
        />
        <Param
          label="Hold"
          value={dsp.gate.hold_ms}
          range={DSP_RANGE.gateHold}
          unit="ms"
          onChange={(v) => setGate({ hold_ms: v })}
        />
      </EffectSection>

      <EffectSection
        title="EQ"
        enabled={dsp.eq.enabled}
        onToggle={setEqEnabled}
      >
        <EqEditor eq={dsp.eq} onChange={(eq) => onChange({ ...dsp, eq })} />
      </EffectSection>

      <EffectSection
        title="Compressor"
        enabled={dsp.compressor.enabled}
        onToggle={(enabled) => setComp({ enabled })}
      >
        <Param
          label="Threshold"
          value={dsp.compressor.threshold_db}
          range={DSP_RANGE.compThreshold}
          unit="dB"
          onChange={(v) => setComp({ threshold_db: v })}
        />
        <Param
          label="Ratio"
          value={dsp.compressor.ratio}
          range={DSP_RANGE.compRatio}
          unit=":1"
          precision={1}
          onChange={(v) => setComp({ ratio: v })}
        />
        <Param
          label="Attack"
          value={dsp.compressor.attack_ms}
          range={DSP_RANGE.compAttack}
          unit="ms"
          precision={1}
          onChange={(v) => setComp({ attack_ms: v })}
        />
        <Param
          label="Release"
          value={dsp.compressor.release_ms}
          range={DSP_RANGE.compRelease}
          unit="ms"
          onChange={(v) => setComp({ release_ms: v })}
        />
        <Param
          label="Makeup"
          value={dsp.compressor.makeup_db}
          range={DSP_RANGE.compMakeup}
          unit="dB"
          precision={1}
          onChange={(v) => setComp({ makeup_db: v })}
        />
      </EffectSection>

      <EffectSection
        title="Limiter"
        enabled={dsp.limiter.enabled}
        onToggle={(enabled) => setLim({ enabled })}
      >
        <Param
          label="Ceiling"
          value={dsp.limiter.threshold_db}
          range={DSP_RANGE.limThreshold}
          unit="dB"
          precision={1}
          onChange={(v) => setLim({ threshold_db: v })}
        />
        <Param
          label="Attack"
          value={dsp.limiter.attack_ms}
          range={DSP_RANGE.limAttack}
          unit="ms"
          precision={1}
          onChange={(v) => setLim({ attack_ms: v })}
        />
        <Param
          label="Release"
          value={dsp.limiter.release_ms}
          range={DSP_RANGE.limRelease}
          unit="ms"
          onChange={(v) => setLim({ release_ms: v })}
        />
      </EffectSection>
    </div>
  );
}
