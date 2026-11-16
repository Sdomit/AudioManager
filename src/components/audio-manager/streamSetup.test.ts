import { describe, expect, it } from "vitest";
import { deriveStreamSetupSteps } from "./streamSetup";
import type { AudioInput, Bus, Send } from "./types";

const bus = (over: Partial<Bus>): Bus =>
  ({ id: "B1", role: "stream", label: "Stream", device: null, enabled: false, muted: false, ...over }) as Bus;
const mic = { id: "mic", name: "Mic" } as AudioInput;
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

  it("warns when the stream bus goes to a physical device", () => {
    const steps = deriveStreamSetupSteps([bus({ device: "Speakers (Realtek)", enabled: true })], [mic], [send]);
    expect(steps.find((s) => s.id === "vcable")?.status).toBe("warning");
  });
});
