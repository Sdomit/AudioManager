/**
 * Phone client shell (browser). Drives the core/ modules:
 * pairing -> signaling -> accept -> tap to start mic -> WebRTC offer -> live.
 *
 * Plain DOM by design: the phone bundle stays tiny and the core/ modules carry
 * zero framework deps so a Capacitor app can reuse them (docs/phone/architecture.md).
 */

import { PhoneMachine, type PhoneState } from "./core/machine";
import {
  byeMessage,
  candidateMessage,
  defaultDeviceName,
  helloMessage,
  isFatalErrorCode,
  offerMessage,
  pairingFromHash,
  statsMessage,
} from "./core/protocol";
import { SignalingClient } from "./core/signaling";
import {
  DEFAULT_CAPTURE,
  keepAwake,
  listMics,
  onDeviceChange,
  startMic,
  type CaptureOptions,
  type MicCapture,
  type MicDevice,
  type WakeLock,
} from "./core/capture";
import { PhoneTransport } from "./core/transport";
import type { PairingParams } from "./core/protocol";

// ── Persistence (shell-only; core/ stays storage-free) ──────────────────────
// Saved across reloads so a transient drop or page refresh reconnects without a
// fresh QR scan. All access is guarded — Safari private mode / disabled storage
// must not crash the page.
const PAIRING_KEY = "am.phone.pairing";
const NAME_KEY = "am.phone.name";

function loadSavedPairing(): PairingParams | null {
  try {
    const raw = localStorage.getItem(PAIRING_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<PairingParams>;
    if (typeof v?.session === "string" && typeof v?.token === "string") {
      return { session: v.session, token: v.token };
    }
  } catch {
    // ignore
  }
  return null;
}

function savePairing(p: PairingParams) {
  try {
    localStorage.setItem(PAIRING_KEY, JSON.stringify({ session: p.session, token: p.token }));
  } catch {
    // ignore
  }
}

function clearSavedPairing() {
  try {
    localStorage.removeItem(PAIRING_KEY);
  } catch {
    // ignore
  }
}

function loadName(): string | null {
  try {
    const v = localStorage.getItem(NAME_KEY);
    return v && v.trim() ? v : null;
  } catch {
    return null;
  }
}

function saveName(name: string) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // ignore
  }
}

const app = document.getElementById("app")!;
const fromHash = pairingFromHash(location.hash);
const pairing = fromHash ?? loadSavedPairing();
// True only when we're relying on PERSISTED creds (no fresh QR this load). A
// fresh-QR attempt must NOT clear creds saved for another desktop, and is
// persisted only once that desktop accepts (see the "accepted" case) — so
// scanning desktop B's QR can't wipe desktop A's saved trust if B rejects.
const usingSavedCreds = !fromHash && pairing !== null;
// In-memory device name used for the next hello; edited via the name input.
let deviceName = loadName() ?? defaultDeviceName();

let mic: MicCapture | null = null;
let transport: PhoneTransport | null = null;
let wake: WakeLock | null = null;
let micError: string | null = null;
let starting = false;
let level = 0;
let meterTimer: ReturnType<typeof setInterval> | null = null;
let muted = false;
let mics: MicDevice[] = [];
let captureOpts: CaptureOptions = { ...DEFAULT_CAPTURE };
let lowBandwidth = false;
let deviceUnsub: (() => void) | null = null;

/** Phone is in OS data-saver mode (best-effort; absent on some browsers). */
const batterySaver =
  (navigator as unknown as { connection?: { saveData?: boolean } }).connection?.saveData === true;
let switching = false;

