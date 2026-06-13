import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

import * as ipc from "../../ipc/commands";
import type { PhoneSessionCreated, PhoneSessionStatus } from "../../types/engine";
import { XIcon } from "./Icon";
import styles from "./PhonePairingSheet.module.css";

interface PhonePairingSheetProps {
  open: boolean;
  onClose: () => void;
}

const POLL_MS = 1000;

/**
 * Slide-in sheet for pairing a phone as a wireless input (#40).
 *
 * Opening creates a pairing session and renders its QR code; the session list
 * below polls at 1 Hz so incoming phones show up with Accept / Reject. The QR
 * URL carries the pairing token in its fragment — it is rendered, never
 * logged. Closing the sheet discards the session if nothing ever scanned it.
 */
export function PhonePairingSheet({ open, onClose }: PhonePairingSheetProps) {
  const [created, setCreated] = useState<PhoneSessionCreated | null>(null);
  const [sessions, setSessions] = useState<PhoneSessionStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const createdRef = useRef<PhoneSessionCreated | null>(null);
  createdRef.current = created;

  const createSession = useCallback(async () => {
    setError(null);
    try {
      // Replace a still-unscanned session instead of stacking them up.
      const prev = createdRef.current;
      if (prev) await ipc.phoneRemoveSession(prev.id).catch(() => {});
      const next = await ipc.phoneCreateSession();
      setCreated(next);
    } catch (e) {
      setCreated(null);
      setError(extractMessage(e));
    }
  }, []);

  // Create a fresh session each time the sheet opens; drop it on close if it
  // was never scanned (state still "created").
  useEffect(() => {
    if (!open) return;
    void createSession();
    return () => {
      const c = createdRef.current;
      if (!c) return;
      void ipc.phoneListSessions().then((list) => {
        const mine = list.find((s) => s.id === c.id);
        if (mine && mine.state === "created") {
          void ipc.phoneRemoveSession(c.id).catch(() => {});
        }
      });
      setCreated(null);
      setSessions([]);
    };
  }, [open, createSession]);

  // 1 Hz session polling while open (AmvcBanner pattern).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const list = await ipc.phoneListSessions();
        if (!cancelled) setSessions(list);
      } catch {
        // Transient IPC failure: keep the last snapshot.
      }
    };
    void tick();
    const handle = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [open]);

  // Render the QR whenever the pairing URL changes.
  useEffect(() => {
    const url = created?.urls[0];
    const canvas = canvasRef.current;
    if (!url || !canvas) return;
    QRCode.toCanvas(canvas, url, { width: 220, margin: 1 }, () => {});
  }, [created]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const pairingUrl = created?.urls[0] ?? null;
  const visibleSessions = sessions.filter((s) => s.state !== "expired");

  return (
    <>
      {open && <div className={styles.backdrop} onClick={onClose} aria-hidden />}
      <aside
        className={`${styles.sheet} ${open ? styles.sheetOpen : ""}`}
        role="dialog"
        aria-modal="false"
        aria-labelledby="phone-pairing-title"
        aria-hidden={!open}
      >
        <header className={styles.header}>
          <div>
            <div className={styles.eyebrow}>Phone audio</div>
            <h2 id="phone-pairing-title" className={styles.title}>
              Pair a phone microphone
            </h2>
          </div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close phone pairing">
            <XIcon size={16} />
          </button>
        </header>

        <div className={styles.body}>
          {error ? (
            <div className={styles.errorBox}>
              <div className={styles.errorTitle}>Could not start pairing</div>
              <div className={styles.errorDetail}>{error}</div>
              <button className={styles.secondaryBtn} onClick={() => void createSession()}>
                Try again
              </button>
            </div>
          ) : (
            <section className={styles.qrCard} aria-label="Pairing QR code">
              <canvas ref={canvasRef} className={styles.qrCanvas} />
              <div className={styles.qrHint}>
                Scan with the phone&apos;s camera, on the same WiFi.
              </div>
              {pairingUrl && (
                <div className={styles.qrUrl} title={pairingUrl}>
                  {pairingUrl.split("#")[0]}
                </div>
              )}
              <div className={styles.qrNote}>
                The browser will warn about the connection certificate once —
                choose &quot;visit website&quot; / &quot;proceed&quot; to continue.
              </div>
              <button className={styles.secondaryBtn} onClick={() => void createSession()}>
                New QR code
              </button>
            </section>
          )}

          <section className={styles.sessions} aria-label="Phone sessions">
            <div className={styles.sectionLabel}>Phones</div>
            {visibleSessions.length === 0 && (
              <div className={styles.emptySessions}>
                Waiting for a phone to scan the code…
              </div>
            )}
            {visibleSessions.map((s) => (
              <SessionRow key={s.id} session={s} />
            ))}
          </section>
        </div>
      </aside>
    </>
  );
}

