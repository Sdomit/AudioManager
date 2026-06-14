/**
 * Detached EQ window view.
 *
 * Rendered (instead of the full app) when the bundle is loaded with
 * `?eqTarget=<kind>:<id>` — see `main.tsx` and `eqPopout.ts`. It is
 * self-contained: it polls `get_system_status` for the target's current EQ and
 * writes edits back through the same IPC commands the main window uses, so both
 * windows stay in sync through the backend (no cross-window messaging needed).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import * as ipc from "../../ipc/commands";
import type { BusDspConfig, BusId, DspConfig, EqConfig } from "../../types/engine";
import { EqEditor } from "./DspControls";
import { defaultDspConfig, defaultEq, defaultLimiter } from "./dspDefaults";
import "./tokens.css";
import "./EqPopout.css";

type Routed = { inputId: string; busId: BusId };

function splitTarget(
  target: string,
): { kind: "input" | "bus"; id: string } | null {
  const sep = target.indexOf(":");
  if (sep < 0) return null;
  const kind = target.slice(0, sep);
  const id = target.slice(sep + 1);
  if ((kind !== "input" && kind !== "bus") || !id) return null;
  return { kind, id };
}

export default function EqPopout({ target }: { target: string }) {
  const parsed = useMemo(() => splitTarget(target), [target]);
  const [eq, setEq] = useState<EqConfig | null>(null);
  const [label, setLabel] = useState("EQ");

  const ctx = useRef<{ dsp: DspConfig; busDsp: BusDspConfig; routed: Routed[] }>({
    dsp: defaultDspConfig(),
    busDsp: { eq: defaultEq(), limiter: defaultLimiter() },
    routed: [],
  });
  const seeded = useRef(false);
  const lastBackend = useRef("");
  const editingUntil = useRef(0);
  const raf = useRef(0);
  const pending = useRef<null | (() => Promise<unknown>)>(null);

  // Poll the backend for the target's current EQ (read path).
  useEffect(() => {
    if (!parsed) return;
    let alive = true;

    const tick = async () => {
      try {
        const s = await ipc.getSystemStatus();
        if (!alive) return;
        let backendEq: EqConfig | null = null;
        if (parsed.kind === "input") {
          const ch = s.inputs.find((i) => i.device_id === parsed.id);
          if (ch?.dsp) {
            ctx.current.dsp = ch.dsp;
            ctx.current.routed = s.inputs.flatMap((i) =>
              i.sends
                .filter((x) => x.enabled)
                .map((x) => ({ inputId: i.device_id, busId: x.bus_id })),
            );
            setLabel(parsed.id);
            backendEq = ch.dsp.eq;
          }
        } else {
          const b = s.buses.find((x) => x.id === parsed.id);
          if (b?.dsp) {
            ctx.current.busDsp = b.dsp;
            setLabel(b.name ?? parsed.id);
            backendEq = b.dsp.eq;
          }
        }
        if (backendEq) {
          const bj = JSON.stringify(backendEq);
          // Seed once; afterwards only sync when not mid-edit and value changed.
          if (
            !seeded.current ||
            (Date.now() > editingUntil.current && bj !== lastBackend.current)
          ) {
            lastBackend.current = bj;
            seeded.current = true;
            setEq(backendEq);
          }
        }
      } catch {
        /* engine may not be running yet; keep polling */
      }
    };

    void tick();
    const iv = window.setInterval(tick, 300);
    return () => {
      alive = false;
      window.clearInterval(iv);
    };
  }, [parsed]);

  const flush = useCallback(() => {
    raf.current = 0;
    const task = pending.current;
    pending.current = null;
    task?.().catch((e) => console.error("EQ pop-out write failed:", e));
  }, []);

  const onChange = useCallback(
    (nextEq: EqConfig) => {
      if (!parsed) return;
      editingUntil.current = Date.now() + 600;
      lastBackend.current = JSON.stringify(nextEq);
      setEq(nextEq);
      pending.current = async () => {
        if (parsed.kind === "input") {
          const dsp: DspConfig = { ...ctx.current.dsp, eq: nextEq };
          ctx.current.dsp = dsp;
          const buses = [
            ...new Set(
              ctx.current.routed
                .filter((r) => r.inputId === parsed.id)
                .map((r) => r.busId),
            ),
          ];
          const targets: BusId[] = buses.length > 0 ? buses : ["A1"];
          await Promise.all(targets.map((b) => ipc.updateInputDsp(b, parsed.id, dsp)));
        } else {
          const next: BusDspConfig = { ...ctx.current.busDsp, eq: nextEq };
          ctx.current.busDsp = next;
          await ipc.updateBusDsp(parsed.id as BusId, next);
        }
      };
      if (raf.current === 0) raf.current = requestAnimationFrame(flush);
    },
    [parsed, flush],
  );

  if (!parsed) return <div className="eqPopoutLoading">Invalid EQ target.</div>;
  if (!eq) return <div className="eqPopoutLoading">Loading EQ…</div>;

  return (
    <div className="eqPopoutRoot">
      <h1 className="eqPopoutTitle">EQ — {label}</h1>
      <EqEditor eq={eq} onChange={onChange} />
    </div>
  );
}
