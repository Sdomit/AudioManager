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
  requestEndpointStateMessage,
  setEndpointMuteMessage,
  setEndpointVolumeMessage,
  statsMessage,
  type EndpointStateView,
  type EndpointTarget,
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

// Hero level-meter ring: circumference of r=92 (2π·92 ≈ 578). The live arc's
// stroke-dashoffset is driven from this.
const RING_C = 578;

// Inline SVG icons (no icon font — keeps the phone bundle tiny). currentColor +
// the parent's font-size drive their look.
const MIC_ON = `<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="21.5"/></svg>`;
const MIC_OFF = `<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 9.3V5.5a3 3 0 0 0-5.8-1.1"/><path d="M9 9.2V11a3 3 0 0 0 4.5 2.6"/><path d="M5 11a7 7 0 0 0 10.9 5.8"/><line x1="12" y1="18" x2="12" y2="21.5"/><line x1="3.5" y1="3.5" x2="20.5" y2="20.5"/></svg>`;
const QR_GLYPH = `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3M21 14v7h-7"/></svg>`;
const CLOCK_GLYPH = `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5l3 2"/></svg>`;

const app = document.getElementById("app")!;
const fromHash = pairingFromHash(location.hash);
const pairing = fromHash ?? loadSavedPairing();
// Whether the creds we're using are persisted for THIS desktop — true if we
// loaded them from storage, OR once this desktop accepts a fresh QR (set below).
// A revocation of persisted creds clears them + drops to scan-QR; a fresh-QR
// failure BEFORE acceptance must NOT wipe creds saved for another desktop.
let credsArePersisted = !fromHash && pairing !== null;
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
// "Audio settings" collapsible open state, preserved across re-renders.
let controlsOpen = false;
// Mini-controller remote (MC-5): latest desktop speaker/mic state + the
// "Desktop volume" panel's open state, both preserved across re-renders.
let endpointState: EndpointStateView[] = [];
let remoteOpen = false;

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
    onRemoteVolume() {},
    onRemoteMute() {},
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
          // These creds are now trusted by this desktop, so a later revocation
          // (kick / session-removed) should clear them and drop to scan-QR even
          // though this load came from a fresh QR.
          credsArePersisted = true;
          machine.dispatch({ kind: "accepted" });
          // Now trusted — pull the desktop speaker/mic state for the remote panel.
          signaling.send(requestEndpointStateMessage());
          break;
        case "rejected":
          if (credsArePersisted) {
            // Saved creds are dead — clear them and show the scan-QR screen
            // rather than a terminal "session ended" needing a manual reload.
            clearSavedPairing();
            fail("missing-pairing");
          } else {
            // Fresh-QR rejection: don't wipe creds saved for another desktop.
            fail(`rejected: ${msg.reason}`);
          }
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
          if (
            credsArePersisted &&
            (msg.code === "unknown-session" || msg.code === "bad-token")
          ) {
            // Saved session gone/invalid — clear creds and fall back to the
            // scan-QR screen (no manual reload). A fresh-QR failure must not wipe
            // another desktop's trust; busy/version keep creds (may still work).
            clearSavedPairing();
            fail("missing-pairing");
            break;
          }
          if (isFatalErrorCode(msg.code)) fail(`${msg.code}: ${msg.message}`);
          break;
        case "bye":
          if (credsArePersisted && msg.reason === "session-removed") {
            // The desktop kicked this trusted device — clear creds, show scan-QR.
            clearSavedPairing();
            fail("missing-pairing");
          } else {
            // Non-revoke bye (e.g. "disconnected") ends this session but keeps
            // the saved creds — reopening the page auto-resumes from them (this
            // is terminal, not a live machine reconnect).
            fail(msg.reason);
          }
          break;
        case "latency":
          break;
        case "endpoint-state":
          // Mini-controller remote (MC-5): reflect the desktop's speaker/mic.
          endpointState = msg.endpoints;
          rerender();
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
    let next: MicCapture | undefined;
    try {
      next = await startMic(captureOpts);
      next.track.enabled = !muted;
      await transport.replaceTrack(next.track);
      mic?.stop();
      mic = next;
      void listMics().then((list) => {
        mics = list;
        rerender();
      });
    } catch (e: unknown) {
      next?.stop(); // release the orphaned mic if the hot-swap never committed
      captureOpts = previous; // revert on failure
      micError = `Could not switch microphone: ${(e as { message?: string })?.message ?? String(e)}`;
    } finally {
      switching = false;
      rerender();
    }
  }

  function paintMeter() {
    const arc = app.querySelector<SVGCircleElement>("#meterArc");
    // Set the inline STYLE property, not the attribute: the arc's initial
    // stroke-dashoffset lives in its inline style, which always overrides a
    // presentation attribute — so setAttribute here would be ignored and the
    // ring would never move. style also lets the CSS transition animate it.
    if (arc) {
      arc.style.strokeDashoffset = String(Math.round(RING_C * (1 - meterScale(level))));
    }
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
      onRemoteVolume: (target, value) => {
        signaling.send(setEndpointVolumeMessage(target, value));
      },
      onRemoteMute: (target) => {
        const cur = endpointState.find((e) => e.target === target);
        signaling.send(setEndpointMuteMessage(target, !(cur?.muted ?? false)));
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
  onRemoteVolume(target: EndpointTarget, value: number): void;
  onRemoteMute(target: EndpointTarget): void;
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
          : reason === "disconnected"
            ? "Disconnected — reopen this page to reconnect"
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
  // MC-5 remote: the desktop speaker/mic panel shows once accepted. The desktop
  // also gates server-side, so controls before accept are ignored anyway.
  const showRemote = state === "live" || state === "negotiating";
  // Editable device name in the pre-live states where it still matters: before
  // pairing (missing-pairing), while waiting for accept, and after accept before
  // the mic starts. Edits apply on the next hello, so hide it once live.
  const showName =
    (state === "ended" && reason === "missing-pairing") ||
    state === "waiting-accept" ||
    (state === "negotiating" && !mic);

  const toggles: { key: ToggleKey; label: string }[] = [
    { key: "noiseSuppression", label: "Noise" },
    { key: "echoCancellation", label: "Echo" },
    { key: "autoGainControl", label: "Auto gain" },
  ];
  const dis = switching ? "disabled" : "";

  const muteState = muted && showMeter;
  const pillTone = muteState ? "warn" : tone;
  const pillLabel = showMeter
    ? muted
      ? "Muted"
      : state === "live"
        ? "Live"
        : "Connecting"
    : state === "waiting-accept"
      ? "Waiting"
      : state === "reconnecting"
        ? "Reconnecting"
        : state === "negotiating"
          ? "Ready"
          : state === "ended"
            ? reason === "missing-pairing"
              ? "Pair"
              : "Ended"
            : "Connecting";
  const statusText = starting ? "Requesting microphone…" : muteState ? "Muted" : stateLabel[state];

  // Hero ring shows the live level arc while streaming, else an empty track with
  // a state glyph/spinner in the hub.
  const ringOffset = Math.round(RING_C * (1 - (showMeter ? meterScale(level) : 0)));

  let hub: string;
  if (showMeter) {
    hub = `<button id="muteBtn" class="hubBtn ${muted ? "muted" : ""}" aria-label="${
      muted ? "Unmute microphone" : "Mute microphone"
    }">${muted ? MIC_OFF : MIC_ON}<span class="hubLabel">${muted ? "Unmute" : "Tap to mute"}</span></button>`;
  } else if (showStart) {
    hub = `<button id="startBtn" class="hubBtn" aria-label="Start microphone">${MIC_ON}<span class="hubLabel">Start</span></button>`;
  } else {
    const glyph =
      state === "ended"
        ? reason === "missing-pairing"
          ? QR_GLYPH
          : `<span class="spin" style="animation:none;border-color:#262a32"></span>`
        : state === "waiting-accept"
          ? CLOCK_GLYPH
          : `<span class="spin"></span>`;
    hub = `<div class="glyph">${glyph}</div>`;
  }

  const nameBlock = showName
    ? `<label class="nameField">Device name<input id="nameInput" class="nameInput" type="text" inputmode="text" autocomplete="off" autocapitalize="words" maxlength="40" value="${escapeHtml(
        deviceName,
      )}" placeholder="${escapeHtml(defaultDeviceName())}" /></label>`
    : showMeter
      ? `<div class="devName">${escapeHtml(deviceName)}</div>`
      : "";

  app.innerHTML = `
    <main class="screen">
      <div class="topbar">
        <span class="brand">AudioManager</span>
        <span class="pill ${pillTone}"><span class="pdot"></span>${pillLabel}</span>
      </div>
      ${nameBlock}
      <div class="hero">
        <svg class="ring" viewBox="0 0 208 208" aria-hidden="true">
          <circle class="ringTrack" cx="104" cy="104" r="92"></circle>
          <circle class="ringArc" id="meterArc" cx="104" cy="104" r="92" style="stroke:#22c55e;stroke-dasharray:${RING_C};stroke-dashoffset:${ringOffset}"></circle>
        </svg>
        <div class="hub">${hub}</div>
      </div>
      <p class="status ${pillTone === "err" ? "err" : ""}">${statusText}</p>
      ${micError ? `<p class="detail err">${micError}</p>` : ""}
      ${showMeter && !muted ? `<p class="detail">Hearing you clearly</p>` : ""}
      ${
        showMeter
          ? `<details class="settings" ${controlsOpen ? "open" : ""}>
               <summary><span>Audio settings</span><span class="chev"></span></summary>
               <div class="grid">
                 ${toggles
                   .map(
                     (t) =>
                       `<label class="tog"><span>${t.label}</span><input type="checkbox" data-tk="${
                         t.key
                       }" ${captureOpts[t.key] ? "checked" : ""} ${dis}/><span class="sw"></span></label>`,
                   )
                   .join("")}
                 <label class="tog"><span>Low data</span><input type="checkbox" id="lowbw" ${
                   lowBandwidth ? "checked" : ""
                 }/><span class="sw"></span></label>
               </div>
               ${
                 mics.length > 1
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
               ${
                 batterySaver
                   ? `<p class="detail" style="padding:0 13px 13px">Battery saver can throttle the mic — turn it off for the most stable stream.</p>`
                   : ""
               }
             </details>`
          : ""
      }
      ${showRemote ? remotePanelHtml() : ""}
      ${showMeter ? `<button id="stopBtn" class="stopBtn">Stop streaming</button>` : ""}
      ${showKeepAwake ? `<p class="hint">Keep this screen on — locking the phone stops the mic in a browser.</p>` : ""}
    </main>`;

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
    const settings = document.querySelector<HTMLDetailsElement>("details.settings:not(.remotePanel)");
    if (settings) settings.ontoggle = () => (controlsOpen = settings.open);
    // MC-5 remote controls. Sliders use `change` (fires on release) so an
    // echoed endpoint-state push can't stomp the thumb mid-drag.
    for (const s of Array.from(document.querySelectorAll<HTMLInputElement>("input[data-rt]"))) {
      s.onchange = () =>
        handlers.onRemoteVolume(s.dataset.rt as EndpointTarget, Number(s.value) / 100);
    }
    for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("button[data-rm]"))) {
      b.onclick = () => handlers.onRemoteMute(b.dataset.rm as EndpointTarget);
    }
    const remote = document.querySelector<HTMLDetailsElement>("details.remotePanel");
    if (remote) remote.ontoggle = () => (remoteOpen = remote.open);
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

// ── Mini-controller remote panel (MC-5) ───────────────────────────────────────

/** The "Desktop volume" collapsible: a row each for the OS speaker and mic. */
function remotePanelHtml(): string {
  return `<details class="settings remotePanel" ${remoteOpen ? "open" : ""}>
    <summary><span>Desktop volume</span><span class="chev"></span></summary>
    <div style="padding:4px 0 8px">
      ${remoteRowHtml("speaker", "Speaker")}
      ${remoteRowHtml("mic", "Mic")}
    </div>
  </details>`;
}

/** One endpoint row: name + %, a release-fired slider, and a mute toggle. */
function remoteRowHtml(target: EndpointTarget, fallback: string): string {
  const v = endpointState.find((e) => e.target === target);
  const avail = v?.available ?? false;
  const vol = Math.round((v?.volume ?? 0) * 100);
  const isMuted = v?.muted ?? false;
  const name = (v?.name ?? "").trim() || fallback;
  const dis = avail ? "" : "disabled";
  return `<div style="padding:8px 13px;display:flex;flex-direction:column;gap:6px">
    <div style="display:flex;justify-content:space-between;font-size:13px;color:#cdd3dd">
      <span>${escapeHtml(name)}</span>
      <span style="font-variant-numeric:tabular-nums;color:#8a93a3">${avail ? `${vol}%` : "—"}</span>
    </div>
    <div style="display:flex;align-items:center;gap:10px">
      <input type="range" data-rt="${target}" min="0" max="100" value="${vol}" ${dis}
        aria-label="${escapeAttr(name)} volume" style="flex:1" />
      <button data-rm="${target}" ${dis} aria-pressed="${isMuted}"
        aria-label="${isMuted ? "Unmute" : "Mute"} ${escapeAttr(name)}"
        style="background:none;border:none;font-size:18px;cursor:pointer;line-height:1">${
          isMuted ? "🔇" : "🔊"
        }</button>
    </div>
  </div>`;
}
