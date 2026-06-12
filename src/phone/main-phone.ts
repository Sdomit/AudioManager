/**
 * Phase 1 placeholder shell for the phone client.
 *
 * Proves the pairing path end-to-end: parse the QR fragment, connect the
 * signaling socket, walk the state machine to "paired". Microphone capture
 * and WebRTC land in Phase 2 (src/phone/ui/ becomes the real shell; the
 * core/ modules used here stay as-is).
 */

import { PhoneMachine, type PhoneState } from "./core/machine";
import {
  byeMessage,
  defaultDeviceName,
  helloMessage,
  isFatalErrorCode,
  pairingFromHash,
} from "./core/protocol";
import { SignalingClient } from "./core/signaling";

const app = document.getElementById("app")!;

function render(state: PhoneState, reason: string | null, detail?: string) {
  const labels: Record<PhoneState, string> = {
    idle: "Starting…",
    connecting: "Connecting to AudioManager…",
    "hello-sent": "Checking pairing…",
    "waiting-accept": "Waiting for the desktop to accept…",
    negotiating: "Paired ✓ — audio streaming arrives in Phase 2",
    live: "Live",
    reconnecting: "Connection lost — retrying…",
    ended: reason === "user-stop" ? "Stopped" : `Session ended: ${reason ?? "unknown"}`,
  };
  const toneClass =
    state === "negotiating" || state === "live"
      ? "ok"
      : state === "ended"
        ? "err"
        : state === "waiting-accept" || state === "reconnecting"
          ? "warn"
          : "idle";
  app.innerHTML = `
    <div class="card">
      <div class="dot ${toneClass}"></div>
      <h1>AudioManager</h1>
      <p class="state">${labels[state]}</p>
      ${detail ? `<p class="detail">${detail}</p>` : ""}
    </div>`;
}

const pairing = pairingFromHash(location.hash);
if (!pairing) {
  render("ended", "missing-pairing", "Open this page by scanning the QR code in AudioManager.");
} else {
  const machine = new PhoneMachine();
  machine.subscribe((state, reason) => render(state, reason));

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
          machine.dispatch({ kind: "fatal", reason: `rejected: ${msg.reason}` });
          signaling.close();
          break;
        case "error":
          if (isFatalErrorCode(msg.code)) {
            machine.dispatch({ kind: "fatal", reason: `${msg.code}: ${msg.message}` });
            signaling.close();
          }
          break;
        case "bye":
          machine.dispatch({ kind: "fatal", reason: msg.reason });
          signaling.close();
          break;
        default:
          // answer/candidate/latency: Phase 2.
          break;
      }
    },
    onLost() {
      machine.dispatch({ kind: "ws-lost" });
    },
  });

  machine.dispatch({ kind: "connect" });
  signaling.connect();

  window.addEventListener("pagehide", () => {
    signaling.send(byeMessage("page-hidden"));
  });
}
