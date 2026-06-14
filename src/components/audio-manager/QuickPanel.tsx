import { useCallback, useEffect, useRef, useState } from "react";

import * as ipc from "../../ipc/commands";
import type { BusId, DeviceInfo, PresetSummary, SystemStatus } from "../../types/engine";
import styles from "./QuickPanel.module.css";

const A1: BusId = "A1";

const R = 26;
const CIRC = 2 * Math.PI * R;
const TRACK_LEN = (270 / 360) * CIRC;
const MAX_VOL = 1.5;

function KnobSvg({
  volume,
  muted,
  onMouseDown,
}: {
  volume: number;
  muted: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
}) {
  const valueLen = Math.max(0, Math.min(1, volume / MAX_VOL)) * TRACK_LEN;
  const pct = Math.round(volume * 100);
  return (
    <svg
      width={72}
      height={72}
      className={styles.knob}
      onMouseDown={onMouseDown}
    >
      <g transform="rotate(135, 36, 36)">
        <circle
          cx={36}
          cy={36}
          r={R}
          fill="none"
          stroke="#2a2a2a"
          strokeWidth={5}
          strokeDasharray={`${TRACK_LEN} ${CIRC}`}
          strokeLinecap="round"
        />
        <circle
          cx={36}
          cy={36}
          r={R}
          fill="none"
          stroke={muted ? "#3a3a3a" : "#44aaff"}
          strokeWidth={5}
          strokeDasharray={`${valueLen} ${CIRC}`}
          strokeLinecap="round"
        />
      </g>
      <text
        x={36}
        y={40}
        textAnchor="middle"
        fill={muted ? "#444" : "#999"}
        fontSize={11}
        fontFamily="monospace"
      >
        {muted ? "MUTE" : `${pct}%`}
      </text>
    </svg>
  );
}

function VuMeter({ label, peak }: { label: string; peak: number }) {
  const clamped = Math.min(1, peak);
  const h = Math.round(clamped * 100);
  const color = clamped > 0.9 ? "#f44444" : clamped > 0.65 ? "#ffaa00" : "#44cc88";
  return (
    <div className={styles.vuMeter}>
      <div className={styles.vuTrack}>
        <div className={styles.vuBar} style={{ height: `${h}%`, background: color }} />
      </div>
      <span className={styles.vuLabel}>{label}</span>
    </div>
  );
}

export default function QuickPanel() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [inputDevices, setInputDevices] = useState<DeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<DeviceInfo[]>([]);
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [selectedPreset, setSelectedPreset] = useState("");

  const dragging = useRef(false);
  const dragStart = useRef({ y: 0, vol: 1.0 });

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await ipc.getSystemStatus();
        if (alive) setStatus(s);
      } catch {}
    };
    void tick();
    const iv = window.setInterval(tick, 150);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  useEffect(() => {
    Promise.all([
      ipc.listInputDevices(),
      ipc.listOutputDevices(),
      ipc.listPresets(),
    ])
      .then(([ins, outs, ps]) => {
        setInputDevices(ins);
        setOutputDevices(outs);
        setPresets(ps);
        if (ps.length > 0) setSelectedPreset(ps[0].name);
      })
      .catch(() => {});
  }, []);

  const a1 = status?.buses.find((b) => b.id === A1);
  const volume = a1?.volume ?? 1.0;
  const outputMuted = a1?.muted ?? false;
  const outputPeak = a1?.output_peak ?? 0;
  const currentOutputDevice = a1?.output_device ?? "";

  const firstInput = status?.inputs[0];
  const micMuted = firstInput?.muted ?? false;
  const micPeak =
    firstInput
      ? (status?.input_peaks.find((p) => p.device_id === firstInput.device_id)?.peak ?? 0)
      : 0;
  const currentMicDevice = firstInput?.device_id ?? "";

  const onKnobMouseDown = useCallback(
    (e: React.MouseEvent) => {
      dragging.current = true;
      dragStart.current = { y: e.clientY, vol: volume };
      e.preventDefault();
    },
    [volume],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = (dragStart.current.y - e.clientY) / 120;
      const next = Math.max(0, Math.min(MAX_VOL, dragStart.current.vol + delta));
      ipc.setBusVolume(A1, next, outputMuted).catch(() => {});
    };
    const onUp = () => {
      dragging.current = false;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [outputMuted]);

  const toggleOutputMute = () => {
    if (!a1) return;
    ipc.setBusVolume(A1, a1.volume, !a1.muted).catch(() => {});
  };

  const toggleMicMute = () => {
    if (!firstInput) return;
    ipc.setInputGain(firstInput.device_id, firstInput.gain, !firstInput.muted).catch(() => {});
  };

  const onMicChange = async (newId: string) => {
    if (!newId || newId === currentMicDevice) return;
    if (firstInput) {
      const enabledBuses = firstInput.sends.filter((s) => s.enabled).map((s) => s.bus_id);
      try {
        await ipc.removeInput(firstInput.device_id);
        await ipc.addInput(newId);
        for (const busId of enabledBuses) {
          await ipc.setSend(newId, busId, true);
        }
      } catch {}
    } else {
      ipc.addInput(newId).catch(() => {});
    }
  };

  const onSpeakerChange = (deviceId: string) => {
    if (deviceId) ipc.setBusDevice(A1, deviceId).catch(() => {});
  };

  const loadPreset = () => {
    if (selectedPreset) ipc.loadPreset(selectedPreset).catch(() => {});
  };

  return (
    <div className={styles.panel}>
      <div className={styles.meters}>
        <VuMeter label="MIC" peak={micPeak} />
        <VuMeter label="OUT" peak={outputPeak} />
      </div>

      <div className={styles.controls}>
        <KnobSvg volume={volume} muted={outputMuted} onMouseDown={onKnobMouseDown} />
        <div className={styles.muteButtons}>
          <button
            className={`${styles.muteBtn} ${outputMuted ? styles.active : ""}`}
            onClick={toggleOutputMute}
          >
            {outputMuted ? "UNMUTE" : "MUTE OUT"}
          </button>
          <button
            className={`${styles.muteBtn} ${micMuted ? styles.active : ""}`}
            onClick={toggleMicMute}
          >
            {micMuted ? "MIC ON" : "MUTE MIC"}
          </button>
        </div>
      </div>

      <div className={styles.selectors}>
        <div className={styles.selectorRow}>
          <span className={styles.selectorLabel}>MIC</span>
          <select
            value={currentMicDevice}
            onChange={(e) => { void onMicChange(e.target.value); }}
            className={styles.select}
          >
            {!currentMicDevice && <option value="">— none —</option>}
            {inputDevices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.selectorRow}>
          <span className={styles.selectorLabel}>OUT</span>
          <select
            value={currentOutputDevice}
            onChange={(e) => onSpeakerChange(e.target.value)}
            className={styles.select}
          >
            {!currentOutputDevice && <option value="">— none —</option>}
            {outputDevices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>

        {presets.length > 0 && (
          <div className={styles.selectorRow}>
            <span className={styles.selectorLabel}>PRE</span>
            <select
              value={selectedPreset}
              onChange={(e) => setSelectedPreset(e.target.value)}
              className={styles.select}
            >
              {presets.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
            <button className={styles.loadBtn} onClick={loadPreset}>
              Load
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
