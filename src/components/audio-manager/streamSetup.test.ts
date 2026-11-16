import { describe, expect, it } from "vitest";
import { deriveStreamSetupSteps } from "./streamSetup";
import type { AudioInput, Bus, Send } from "./types";

const bus = (over: Partial<Bus>): Bus =>
  ({ id: "B1", role: "stream", label: "Stream", device: null, enabled: false, muted: false, ...over }) as Bus;
const mic = { id: "mic", name: "Mic", gain: 0.5, muted: false } as AudioInput;
const send: Send = { inputId: "mic", busId: "B1", enabled: true, gain: 0.5, muted: false };

describe("deriveStreamSetupSteps", () => {
  it("flags an unconfigured stream bus instead of claiming success", () => {
    const steps = deriveStreamSetupSteps([bus({})], [mic], []);
    expect(steps.map((s) => s.status)).toEqual(["error", "pending", "warning", "pending"]);
  });

  it("is all ok for a live bus on a virtual cable with a routed input", () => {
    const steps = deriveStreamSetupSteps(
      [bus({ device: "CABLE Input (VB-Audio Virtual Cable)", enabled: true })],
      [mic],
      [send],
    );
    expect(steps.every((s) => s.status === "ok")).toBe(true);
    expect(steps.find((s) => s.id === "routing")?.detail).toContain("Mic");
  });

  it("reports a failed output instead of declaring the stream live", () => {
    const steps = deriveStreamSetupSteps(
      [bus({ device: "CABLE Input (VB-Audio Virtual Cable)", enabled: true, state: "error", error: "Device disconnected" })],
      [mic],
      [send],
    );
    const live = steps.find((s) => s.id === "enabled");
    expect(live?.status).toBe("error");
    expect(live?.detail).toContain("Device disconnected");
  });

  it("checks B1 even when another bus has the Stream role override", () => {
    const a1 = bus({ id: "A1", role: "stream", label: "Monitor", device: "CABLE Input (VB-Audio Virtual Cable)", enabled: true });
    const b1 = bus({ role: "monitor" });
    const steps = deriveStreamSetupSteps([a1, b1], [mic], [{ ...send, busId: "A1" }]);
    expect(steps.find((s) => s.id === "busdevice")?.status).toBe("error");
    expect(steps.find((s) => s.id === "routing")?.status).toBe("warning");
  });

  it("does not count a muted input as routed", () => {
    const steps = deriveStreamSetupSteps([bus({ device: "CABLE Input", enabled: true })], [{ ...mic, muted: true }], [send]);
    expect(steps.find((s) => s.id === "routing")?.status).toBe("warning");
  });

  it("is not ready before the buses load", () => {
    expect(deriveStreamSetupSteps([], [], []).map((s) => s.status)).toEqual(["pending"]);
  });

  it("warns when the stream bus goes to a physical device", () => {
    const steps = deriveStreamSetupSteps([bus({ device: "Speakers (Realtek)", enabled: true })], [mic], [send]);
    expect(steps.find((s) => s.id === "vcable")?.status).toBe("warning");
  });
});
