import { useCallback, useEffect, useState } from "react";
import {
  listInputDevices,
  listOutputDevices,
  getRoutes,
  setRoute,
  clearRoutes,
} from "./ipc/commands";
import type { DeviceInfo, Route } from "./types/engine";
import "./App.css";

function extractErrorMessage(e: unknown): string {
  if (typeof e === "object" && e !== null && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

function shortName(deviceId: string): string {
  // Trim long WASAPI device names to fit the table.
  return deviceId.length > 40 ? deviceId.slice(0, 38) + "…" : deviceId;
}

// ── Route table row ───────────────────────────────────────────────────────────

interface RouteRowProps {
  route: Route;
  busy: boolean;
  onToggle: (route: Route, enabled: boolean) => void;
}

function RouteRow({ route, busy, onToggle }: RouteRowProps) {
  const statusLabel = route.active ? "Active" : "Off";
  const statusColor = route.active ? "#2ecc71" : "#888";

  return (
    <tr>
      <td style={{ padding: "8px 12px", maxWidth: 200 }}>{shortName(route.input_id)}</td>
      <td style={{ padding: "8px 12px", color: "#888" }}>→</td>
      <td style={{ padding: "8px 12px", maxWidth: 200 }}>{shortName(route.output_id)}</td>
      <td style={{ padding: "8px 12px", color: statusColor, fontWeight: 600, minWidth: 60 }}>
        {statusLabel}
      </td>
      <td style={{ padding: "8px 12px" }}>
        {route.active ? (
          <button
            onClick={() => onToggle(route, false)}
            disabled={busy}
            style={{
              background: "#c0392b",
              color: "#fff",
              border: "none",
              padding: "4px 12px",
              borderRadius: 4,
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            {busy ? "…" : "Stop"}
          </button>
        ) : (
          <button
            onClick={() => onToggle(route, true)}
            disabled={busy}
            style={{ padding: "4px 12px", borderRadius: 4 }}
          >
            {busy ? "…" : "Enable"}
          </button>
        )}
      </td>
    </tr>
  );
}

// ── Main app ──────────────────────────────────────────────────────────────────

export default function App() {
  const [inputs, setInputs] = useState<DeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<DeviceInfo[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [selectedInput, setSelectedInput] = useState<string>("");
  const [selectedOutput, setSelectedOutput] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadAll = useCallback(async () => {
    try {
      const [ins, outs, rts] = await Promise.all([
        listInputDevices(),
        listOutputDevices(),
        getRoutes(),
      ]);
      setInputs(ins);
      setOutputs(outs);
      setRoutes(rts);
      setSelectedInput((prev) => prev || ins.find((d) => d.is_default)?.id || "");
      setSelectedOutput((prev) => prev || outs.find((d) => d.is_default)?.id || "");
    } catch (e) {
      setError(extractErrorMessage(e));
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Add & enable a new route from the dropdown selection.
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

  // Toggle an existing route on or off.
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

  const hasActiveRoute = routes.some((r) => r.active);
  const canEnable = !busy && !!selectedInput && !!selectedOutput;

  return (
    <main className="container" style={{ padding: 24, maxWidth: 780 }}>
      {/* Header */}
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ margin: 0 }}>Audio Manager</h1>
        <button onClick={loadAll} disabled={busy}>
          Refresh
        </button>
      </header>
      <p style={{ opacity: 0.6, marginTop: 4, fontSize: 13 }}>
        v0.1 · Phase 2 · one active route at a time
      </p>

      {/* Error banner */}
      {error && (
        <p
          style={{
            color: "#e74c3c",
            background: "rgba(231,76,60,0.1)",
            border: "1px solid rgba(231,76,60,0.3)",
            borderRadius: 6,
            padding: "8px 12px",
            marginTop: 12,
            fontSize: 14,
          }}
        >
          {error}
        </p>
      )}

      {/* Add route */}
      <section
        style={{
          marginTop: 20,
          padding: 16,
          border: "1px solid #444",
          borderRadius: 8,
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: 15 }}>Add Route</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
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

          <span aria-hidden style={{ opacity: 0.7 }}>→</span>

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

          <button onClick={handleEnable} disabled={!canEnable}>
            {busy ? "Working…" : hasActiveRoute ? "Switch Route" : "Enable"}
          </button>
        </div>
        <p style={{ marginTop: 8, fontSize: 12, opacity: 0.55 }}>
          Phase 2: only one route may be active at a time. Enabling a new route stops the current one.
        </p>
      </section>

      {/* Route list */}
      <section
        style={{
          marginTop: 16,
          padding: 16,
          border: "1px solid #444",
          borderRadius: 8,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: 15 }}>Routes</h2>
          {routes.length > 0 && (
            <button
              onClick={handleClearAll}
              disabled={busy}
              style={{ fontSize: 12, opacity: 0.7 }}
            >
              Clear all
            </button>
          )}
        </div>

        {routes.length === 0 ? (
          <p style={{ opacity: 0.5, marginTop: 12, fontSize: 14 }}>
            No routes configured. Add one above.
          </p>
        ) : (
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              marginTop: 12,
              fontSize: 14,
            }}
          >
            <thead>
              <tr style={{ borderBottom: "1px solid #444", opacity: 0.6, textAlign: "left" }}>
                <th style={{ padding: "4px 12px", fontWeight: 500 }}>Input</th>
                <th style={{ padding: "4px 12px" }} />
                <th style={{ padding: "4px 12px", fontWeight: 500 }}>Output</th>
                <th style={{ padding: "4px 12px", fontWeight: 500 }}>Status</th>
                <th style={{ padding: "4px 12px" }} />
              </tr>
            </thead>
            <tbody>
              {routes.map((r) => (
                <RouteRow
                  key={`${r.input_id}::${r.output_id}`}
                  route={r}
                  busy={busy}
                  onToggle={handleToggle}
                />
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
