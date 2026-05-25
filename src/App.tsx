import { useCallback, useEffect, useState } from "react";
import { listInputDevices, listOutputDevices } from "./ipc/commands";
import type { DeviceInfo } from "./types/engine";
import "./App.css";

function DeviceList({ title, devices }: { title: string; devices: DeviceInfo[] }) {
  return (
    <section style={{ flex: 1, minWidth: 320 }}>
      <h2>{title}</h2>
      {devices.length === 0 ? (
        <p style={{ opacity: 0.6 }}>No devices found.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, textAlign: "left" }}>
          {devices.map((d) => (
            <li
              key={d.id}
              style={{
                padding: "8px 12px",
                marginBottom: 6,
                border: "1px solid #444",
                borderRadius: 6,
                background: d.is_default ? "rgba(100, 180, 255, 0.12)" : "transparent",
              }}
            >
              <div style={{ fontWeight: 600 }}>
                {d.name} {d.is_default && <span style={{ fontSize: 12 }}>(default)</span>}
              </div>
              <div style={{ fontSize: 12, opacity: 0.7 }}>
                {d.default_sample_rate} Hz · {d.channels} ch
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function App() {
  const [inputs, setInputs] = useState<DeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<DeviceInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ins, outs] = await Promise.all([listInputDevices(), listOutputDevices()]);
      setInputs(ins);
      setOutputs(outs);
    } catch (e) {
      const msg = typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <main className="container" style={{ padding: 24 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ margin: 0 }}>Audio Manager</h1>
        <button onClick={refresh} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>
      <p style={{ opacity: 0.7, marginTop: 4 }}>v0.1 · Phase 0 · device enumeration</p>
      {error && (
        <div style={{ color: "#ff6b6b", margin: "12px 0" }}>
          Error: {error}
        </div>
      )}
      <div style={{ display: "flex", gap: 24, marginTop: 16, flexWrap: "wrap" }}>
        <DeviceList title="Inputs" devices={inputs} />
        <DeviceList title="Outputs" devices={outputs} />
      </div>
    </main>
  );
}

export default App;
