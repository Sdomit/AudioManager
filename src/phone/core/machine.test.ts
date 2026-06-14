import { describe, expect, it } from "vitest";

import { PhoneMachine } from "./machine";

describe("PhoneMachine", () => {
  it("walks the happy path to live", () => {
    const m = new PhoneMachine();
    expect(m.state).toBe("idle");
    m.dispatch({ kind: "connect" });
    expect(m.state).toBe("connecting");
    m.dispatch({ kind: "ws-open" });
    expect(m.state).toBe("hello-sent");
    m.dispatch({ kind: "hello-ack", acceptRequired: true });
    expect(m.state).toBe("waiting-accept");
    m.dispatch({ kind: "accepted" });
    expect(m.state).toBe("negotiating");
    m.dispatch({ kind: "ice-connected" });
    expect(m.state).toBe("live");
  });

  it("skips waiting-accept when acceptRequired is false (resume)", () => {
    const m = new PhoneMachine();
    m.dispatch({ kind: "connect" });
    m.dispatch({ kind: "ws-open" });
    m.dispatch({ kind: "hello-ack", acceptRequired: false });
    expect(m.state).toBe("negotiating");
  });

  it("ignores invalid (state, event) pairs", () => {
    const m = new PhoneMachine();
    m.dispatch({ kind: "accepted" }); // not valid from idle
    expect(m.state).toBe("idle");
    m.dispatch({ kind: "ice-connected" }); // not valid from idle
    expect(m.state).toBe("idle");
  });

  it("recovers to reconnecting from any recoverable state on ws-lost", () => {
    for (const reach of ["connecting", "hello-sent", "waiting-accept", "negotiating", "live"] as const) {
      const m = new PhoneMachine();
      m.dispatch({ kind: "connect" });
      if (reach !== "connecting") m.dispatch({ kind: "ws-open" });
      if (reach === "waiting-accept") m.dispatch({ kind: "hello-ack", acceptRequired: true });
      if (reach === "negotiating") m.dispatch({ kind: "hello-ack", acceptRequired: false });
      if (reach === "live") {
        m.dispatch({ kind: "hello-ack", acceptRequired: false });
        m.dispatch({ kind: "ice-connected" });
      }
      expect(m.state).toBe(reach);
      m.dispatch({ kind: "ws-lost" });
      expect(m.state).toBe("reconnecting");
    }
  });

  it("re-hello from reconnecting goes through hello-sent", () => {
    const m = new PhoneMachine();
    m.dispatch({ kind: "connect" });
    m.dispatch({ kind: "ws-open" });
    m.dispatch({ kind: "ws-lost" });
    expect(m.state).toBe("reconnecting");
    m.dispatch({ kind: "ws-open" });
    expect(m.state).toBe("hello-sent");
  });

  it("ended is terminal and records the reason", () => {
    const m = new PhoneMachine();
    m.dispatch({ kind: "connect" });
    m.dispatch({ kind: "fatal", reason: "bad-token: nope" });
    expect(m.state).toBe("ended");
    expect(m.reason).toBe("bad-token: nope");
    m.dispatch({ kind: "ws-open" });
    expect(m.state).toBe("ended"); // no escape
  });

  it("notifies subscribers on entry and on change", () => {
    const m = new PhoneMachine();
    const seen: string[] = [];
    m.subscribe((s) => seen.push(s));
    m.dispatch({ kind: "connect" });
    m.dispatch({ kind: "accepted" }); // ignored, no notify
    expect(seen).toEqual(["idle", "connecting"]);
  });
});
