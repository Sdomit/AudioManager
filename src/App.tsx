import { useCallback, useEffect, useState } from "react";
import {
  deletePreset,
  getEngineStatus,
  listPresets,
  listInputDevices,
  listOutputDevices,
  loadPreset,
  getRoutes,
  savePreset,
  setRoute,
  clearRoutes,
  setRouteGain,
} from "./ipc/commands";
import type {
  DeviceInfo,
  EngineStatus,
  PresetLoadWarning,
  PresetSummary,
  Route,
} from "./types/engine";
import "./App.css";

function extractErrorMessage(e: unknown): string {
  if (typeof e === "object" && e !== null && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

function shortName(deviceId: string): string {
  return deviceId.length > 40 ? deviceId.slice(0, 38) + "…" : deviceId;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

const EMPTY_ENGINE_STATUS: EngineStatus = {
  status: "stopped",
  output_device: null,
  active_inputs: [],
  input_peaks: [],
  output_peak: 0,
  clipped_recently: false,
  last_error: null,
};

interface MeterBarProps {
  value: number;
  color: string;
  width?: number;
  title: string;
}

function MeterBar({ value, color, width = 96, title }: MeterBarProps) {
  const pct = Math.round(clamp01(value) * 100);
  return (
    <div className="meter" title={title} style={{ width }}>
      <div className="meter-fill" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

interface RouteRowProps {
  route: Route;
  busy: boolean;
  meterLevel: number;
  onToggle: (route: Route, enabled: boolean) => void;
  onGainChange: (route: Route, volume: number, muted: boolean) => void;
}

function RouteRow({ route, busy, meterLevel, onToggle, onGainChange }: RouteRowProps) {
  const [localVol, setLocalVol] = useState(Math.round((route.volume ?? 1.0) * 100));
  const [localMuted, setLocalMuted] = useState(route.muted ?? false);

  useEffect(() => {
    setLocalVol(Math.round((route.volume ?? 1.0) * 100));
    setLocalMuted(route.muted ?? false);
  }, [route.input_id, route.output_id, route.volume, route.muted]);

  const statusLabel = route.active ? "Active" : route.enabled ? "Ready" : "Off";
  const statusClass = route.active
    ? "status-active"
    : route.enabled
      ? "status-ready"
      : "status-off";
  const meterPct = Math.round(clamp01(meterLevel) * 100);

  const handleVolChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const pct = Number(e.target.value);
    setLocalVol(pct);
    onGainChange(route, pct / 100, localMuted);
  };

  const handleMuteToggle = () => {
    const next = !localMuted;
    setLocalMuted(next);
    onGainChange(route, localVol / 100, next);
  };

  return (
    <tr>
      <td className="cell-dev" title={route.input_id}>{shortName(route.input_id)}</td>
      <td className="cell-arrow">→</td>
      <td className="cell-dev" title={route.output_id}>{shortName(route.output_id)}</td>
      <td className={`cell-status ${statusClass}`}>{statusLabel}</td>
      <td className="cell-meter">
        <div className="row-tight">
          <MeterBar
            value={meterLevel}
            color={localMuted ? "var(--warn)" : "var(--accent)"}
            title={`Raw input activity: ${meterPct}%`}
          />
          <span className="meter-pct">{meterPct}%</span>
        </div>
      </td>
      <td className="cell-vol">
        <div className="row-tight">
          <input
            type="range"
            min={0}
            max={200}
            step={1}
            value={localVol}
            onChange={handleVolChange}
            disabled={busy}
            title={`Volume: ${localVol}%`}
          />
          <span className="meter-pct">{localVol}%</span>
        </div>
      </td>
      <td>
        <button
          onClick={handleMuteToggle}
          disabled={busy}
          className={`btn-sm${localMuted ? " btn-danger" : ""}`}
          title={localMuted ? "Unmute" : "Mute"}
        >
          {localMuted ? "Muted" : "Mute"}
        </button>
      </td>
      <td>
        {route.active ? (
          <button
            onClick={() => onToggle(route, false)}
            disabled={busy}
            className="btn-sm btn-danger"
          >
            {busy ? "…" : "Stop"}
          </button>
        ) : (
          <button
            onClick={() => onToggle(route, true)}
            disabled={busy}
            className="btn-sm btn-primary"
          >
            {busy ? "…" : "Enable"}
          </button>
        )}
      </td>
    </tr>
  );
}

export default function App() {
  const [inputs, setInputs] = useState<DeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<DeviceInfo[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [selectedInput, setSelectedInput] = useState<string>("");
  const [selectedOutput, setSelectedOutput] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [engineStatus, setEngineStatus] = useState<EngineStatus>(EMPTY_ENGINE_STATUS);
  const [inputMeterDisplay, setInputMeterDisplay] = useState<Record<string, number>>({});
  const [outputMeterDisplay, setOutputMeterDisplay] = useState(0);
  const [clipHoldUntil, setClipHoldUntil] = useState(0);
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<string>("");
  const [presetName, setPresetName] = useState<string>("");
  const [presetWarnings, setPresetWarnings] = useState<PresetLoadWarning[]>([]);
  const [presetInfo, setPresetInfo] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setError(null);
    try {
      const [ins, outs, rts, psts] = await Promise.all([
        listInputDevices(),
        listOutputDevices(),
        getRoutes(),
        listPresets(),
      ]);
      setInputs(ins);
      setOutputs(outs);
      setRoutes(rts);
      setPresets(psts);
      setSelectedInput((prev) => prev || ins.find((d) => d.is_default)?.id || "");
      setSelectedOutput((prev) => prev || outs.find((d) => d.is_default)?.id || "");
      setSelectedPreset((prev) =>
        psts.some((p) => p.name === prev) ? prev : (psts[0]?.name ?? ""),
      );
    } catch (e) {
      setError(extractErrorMessage(e));
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const pollEngineStatus = useCallback(async () => {
    if (document.hidden) return;

    try {
      const status = await getEngineStatus();
      setEngineStatus(status);
      setInputMeterDisplay((prev) => {
        const nextRawPeaks = Object.fromEntries(
          status.active_inputs.map((inputId, index) => [
            inputId,
            clamp01(status.input_peaks[index] ?? 0),
          ]),
        );

        const keys = new Set([...Object.keys(prev), ...Object.keys(nextRawPeaks)]);
        const next: Record<string, number> = {};
        for (const key of keys) {
          const incoming = nextRawPeaks[key] ?? 0;
          const decayed = (prev[key] ?? 0) * 0.85;
          const display = Math.max(incoming, decayed);
          if (display > 0.001 || incoming > 0) {
            next[key] = display;
          }
        }
        return next;
      });
      setOutputMeterDisplay((prev) => Math.max(clamp01(status.output_peak), prev * 0.85));
      if (status.clipped_recently) {
        setClipHoldUntil(Date.now() + 1500);
      }
    } catch (e) {
      setError(extractErrorMessage(e));
    }
  }, []);

  useEffect(() => {
    void pollEngineStatus();
    const intervalId = window.setInterval(() => {
      void pollEngineStatus();
    }, 200);
    return () => window.clearInterval(intervalId);
  }, [pollEngineStatus]);

  const handleEnable = async () => {
    if (!selectedInput || !selectedOutput) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await setRoute(selectedInput, selectedOutput, true);
      setRoutes(updated);
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const handleToggle = async (route: Route, enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await setRoute(route.input_id, route.output_id, enabled);
      setRoutes(updated);
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const handleGainChange = async (route: Route, volume: number, muted: boolean) => {
    try {
      const updated = await setRouteGain(route.input_id, route.output_id, volume, muted);
      setRoutes(updated);
    } catch (e) {
      setError(extractErrorMessage(e));
    }
  };

  const handleClearAll = async () => {
    setBusy(true);
    setError(null);
    try {
      await clearRoutes();
      setRoutes([]);
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const refreshPresets = useCallback(async () => {
    const items = await listPresets();
    setPresets(items);
    setSelectedPreset((prev) =>
      items.some((p) => p.name === prev) ? prev : (items[0]?.name ?? ""),
    );
    return items;
  }, []);

  const handleSavePreset = async () => {
    const trimmed = presetName.trim();
    if (!trimmed) {
      setError("Preset name cannot be empty.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const saved = await savePreset(trimmed);
      await refreshPresets();
      setSelectedPreset(saved.name);
      setPresetName(saved.name);
      setPresetWarnings([]);
      setPresetInfo(`Saved preset '${saved.name}'.`);
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const handleLoadPreset = async () => {
    if (!selectedPreset) return;
    setBusy(true);
    setError(null);
    try {
      const result = await loadPreset(selectedPreset);
      setRoutes(result.routes);
      setPresetWarnings(result.warnings);
      setPresetInfo(`Loaded preset '${result.preset.name}' in safe mode.`);
      await pollEngineStatus();
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDeletePreset = async () => {
    if (!selectedPreset) return;
    const confirmed = window.confirm(`Delete preset '${selectedPreset}'?`);
    if (!confirmed) return;

    setBusy(true);
    setError(null);
    try {
      await deletePreset(selectedPreset);
      await refreshPresets();
      setPresetWarnings([]);
      setPresetInfo(`Deleted preset '${selectedPreset}'.`);
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const canEnable = !busy && !!selectedInput && !!selectedOutput;
  const clipVisible = clipHoldUntil > Date.now();
  const statusBadgeClass =
    engineStatus.status === "running"
      ? "badge-ok"
      : engineStatus.status === "error"
        ? "badge-err"
        : "badge-stopped";
  const outputMeterPct = Math.round(clamp01(outputMeterDisplay) * 100);
  const routeMeterLevel = (route: Route) =>
    route.active ? inputMeterDisplay[route.input_id] ?? 0 : 0;

  return (
    <main className="app">
      <header className="app-header">
        <h1 className="app-title">Audio Manager</h1>
        <span className="app-version">v0.1 · Phase 7</span>

        <span className="header-spacer" />

        <div className="header-status">
          <span
            className={`badge ${statusBadgeClass}`}
            title={engineStatus.last_error ?? `Engine ${engineStatus.status}`}
          >
            {engineStatus.status}
          </span>
          {clipVisible && <span className="badge badge-clip">Clip</span>}
          <span className="output-label" title={engineStatus.output_device ?? "no output"}>
            {engineStatus.output_device
              ? `Out: ${shortName(engineStatus.output_device)}`
              : "Out: none"}
          </span>
          <MeterBar
            value={outputMeterDisplay}
            color={clipVisible ? "var(--err)" : "var(--ok)"}
            width={140}
            title={`Output peak: ${outputMeterPct}%`}
          />
          <span className="meter-pct">{outputMeterPct}%</span>
        </div>

        <button onClick={loadAll} disabled={busy} className="btn-ghost">
          Refresh
        </button>
      </header>

      <div className="app-grid">
        <div className="col">
          <section className="section">
            <div className="section-header">
              <h2 className="section-title">Add Route</h2>
            </div>
            <div className="stack">
              <label className="field">
                Input
                <select
                  value={selectedInput}
                  onChange={(e) => { setSelectedInput(e.target.value); setError(null); }}
                  disabled={busy}
                >
                  <option value="" disabled>Select input…</option>
                  {inputs.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} ({d.default_sample_rate} Hz · {d.channels}ch)
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                Output
                <select
                  value={selectedOutput}
                  onChange={(e) => { setSelectedOutput(e.target.value); setError(null); }}
                  disabled={busy}
                >
                  <option value="" disabled>Select output…</option>
                  {outputs.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} ({d.default_sample_rate} Hz · {d.channels}ch)
                    </option>
                  ))}
                </select>
              </label>

              <button
                onClick={handleEnable}
                disabled={!canEnable}
                className="btn-primary"
              >
                {busy ? "Working…" : "Enable Route"}
              </button>
            </div>
            <p className="section-hint">
              One output bus. Enabled inputs mix into it.
            </p>
          </section>

          <section className="section">
            <div className="section-header">
              <h2 className="section-title">Presets</h2>
            </div>
            <div className="stack">
              <div className="row">
                <input
                  type="text"
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  placeholder="Preset name"
                  disabled={busy}
                  style={{ flex: 1, minWidth: 140 }}
                />
                <button
                  onClick={handleSavePreset}
                  disabled={busy || !presetName.trim()}
                  className="btn-primary btn-sm"
                >
                  Save
                </button>
              </div>

              <div className="row">
                <select
                  value={selectedPreset}
                  onChange={(e) => setSelectedPreset(e.target.value)}
                  disabled={busy || presets.length === 0}
                  style={{ flex: 1, minWidth: 140 }}
                >
                  {presets.length === 0 && <option value="">No presets saved</option>}
                  {presets.map((preset) => (
                    <option key={preset.name} value={preset.name}>
                      {preset.name} ({preset.route_count} routes)
                    </option>
                  ))}
                </select>
                <button
                  onClick={handleLoadPreset}
                  disabled={busy || !selectedPreset}
                  className="btn-sm"
                >
                  Load
                </button>
                <button
                  onClick={handleDeletePreset}
                  disabled={busy || !selectedPreset}
                  className="btn-sm"
                >
                  Delete
                </button>
              </div>
            </div>
            <p className="section-hint">
              Load is safe: routes restore as configured. Audio stays off until you enable a route.
            </p>
          </section>
        </div>

        <div className="col">
          <section className="section">
            <div className="section-header">
              <h2 className="section-title">Routes / Mixer</h2>
              {routes.length > 0 && (
                <button onClick={handleClearAll} disabled={busy} className="btn-ghost">
                  Clear all
                </button>
              )}
            </div>

            {routes.length === 0 ? (
              <div className="routes-empty">
                No routes configured. Add one on the left.
              </div>
            ) : (
              <table className="routes-table">
                <thead>
                  <tr>
                    <th>Input</th>
                    <th />
                    <th>Output</th>
                    <th>Status</th>
                    <th>Input Meter</th>
                    <th>Volume</th>
                    <th>Mute</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {routes.map((r) => (
                    <RouteRow
                      key={`${r.input_id}::${r.output_id}`}
                      route={r}
                      busy={busy}
                      meterLevel={routeMeterLevel(r)}
                      onToggle={handleToggle}
                      onGainChange={handleGainChange}
                    />
                  ))}
                </tbody>
              </table>
            )}
            <p className="section-hint">
              Input meters show raw input before mute and volume.
            </p>
          </section>
        </div>
      </div>

      {(error || presetInfo || presetWarnings.length > 0) && (
        <div className="messages">
          {error && <div className="msg msg-err">{error}</div>}
          {presetWarnings.length > 0 && (
            <div className="msg msg-warn">
              <ul className="msg-list">
                {presetWarnings.map((warning, index) => (
                  <li key={`${warning.code}-${index}`}>{warning.message}</li>
                ))}
              </ul>
            </div>
          )}
          {presetInfo && <div className="msg msg-info">{presetInfo}</div>}
        </div>
      )}
    </main>
  );
}
