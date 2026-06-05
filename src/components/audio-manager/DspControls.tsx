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

import { useId } from "react";

import type {
  CompressorConfig,
  DspConfig,
  EqBand,
  GateConfig,
  HpfConfig,
  LimiterConfig,
} from "../../types/engine";
import { DSP_RANGE } from "./dspDefaults";
import styles from "./DspControls.module.css";

/* ── Primitives ─────────────────────────────────────────────────────────── */

function Param({
  label,
  value,
  range,
  unit,
  precision = 0,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  range: readonly [number, number, number];
  unit?: string;
  precision?: number;
  disabled?: boolean;
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
        className={styles.slider}
      />
      <span className={styles.paramValue}>
        {value.toFixed(precision)}
        {unit ? <span className={styles.unit}>{unit}</span> : null}
      </span>
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

export function InputDspControls({
  dsp,
  onChange,
}: {
  dsp: DspConfig;
  onChange: (next: DspConfig) => void;
}) {
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
  const setBand = (i: number, patch: Partial<EqBand>) => {
    const bands = dsp.eq.bands.map((b, idx) => (idx === i ? { ...b, ...patch } : b));
    onChange({ ...dsp, eq: { ...dsp.eq, bands } });
  };

  return (
    <div className={styles.chain}>
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
        {dsp.eq.bands.map((band, i) => (
          <div key={i} className={styles.band}>
            <div className={styles.bandHeader}>
              <span className={styles.bandLabel}>Band {i + 1}</span>
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
            <Param
              label="Gain"
              value={band.gain_db}
              range={DSP_RANGE.eqGain}
              unit="dB"
              precision={1}
              disabled={!band.enabled}
              onChange={(v) => setBand(i, { gain_db: v })}
            />
            <Param
              label="Q"
              value={band.q}
              range={DSP_RANGE.eqQ}
              precision={1}
              disabled={!band.enabled}
              onChange={(v) => setBand(i, { q: v })}
            />
          </div>
        ))}
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
