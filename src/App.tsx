import { useCallback, useEffect, useState } from "react";
import {
  listInputDevices,
  listOutputDevices,
  startPassthrough,
  stopPassthrough,
} from "./ipc/commands";
import type { DeviceInfo } from "./types/engine";
import "./App.css";

function extractErrorMessage(e: unknown): string {
  if (typeof e === "object" && e !== null && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

function App() {
  const [inputs, setInputs] = useState<DeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<DeviceInfo[]>([]);
  const [selectedInput, setSelectedInput] = useState<string>("");
  const [selectedOutput, setSelectedOutput] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [runInfo, setRunInfo] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadDevices = useCallback(async () => {
    try {
      const [ins, outs] = await Promise.all([listInputDevices(), listOutputDevices()]);
      setInputs(ins);
      setOutputs(outs);
      // Auto-select defaults only when no selection is active yet.
      setSelectedInput((prev) => prev || ins.find((d) => d.is_default)?.id || "");
      setSelectedOutput((prev) => prev || outs.find((d) => d.is_default)?.id || "");
    } catch (e) {
      setError(extractErrorMessage(e));
    }
  }, []);

  useEffect(() => {
    loadDevices();
  }, [loadDevices]);

  const handleStart = async () => {
    if (!selectedInput || !selectedOutput) return;
    setBusy(true);
    setError(null);
    try {
      await startPassthrough(selectedInput, selectedOutput);
      setRunning(true);
      setRunInfo(`${selectedInput} → ${selectedOutput}`);
    } catch (e) {
      setError(extractErrorMessage(e));
      setRunning(false);
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    setBusy(true);
    setError(null);
    try {
      await stopPassthrough();
      setRunning(false);
      setRunInfo("");
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const canStart = !busy && !running && !!selectedInput && !!selectedOutput;

  return (
    <main className="container" style={{ padding: 24, maxWidth: 700 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ margin: 0 }}>Audio Manager</h1>
        <button onClick={loadDevices} disabled={busy || running}>
          Refresh devices
        </button>
      </header>
      <p style={{ opacity: 0.7, marginTop: 4 }}>v0.1 · Phase 1 · passthrough</p>

      <section
        style={{
          marginTop: 24,
          padding: 16,
          border: "1px solid #444",
          borderRadius: 8,
        }}
      >
        <h2 style={{ marginTop: 0 }}>Passthrough</h2>

        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <select
            value={selectedInput}
            onChange={(e) => { setSelectedInput(e.target.value); setError(null); }}
            disabled={running || busy}
          >
            <option value="" disabled>
              Select input…
            </option>
            {inputs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.default_sample_rate} Hz · {d.channels}ch)
              </option>
            ))}
          </select>

          <span aria-hidden>→</span>

          <select
            value={selectedOutput}
            onChange={(e) => { setSelectedOutput(e.target.value); setError(null); }}
            disabled={running || busy}
          >
            <option value="" disabled>
              Select output…
            </option>
            {outputs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.default_sample_rate} Hz · {d.channels}ch)
              </option>
            ))}
          </select>

          {running ? (
            <button
              onClick={handleStop}
              disabled={busy}
              style={{ background: "#c0392b", color: "#fff", border: "none", padding: "6px 16px", borderRadius: 4 }}
            >
              {busy ? "Stopping…" : "Stop"}
            </button>
          ) : (
            <button onClick={handleStart} disabled={!canStart}>
              {busy ? "Starting…" : "Start"}
            </button>
          )}
        </div>

        <p style={{ marginTop: 12, marginBottom: 0, opacity: running ? 1 : 0.55 }}>
          {running ? `Running: ${runInfo}` : "Stopped"}
        </p>

        {error && (
          <p style={{ color: "#e74c3c", marginTop: 8, marginBottom: 0, fontSize: 14 }}>
            Error: {error}
          </p>
        )}
      </section>
    </main>
  );
}

export default App;