if (!pairing) {
  // No creds yet: still let the user name the device before scanning the QR.
  renderShell("ended", "missing-pairing", {
    onStart() {},
    onStop() {},
    onMute() {},
    onToggle() {},
    onPickMic() {},
    onLowBandwidth() {},
    onName(name: string) {
      saveName(name.trim() || defaultDeviceName());
    },
  });
} else {
  const machine = new PhoneMachine();

  const signaling = new SignalingClient(SignalingClient.defaultUrl(), {
    onOpen() {
      machine.dispatch({ kind: "ws-open" });
      signaling.send(
        helloMessage(pairing, { kind: "browser", name: deviceName, appVersion: "0.1.0" }),
      );
    },
    onMessage(msg) {
      switch (msg.type) {
        case "hello-ack":
          machine.dispatch({ kind: "hello-ack", acceptRequired: msg.acceptRequired });
          break;
        case "accepted":
          // Persist only once the desktop accepts — never store creds that get
          // rejected. Reuse on the next reload to reconnect without a QR scan.
          savePairing(pairing);
          saveName(deviceName);
          machine.dispatch({ kind: "accepted" });
          break;
        case "rejected":
          // Only drop creds we were actually relying on; a fresh-QR rejection
          // must not wipe creds saved for a different desktop.
          if (usingSavedCreds) clearSavedPairing();
          fail(`rejected: ${msg.reason}`);
          break;
        case "answer":
          void transport?.setAnswer(msg.sdp);
          break;
        case "candidate":
          void transport?.addCandidate({
            candidate: msg.candidate,
            sdpMid: msg.sdpMid,
            sdpMLineIndex: msg.sdpMLineIndex,
          });
          break;
        case "error":
          // Saved creds are genuinely dead — drop them so the next load shows
          // the QR prompt instead of retrying. Only when we relied on saved
          // creds (a fresh-QR failure must not wipe another desktop's trust);
          // other fatal codes (busy/version) keep creds: may still be valid.
          if (
            usingSavedCreds &&
            (msg.code === "unknown-session" || msg.code === "bad-token")
          ) {
            clearSavedPairing();
          }
          if (isFatalErrorCode(msg.code)) fail(`${msg.code}: ${msg.message}`);
          break;
        case "bye":
          // Only a real removal of the creds we relied on invalidates them;
          // transient reasons recover via the machine's reconnect.
          if (usingSavedCreds && msg.reason === "session-removed") clearSavedPairing();
          fail(msg.reason);
          break;
        case "latency":
          break;
      }
    },
    onLost() {
      machine.dispatch({ kind: "ws-lost" });
      teardownMedia(); // restart on reconnect needs a fresh gesture (mobile)
    },
  });

  function fail(reason: string) {
    machine.dispatch({ kind: "fatal", reason });
    teardownMedia();
    signaling.close();
  }

  async function beginCapture() {
    if (starting || mic) return;
    starting = true;
    micError = null;
    rerender();
    try {
      mic = await startMic(captureOpts);
      mic.track.enabled = !muted;
      wake = await keepAwake();
      transport = new PhoneTransport(mic.track, {
        onLocalCandidate(c) {
          signaling.send(candidateMessage(c));
        },
        onConnected() {
          machine.dispatch({ kind: "ice-connected" });
        },
        onFailed() {
          // ICE may still recover; leave the session up and let the user retry.
        },
      });
      const sdp = await transport.createOffer();
      signaling.send(offerMessage(sdp));
      void transport.setLowBandwidth(lowBandwidth);
      startMeter();
      // Labels are only available post-permission, so enumerate now.
      void listMics().then((list) => {
        mics = list;
        rerender();
      });
      // Recover from a mid-stream route change (headset/BT unplug) by falling
      // back to the default mic if the active device disappears.
      deviceUnsub = onDeviceChange(() => {
        void listMics().then((list) => {
          mics = list;
          const active = mic?.deviceId;
          if (active && !list.some((d) => d.deviceId === active)) {
            void applyCapture({ deviceId: undefined });
          } else {
            rerender();
          }
        });
      });
    } catch (e: unknown) {
      const name = (e as { name?: string })?.name;
      micError =
        name === "NotAllowedError"
          ? "Microphone permission denied. Allow it in your browser and try again."
          : `Microphone error: ${(e as { message?: string })?.message ?? String(e)}`;
      teardownMedia();
    } finally {
      starting = false;
      rerender();
    }
  }

  function stopStreaming() {
    signaling.send(byeMessage("user-stop"));
    machine.dispatch({ kind: "stop" });
    teardownMedia();
    signaling.close();
  }

  function toggleMute() {
    if (!mic) return;
    muted = !muted;
    mic.track.enabled = !muted;
    // Push the new state immediately so the desktop badge does not lag the poll.
    signaling.send(
      statsMessage(muted ? 0 : level, document.visibilityState === "visible", muted, batterySaver),
    );
    rerender();
  }

  function toggleLowBandwidth() {
    if (!transport) return;
    lowBandwidth = !lowBandwidth;
    void transport.setLowBandwidth(lowBandwidth); // no mic re-acquire, no renegotiation
    rerender();
  }

  // Re-acquire the mic with merged options (processing toggle / mic pick) and
  // hot-swap it into the live sender without renegotiating.
  async function applyCapture(partial: Partial<CaptureOptions>) {
    if (switching || !transport) return;
    switching = true;
    micError = null;
    rerender();
    const previous = captureOpts;
    captureOpts = { ...captureOpts, ...partial };
    try {
      const next = await startMic(captureOpts);
      next.track.enabled = !muted;
      await transport.replaceTrack(next.track);
      mic?.stop();
      mic = next;
      void listMics().then((list) => {
        mics = list;
        rerender();
      });
    } catch (e: unknown) {
      captureOpts = previous; // revert on failure
      micError = `Could not switch microphone: ${(e as { message?: string })?.message ?? String(e)}`;
    } finally {
      switching = false;
      rerender();
    }
  }

  function paintMeter() {
    const fill = app.querySelector<HTMLElement>(".meterFill");
    if (fill) fill.style.width = `${Math.round(meterScale(level) * 100)}%`;
  }

  function startMeter() {
    if (meterTimer !== null) return;
    let tick = 0;
    meterTimer = setInterval(() => {
      level = muted ? 0 : (mic?.level() ?? 0);
      // Only repaint the meter bar — a full re-render here (10x/s) would rebuild
      // the DOM and slam shut any open <select> / blur the controls.
      paintMeter();
      tick += 1;
      if (tick % 10 === 0) {
        signaling.send(
          statsMessage(level, document.visibilityState === "visible", muted, batterySaver),
        );
      }
    }, 100);
  }

  function teardownMedia() {
    if (meterTimer !== null) {
      clearInterval(meterTimer);
      meterTimer = null;
    }
    deviceUnsub?.();
    deviceUnsub = null;
    level = 0;
    muted = false;
    lowBandwidth = false;
    mics = [];
    transport?.close();
    transport = null;
    mic?.stop();
    mic = null;
    wake?.release();
    wake = null;
  }

  function rerender() {
    renderShell(machine.state, machine.reason, {
      onStart: beginCapture,
      onStop: stopStreaming,
      onMute: toggleMute,
      onToggle: (key) => void applyCapture({ [key]: !captureOpts[key] }),
      onPickMic: (deviceId) => void applyCapture({ deviceId }),
      onLowBandwidth: toggleLowBandwidth,
      onName: (name) => {
        deviceName = name.trim() || defaultDeviceName();
        saveName(deviceName); // takes effect on the next hello; no live re-send
      },
    });
  }

  machine.subscribe(() => rerender());
  machine.dispatch({ kind: "connect" });
  signaling.connect();

  window.addEventListener("pagehide", () => {
    signaling.send(byeMessage("page-hidden"));
  });
}

