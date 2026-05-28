import { useCallback, useEffect, useMemo, useState } from "react";
import {
  addInput,
  deletePreset,
  getSystemStatus,
  listInputDevices,
  listOutputDevices,
  listPresets,
  loadPreset,
  removeInput,
  savePreset,
  setBusDevice,
  setBusEnabled,
  setBusVolume,
  setInputGain,
  setSend,
  setSendGain,
} from "./ipc/commands";
import type {
  BusId,
  BusStatus,
  DeviceInfo,
  InputChannel,
  InputSend,
  PresetLoadWarning,
  PresetSummary,
} from "./types/engine";
import "./App.css";

const BUS_ORDER: BusId[] = ["A1", "A2", "B1", "B2"];

function extractErrorMessage(e: unknown): string {
  if (typeof e === "object" && e !== null && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function shortName(deviceId: string): string {
  return deviceId.length > 42 ? `${deviceId.slice(0, 40)}…` : deviceId;
}

function sendFor(input: InputChannel, busId: BusId): InputSend {
  return (
    input.sends.find((send) => send.bus_id === busId) ?? {
      bus_id: busId,
      enabled: false,
      volume: 1.0,
      muted: false,
    }
  );
}

interface MeterBarProps {
  value: number;
  width?: number;
}

function MeterBar({ value, width = 110 }: MeterBarProps) {
  const pct = Math.round(clamp01(value) * 100);
  return (
    <div className="meter" style={{ width }}>
      <div className="meter-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function App() {
  const [inputDevices, setInputDevices] = useState<DeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<DeviceInfo[]>([]);
  const [inputs, setInputs] = useState<InputChannel[]>([]);
  const [buses, setBuses] = useState<BusStatus[]>([]);
  const [inputMeters, setInputMeters] = useState<Record<string, number>>({});
  const [systemError, setSystemError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [selectedNewInput, setSelectedNewInput] = useState("");
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [selectedPreset, setSelectedPreset] = useState("");
  const [presetName, setPresetName] = useState("");
  const [presetWarnings, setPresetWarnings] = useState<PresetLoadWarning[]>([]);
  const [presetInfo, setPresetInfo] = useState<string | null>(null);

  const busById = useMemo(() => {
    const map = new Map<BusId, BusStatus>();
    for (const bus of buses) {
      map.set(bus.id, bus);
    }
    return map;
  }, [buses]);

  const availableNewInputs = useMemo(
    () => inputDevices.filter((device) => !inputs.some((input) => input.device_id === device.id)),
    [inputDevices, inputs],
  );

  const applyInputPeaks = useCallback((peaks: Array<{ device_id: string; peak: number }>) => {
    setInputMeters((prev) => {
      const nextRaw = Object.fromEntries(
        peaks.map((item) => [item.device_id, clamp01(item.peak)]),
      );
      const keys = new Set([...Object.keys(prev), ...Object.keys(nextRaw)]);
      const next: Record<string, number> = {};
      for (const key of keys) {
        const incoming = nextRaw[key] ?? 0;
        const decayed = (prev[key] ?? 0) * 0.85;
        const display = Math.max(incoming, decayed);
        if (display > 0.001 || incoming > 0) {
          next[key] = display;
        }
      }
      return next;
    });
  }, []);

  const syncSystemStatus = useCallback(async () => {
    const status = await getSystemStatus();
    setBuses(status.buses);
    setInputs(status.inputs);
    setSystemError(status.last_error);
    applyInputPeaks(status.input_peaks);
  }, [applyInputPeaks]);

  const loadAll = useCallback(async () => {
    setError(null);
    const [ins, outs, status, psts] = await Promise.all([
      listInputDevices(),
      listOutputDevices(),
      getSystemStatus(),
      listPresets(),
    ]);
    setInputDevices(ins);
    setOutputDevices(outs);
    setBuses(status.buses);
    setInputs(status.inputs);
    setSystemError(status.last_error);
    applyInputPeaks(status.input_peaks);
    setPresets(psts);
    setSelectedPreset((prev) =>
      psts.some((item) => item.name === prev) ? prev : (psts[0]?.name ?? ""),
    );
  }, [applyInputPeaks]);

  useEffect(() => {
    void loadAll().catch((e) => setError(extractErrorMessage(e)));
  }, [loadAll]);

  useEffect(() => {
    if (!selectedNewInput || availableNewInputs.every((item) => item.id !== selectedNewInput)) {
      setSelectedNewInput(availableNewInputs[0]?.id ?? "");
    }
  }, [availableNewInputs, selectedNewInput]);

  useEffect(() => {
    const tick = () => {
      if (document.hidden) {
        return;
      }
      void syncSystemStatus().catch((e) => setError(extractErrorMessage(e)));
    };
    tick();
    const intervalId = window.setInterval(tick, 200);
    return () => window.clearInterval(intervalId);
  }, [syncSystemStatus]);

  const withBusy = useCallback(
    async (run: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await run();
      } catch (e) {
        setError(extractErrorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const handleBusDeviceChange = (busId: BusId, outputDeviceId: string | null) => {
    void withBusy(async () => {
      await setBusDevice(busId, outputDeviceId);
      await syncSystemStatus();
    });
  };

  const handleBusEnabled = (busId: BusId, enabled: boolean) => {
    void withBusy(async () => {
      await setBusEnabled(busId, enabled);
      await syncSystemStatus();
    });
  };

  const handleBusVolume = (busId: BusId, volume: number, muted: boolean) => {
    void setBusVolume(busId, volume, muted)
      .then(() => syncSystemStatus())
      .catch((e) => setError(extractErrorMessage(e)));
  };

  const handleAddInput = () => {
    if (!selectedNewInput) {
      return;
    }
    void withBusy(async () => {
      const next = await addInput(selectedNewInput);
      setInputs(next);
      await syncSystemStatus();
    });
  };

  const handleRemoveInput = (deviceId: string) => {
    void withBusy(async () => {
      const next = await removeInput(deviceId);
      setInputs(next);
      await syncSystemStatus();
    });
  };

  const handleInputGain = (deviceId: string, gain: number, muted: boolean) => {
    void setInputGain(deviceId, gain, muted)
      .then((next) => setInputs(next))
      .catch((e) => setError(extractErrorMessage(e)));
  };

  const handleSetSend = (deviceId: string, busId: BusId, enabled: boolean) => {
    void withBusy(async () => {
      const next = await setSend(deviceId, busId, enabled);
      setInputs(next);
      await syncSystemStatus();
    });
  };

  const handleSetSendGain = (
    deviceId: string,
    busId: BusId,
    volume: number,
    muted: boolean,
  ) => {
    void setSendGain(deviceId, busId, volume, muted)
      .then((next) => setInputs(next))
      .catch((e) => setError(extractErrorMessage(e)));
  };

  const refreshPresets = useCallback(async () => {
    const items = await listPresets();
    setPresets(items);
    setSelectedPreset((prev) =>
      items.some((item) => item.name === prev) ? prev : (items[0]?.name ?? ""),
    );
    return items;
  }, []);

  const handleSavePreset = () => {
    const trimmed = presetName.trim();
    if (!trimmed) {
      setError("Preset name cannot be empty.");
      return;
    }
    void withBusy(async () => {
      const saved = await savePreset(trimmed);
      await refreshPresets();
      setSelectedPreset(saved.name);
      setPresetName(saved.name);
      setPresetWarnings([]);
      setPresetInfo(`Saved preset '${saved.name}'.`);
    });
  };

  const handleLoadPreset = () => {
    if (!selectedPreset) {
      return;
    }
    void withBusy(async () => {
      const result = await loadPreset(selectedPreset);
      setPresetWarnings(result.warnings);
      setPresetInfo(`Loaded preset '${result.preset.name}' in safe mode.`);
      await syncSystemStatus();
    });
  };

  const handleDeletePreset = () => {
    if (!selectedPreset) {
      return;
    }
    const confirmed = window.confirm(`Delete preset '${selectedPreset}'?`);
    if (!confirmed) {
      return;
    }
    void withBusy(async () => {
      await deletePreset(selectedPreset);
      await refreshPresets();
      setPresetWarnings([]);
      setPresetInfo(`Deleted preset '${selectedPreset}'.`);
    });
  };

  const runningBusCount = buses.filter((bus) => bus.running).length;

  return (
    <main className="app">
      <header className="app-header">
        <h1 className="app-title">Audio Manager</h1>
        <span className="app-version">Phase 8B</span>
        <span className="header-spacer" />
        <span className={`badge ${runningBusCount > 0 ? "badge-ok" : "badge-stopped"}`}>
          {runningBusCount > 0 ? `${runningBusCount} running` : "stopped"}
        </span>
        <button className="btn-ghost" onClick={() => void loadAll()} disabled={busy}>
          Refresh
        </button>
      </header>

      <div className="app-grid">
        <section className="section">
          <div className="section-header">
            <h2 className="section-title">Buses</h2>
          </div>
          <div className="bus-grid">
            {BUS_ORDER.map((busId) => {
              const bus = busById.get(busId);
              if (!bus) {
                return (
                  <div key={busId} className="bus-card">
                    <div className="bus-title">{busId}</div>
                    <div className="text-dim">Loading…</div>
                  </div>
                );
              }
              const meterPct = Math.round(clamp01(bus.output_peak) * 100);
              return (
                <div key={bus.id} className="bus-card">
                  <div className="bus-head">
                    <strong>{bus.id}</strong>
                    <span className={`badge ${bus.running ? "badge-ok" : "badge-stopped"}`}>
                      {bus.running ? "running" : "stopped"}
                    </span>
                  </div>

                  <label className="field">
                    Output Device
                    <select
                      value={bus.output_device ?? ""}
                      disabled={busy}
                      onChange={(e) =>
                        handleBusDeviceChange(bus.id, e.target.value || null)
                      }
                    >
                      <option value="">Unassigned</option>
                      {outputDevices.map((device) => (
                        <option key={device.id} value={device.id}>
                          {device.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="row">
                    <button
                      className={bus.enabled ? "btn-sm btn-danger" : "btn-sm btn-primary"}
                      disabled={busy}
                      onClick={() => handleBusEnabled(bus.id, !bus.enabled)}
                    >
                      {bus.enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      className={`btn-sm${bus.muted ? " btn-danger" : ""}`}
                      disabled={busy}
                      onClick={() => handleBusVolume(bus.id, bus.volume, !bus.muted)}
                    >
                      {bus.muted ? "Muted" : "Mute"}
                    </button>
                  </div>

                  <div className="row-tight">
                    <input
                      type="range"
                      min={0}
                      max={200}
                      step={1}
                      value={Math.round(bus.volume * 100)}
                      disabled={busy}
                      onChange={(e) =>
                        handleBusVolume(
                          bus.id,
                          Number(e.target.value) / 100,
                          bus.muted,
                        )
                      }
                    />
                    <span className="meter-pct">{Math.round(bus.volume * 100)}%</span>
                  </div>

                  <div className="row-tight">
                    <MeterBar value={bus.output_peak} />
                    <span className="meter-pct">{meterPct}%</span>
                    {bus.clipped_recently && <span className="badge badge-err">clip</span>}
                  </div>

                  {bus.last_error && <div className="msg msg-err">{bus.last_error}</div>}
                </div>
              );
            })}
          </div>
        </section>

        <section className="section">
          <div className="section-header">
            <h2 className="section-title">Input Matrix</h2>
          </div>

          <div className="row">
            <select
              value={selectedNewInput}
              onChange={(e) => setSelectedNewInput(e.target.value)}
              disabled={busy || availableNewInputs.length === 0}
              style={{ minWidth: 260, flex: 1 }}
            >
              {availableNewInputs.length === 0 && <option value="">No remaining inputs</option>}
              {availableNewInputs.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name} ({device.default_sample_rate} Hz · {device.channels}ch)
                </option>
              ))}
            </select>
            <button
              className="btn-primary"
              onClick={handleAddInput}
              disabled={busy || !selectedNewInput}
            >
              Add Input
            </button>
          </div>

          {inputs.length === 0 ? (
            <div className="routes-empty">No input channels configured.</div>
          ) : (
            <table className="matrix-table">
              <thead>
                <tr>
                  <th>Input</th>
                  <th>Meter</th>
                  <th>Master</th>
                  {BUS_ORDER.map((busId) => (
                    <th key={busId}>{busId}</th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {inputs.map((input) => (
                  <tr key={input.device_id}>
                    <td title={input.device_id} className="cell-dev">
                      {shortName(input.device_id)}
                    </td>
                    <td>
                      <div className="row-tight">
                        <MeterBar value={inputMeters[input.device_id] ?? 0} width={86} />
                        <span className="meter-pct">
                          {Math.round(clamp01(inputMeters[input.device_id] ?? 0) * 100)}%
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="stack-tight">
                        <div className="row-tight">
                          <input
                            type="range"
                            min={0}
                            max={200}
                            step={1}
                            value={Math.round(input.gain * 100)}
                            disabled={busy}
                            onChange={(e) =>
                              handleInputGain(
                                input.device_id,
                                Number(e.target.value) / 100,
                                input.muted,
                              )
                            }
                          />
                          <span className="meter-pct">{Math.round(input.gain * 100)}%</span>
                        </div>
                        <button
                          className={`btn-sm${input.muted ? " btn-danger" : ""}`}
                          disabled={busy}
                          onClick={() =>
                            handleInputGain(input.device_id, input.gain, !input.muted)
                          }
                        >
                          {input.muted ? "Muted" : "Mute"}
                        </button>
                      </div>
                    </td>

                    {BUS_ORDER.map((busId) => {
                      const send = sendFor(input, busId);
                      return (
                        <td key={`${input.device_id}-${busId}`}>
                          <div className="stack-tight">
                            <label className="send-toggle">
                              <input
                                type="checkbox"
                                checked={send.enabled}
                                disabled={busy}
                                onChange={(e) =>
                                  handleSetSend(input.device_id, busId, e.target.checked)
                                }
                              />
                              <span>On</span>
                            </label>
                            <div className="row-tight">
                              <input
                                type="range"
                                min={0}
                                max={200}
                                step={1}
                                value={Math.round(send.volume * 100)}
                                disabled={busy}
                                onChange={(e) =>
                                  handleSetSendGain(
                                    input.device_id,
                                    busId,
                                    Number(e.target.value) / 100,
                                    send.muted,
                                  )
                                }
                              />
                              <span className="meter-pct">{Math.round(send.volume * 100)}%</span>
                            </div>
                            <button
                              className={`btn-sm${send.muted ? " btn-danger" : ""}`}
                              disabled={busy}
                              onClick={() =>
                                handleSetSendGain(
                                  input.device_id,
                                  busId,
                                  send.volume,
                                  !send.muted,
                                )
                              }
                            >
                              {send.muted ? "Muted" : "Mute"}
                            </button>
                          </div>
                        </td>
                      );
                    })}

                    <td>
                      <button
                        className="btn-sm"
                        disabled={busy}
                        onClick={() => handleRemoveInput(input.device_id)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="section">
          <div className="section-header">
            <h2 className="section-title">Presets (Phase 6 Format)</h2>
          </div>
          <div className="stack">
            <div className="row">
              <input
                type="text"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                placeholder="Preset name"
                disabled={busy}
                style={{ minWidth: 180, flex: 1 }}
              />
              <button
                className="btn-primary btn-sm"
                disabled={busy || !presetName.trim()}
                onClick={handleSavePreset}
              >
                Save
              </button>
            </div>
            <div className="row">
              <select
                value={selectedPreset}
                onChange={(e) => setSelectedPreset(e.target.value)}
                disabled={busy || presets.length === 0}
                style={{ minWidth: 180, flex: 1 }}
              >
                {presets.length === 0 && <option value="">No presets</option>}
                {presets.map((preset) => (
                  <option key={preset.name} value={preset.name}>
                    {preset.name} ({preset.route_count} routes)
                  </option>
                ))}
              </select>
              <button
                className="btn-sm"
                disabled={busy || !selectedPreset}
                onClick={handleLoadPreset}
              >
                Load
              </button>
              <button
                className="btn-sm"
                disabled={busy || !selectedPreset}
                onClick={handleDeletePreset}
              >
                Delete
              </button>
            </div>
          </div>
          <p className="section-hint">
            Presets will be upgraded for bus routing in Phase 8C.
          </p>
        </section>
      </div>

      {(error || systemError || presetWarnings.length > 0 || presetInfo) && (
        <div className="messages">
          {error && <div className="msg msg-err">{error}</div>}
          {systemError && <div className="msg msg-err">{systemError}</div>}
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