function SessionRow({ session }: { session: PhoneSessionStatus }) {
  const tone = toneFor(session);
  return (
    <div className={`${styles.session} ${styles[`tone_${tone}`]}`}>
      <span className={`${styles.dot} ${styles[`dot_${tone}`]}`} aria-hidden />
      <div className={styles.sessionText}>
        <div className={styles.sessionLabel}>{session.label}</div>
        <div className={styles.sessionMeta}>{describe(session)}</div>
        {session.state === "accepted" && (
          <>
            <div className={styles.levelMeter} aria-hidden>
              <div
                className={styles.levelFill}
                style={{ width: `${Math.round(Math.min(1, session.level) * 100)}%` }}
              />
            </div>
            <LatencyControl session={session} />
          </>
        )}
      </div>
      <div className={styles.sessionActions}>
        {session.state === "pending-accept" && (
          <>
            <button
              className={styles.acceptBtn}
              onClick={() => void ipc.phoneAcceptClient(session.id)}
            >
              Accept
            </button>
            <button
              className={styles.rejectBtn}
              onClick={() => void ipc.phoneRejectClient(session.id)}
            >
              Reject
            </button>
          </>
        )}
        {session.state !== "pending-accept" && (
          <button
            className={styles.removeBtn}
            aria-label={`Remove ${session.label}`}
            onClick={() => void ipc.phoneRemoveSession(session.id)}
          >
            <XIcon size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

const LATENCY_MODES: ipc.PhoneLatencyMode[] = ["fastest", "balanced", "stable"];
const LATENCY_LABELS: Record<ipc.PhoneLatencyMode, string> = {
  fastest: "Fastest",
  balanced: "Balanced",
  stable: "Stable",
};

/** One Opus frame is ~20 ms; the jitter window is the dominant added delay. */
const FRAME_MS = 20;

type Health = "ok" | "warn" | "bad";

/**
 * Latency mode selector plus a live health readout: the buffered depth (the
 * delay we add, from the actual jitter-buffer depth) and a dot driven by the
 * recent concealment rate (rising drops = a struggling link).
 */
function LatencyControl({ session }: { session: PhoneSessionStatus }) {
  // Sample the cumulative PLC count across polls to derive drops/second.
  const sample = useRef({ plc: session.plc, at: 0, rate: 0 });
  const now =
    typeof performance !== "undefined" ? performance.now() : 0;
  const s = sample.current;
  if (s.at === 0) {
    s.at = now;
    s.plc = session.plc;
  } else if (now - s.at > 800) {
    s.rate = Math.max(0, (session.plc - s.plc) / ((now - s.at) / 1000));
    s.plc = session.plc;
    s.at = now;
  }
  const health: Health = s.rate >= 5 ? "bad" : s.rate >= 1 ? "warn" : "ok";
  const bufferedMs = Math.round(session.jitterDepth * FRAME_MS);

  return (
    <div className={styles.latencyRow}>
      <div className={styles.latencyModes} role="group" aria-label="Latency mode">
        {LATENCY_MODES.map((mode) => (
          <button
            key={mode}
            className={`${styles.latencyBtn} ${
              session.latencyMode === mode ? styles.latencyBtnActive : ""
            }`}
            aria-pressed={session.latencyMode === mode}
            onClick={() => void ipc.phoneSetLatencyMode(session.id, mode)}
          >
            {LATENCY_LABELS[mode]}
          </button>
        ))}
      </div>
      <span
        className={styles.latencyEstimate}
        title="Buffered audio (added delay) and link health from the recent dropout rate"
      >
        <span className={`${styles.healthDot} ${styles[`health_${health}`]}`} aria-hidden />
        ~{bufferedMs} ms
      </span>
      {session.plc > 0 && (
        <span className={styles.latencyStat} title="Concealed (lost) audio frames">
          {session.plc} drops
        </span>
      )}
    </div>
  );
}

type Tone = "ok" | "warn" | "neutral";

function toneFor(s: PhoneSessionStatus): Tone {
  switch (s.state) {
    case "accepted":
      return "ok";
    case "pending-accept":
    case "reconnecting":
      return "warn";
    default:
      return "neutral";
  }
}

function describe(s: PhoneSessionStatus): string {
  const device = s.clientOs ? ` · ${s.clientOs}` : "";
  switch (s.state) {
    case "created":
      return s.expiresInSecs != null
        ? `Waiting for scan · expires in ${formatSecs(s.expiresInSecs)}`
        : "Waiting for scan";
    case "pending-accept":
      return `Wants to join${device}`;
    case "accepted":
      return s.packets > 0 ? `Paired${device} · hearing audio` : `Paired${device} · waiting for audio`;
    case "reconnecting":
      return s.expiresInSecs != null
        ? `Reconnecting · ${formatSecs(s.expiresInSecs)} grace left`
        : "Reconnecting";
    case "disconnected":
      return "Disconnected";
    default:
      return s.state;
  }
}

function formatSecs(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function extractMessage(e: unknown): string {
  if (typeof e === "object" && e !== null && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}