type ToggleKey = "echoCancellation" | "noiseSuppression" | "autoGainControl";

interface Handlers {
  onStart(): void;
  onStop(): void;
  onMute(): void;
  onToggle(key: ToggleKey): void;
  onPickMic(deviceId: string): void;
  onLowBandwidth(): void;
  onName(name: string): void;
}

function renderShell(state: PhoneState, reason: string | null, handlers?: Handlers) {
  const stateLabel: Record<PhoneState, string> = {
    idle: "Starting…",
    connecting: "Connecting to AudioManager…",
    "hello-sent": "Checking pairing…",
    "waiting-accept": "Waiting for the desktop to accept…",
    negotiating: mic ? "Connecting audio…" : "Accepted — start your microphone",
    live: "Live — streaming to AudioManager",
    reconnecting: "Connection lost — retrying…",
    ended:
      reason === "user-stop"
        ? "Stopped"
        : reason === "missing-pairing"
          ? "Scan the QR code in AudioManager to start"
          : `Session ended: ${reason ?? "unknown"}`,
  };

  const tone =
    state === "live"
      ? "ok"
      : state === "negotiating"
        ? mic
          ? "warn"
          : "ok"
        : state === "ended"
          ? "err"
          : state === "waiting-accept" || state === "reconnecting"
            ? "warn"
            : "idle";

  const showStart = state === "negotiating" && !mic && !starting;
  const showMeter = (state === "negotiating" || state === "live") && !!mic;
  const showKeepAwake = state === "live" || (state === "negotiating" && !!mic);
  // Editable device name in the pre-live states where it still matters: before
  // pairing (missing-pairing), while waiting for accept, and after accept before
  // the mic starts. Edits apply on the next hello, so hide it once live.
  const showName =
    (state === "ended" && reason === "missing-pairing") ||
    state === "waiting-accept" ||
    (state === "negotiating" && !mic);

  const toggles: { key: ToggleKey; label: string }[] = [
    { key: "noiseSuppression", label: "Noise suppression" },
    { key: "echoCancellation", label: "Echo cancel" },
    { key: "autoGainControl", label: "Auto gain" },
  ];
  const dis = switching ? "disabled" : "";

  app.innerHTML = `
    <div class="card">
      <div class="dot ${muted && showMeter ? "warn" : tone}"></div>
      <h1>AudioManager</h1>
      <p class="state">${starting ? "Requesting microphone…" : muted && showMeter ? "Muted" : stateLabel[state]}</p>
      ${micError ? `<p class="detail err">${micError}</p>` : ""}
      ${
        showName
          ? `<label class="nameField">Device name
               <input id="nameInput" class="nameInput" type="text" inputmode="text"
                 autocomplete="off" autocapitalize="words" maxlength="40"
                 value="${escapeHtml(deviceName)}" placeholder="${escapeHtml(defaultDeviceName())}" />
             </label>`
          : ""
      }
      ${showStart ? `<button id="startBtn" class="btn">Start microphone</button>` : ""}
      ${showMeter ? `<div class="meter ${muted ? "muted" : ""}"><div class="meterFill" style="width:${Math.round(meterScale(level) * 100)}%"></div></div>` : ""}
      ${
        showMeter
          ? `<button id="muteBtn" class="btn ${muted ? "danger" : "ghost"}">${muted ? "Unmute" : "Mute"}</button>`
          : ""
      }
      ${
        showMeter
          ? `<div class="controls">
               ${toggles
                 .map(
                   (t) =>
                     `<label class="chk"><input type="checkbox" data-tk="${t.key}" ${
                       captureOpts[t.key] ? "checked" : ""
                     } ${dis}/> ${t.label}</label>`,
                 )
                 .join("")}
               <label class="chk"><input type="checkbox" id="lowbw" ${
                 lowBandwidth ? "checked" : ""
               }/> Low bandwidth</label>
             </div>`
          : ""
      }
      ${
        showMeter && batterySaver
          ? `<p class="detail">Battery saver is on — it can throttle the mic. Turn it off for the most stable stream.</p>`
          : ""
      }
      ${
        showMeter && mics.length > 1
          ? `<select id="micSel" class="sel" ${dis}>${mics
              .map(
                (m) =>
                  `<option value="${escapeAttr(m.deviceId)}" ${
                    mic && mic.deviceId === m.deviceId ? "selected" : ""
                  }>${escapeHtml(m.label)}</option>`,
              )
              .join("")}</select>`
          : ""
      }
      ${showMeter ? `<button id="stopBtn" class="btn ghost">Stop streaming</button>` : ""}
      ${showKeepAwake ? `<p class="detail">Keep this screen on — locking the phone stops the mic in a browser.</p>` : ""}
    </div>`;

  if (handlers) {
    const startBtn = document.getElementById("startBtn");
    if (startBtn) startBtn.onclick = () => handlers.onStart();
    const stopBtn = document.getElementById("stopBtn");
    if (stopBtn) stopBtn.onclick = () => handlers.onStop();
    const muteBtn = document.getElementById("muteBtn");
    if (muteBtn) muteBtn.onclick = () => handlers.onMute();
    for (const box of Array.from(document.querySelectorAll<HTMLInputElement>("input[data-tk]"))) {
      box.onchange = () => handlers.onToggle(box.dataset.tk as ToggleKey);
    }
    const lowbw = document.getElementById("lowbw");
    if (lowbw) lowbw.onchange = () => handlers.onLowBandwidth();
    const micSel = document.getElementById("micSel") as HTMLSelectElement | null;
    if (micSel) micSel.onchange = () => handlers.onPickMic(micSel.value);
    const nameInput = document.getElementById("nameInput") as HTMLInputElement | null;
    if (nameInput) {
      const onName = () => handlers.onName(nameInput.value);
      nameInput.oninput = onName;
      nameInput.onchange = onName;
    }
  }
}

/**
 * Map a linear 0..1 amplitude peak to a 0..1 bar width on a dB scale
 * (-60 dB..0 dB), so quiet speech reads visibly and the bar tracks perceived
 * loudness. The desktop meter uses the identical mapping (PhonePairingSheet),
 * so both bars match.
 */
function meterScale(peak: number): number {
  if (peak <= 0.0001) return 0;
  const db = 20 * Math.log10(Math.min(1, peak));
  return Math.max(0, Math.min(1, (db + 60) / 60));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;");
}
