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
import { DEFAULT_CAPTURE, keepAwake, startMic, type MicCapture, type WakeLock } from "./core/capture";
import { PhoneTransport } from "./core/transport";

const app = document.getElementById("app")!;
const pairing = pairingFromHash(location.hash);

let mic: MicCapture | null = null;
let transport: PhoneTransport | null = null;
let wake: WakeLock | null = null;
let micError: string | null = null;
let starting = false;
let level = 0;
let meterTimer: ReturnType<typeof setInterval> | null = null;

if (!pairing) {
  renderShell("ended", "missing-pairing");
} else {
  const machine = new PhoneMachine();

  const signaling = new SignalingClient(SignalingClient.defaultUrl(), {
    onOpen() {
      machine.dispatch({ kind: "ws-open" });
      signaling.send(
        helloMessage(pairing, { kind: "browser", name: defaultDeviceName(), appVersion: "0.1.0" }),
      );
    },
    onMessage(msg) {
      switch (msg.type) {
        case "hello-ack":
          machine.dispatch({ kind: "hello-ack", acceptRequired: msg.acceptRequired });
          break;
        case "accepted":
          machine.dispatch({ kind: "accepted" });
          break;
        case "rejected":
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
          if (isFatalErrorCode(msg.code)) fail(`${msg.code}: ${msg.message}`);
          break;
        case "bye":
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
      mic = await startMic(DEFAULT_CAPTURE);
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
      startMeter();
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

  function startMeter() {
    if (meterTimer !== null) return;
    let tick = 0;
    meterTimer = setInterval(() => {
      level = mic?.level() ?? 0;
      tick += 1;
      if (tick % 10 === 0) {
        signaling.send(statsMessage(level, document.visibilityState === "visible"));
      }
      rerender();
    }, 100);
  }

  function teardownMedia() {
    if (meterTimer !== null) {
      clearInterval(meterTimer);
      meterTimer = null;
    }
    level = 0;
    transport?.close();
    transport = null;
    mic?.stop();
    mic = null;
    wake?.release();
    wake = null;
  }

  function rerender() {
    renderShell(machine.state, machine.reason, { onStart: beginCapture, onStop: stopStreaming });
  }

  machine.subscribe(() => rerender());
  machine.dispatch({ kind: "connect" });
  signaling.connect();

  window.addEventListener("pagehide", () => {
    signaling.send(byeMessage("page-hidden"));
  });
}

interface Handlers {
  onStart(): void;
  onStop(): void;
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

  app.innerHTML = `
    <div class="card">
      <div class="dot ${tone}"></div>
      <h1>AudioManager</h1>
      <p class="state">${starting ? "Requesting microphone…" : stateLabel[state]}</p>
      ${micError ? `<p class="detail err">${micError}</p>` : ""}
      ${showStart ? `<button id="startBtn" class="btn">Start microphone</button>` : ""}
      ${showMeter ? `<div class="meter"><div class="meterFill" style="width:${Math.round(level * 100)}%"></div></div>` : ""}
      ${showMeter ? `<button id="stopBtn" class="btn ghost">Stop streaming</button>` : ""}
      ${showKeepAwake ? `<p class="detail">Keep this screen on — locking the phone stops the mic in a browser.</p>` : ""}
    </div>`;

  if (handlers) {
    const startBtn = document.getElementById("startBtn");
    if (startBtn) startBtn.onclick = () => handlers.onStart();
    const stopBtn = document.getElementById("stopBtn");
    if (stopBtn) stopBtn.onclick = () => handlers.onStop();
  }
}
