import { describe, expect, it } from "vitest";
import { backendVolumeToUi } from "./adapters";
import { gainToDb } from "./units";

describe("gainToDb", () => {
  it("labels engine unity (1.0) as 0 dB", () => {
    expect(gainToDb(backendVolumeToUi(1.0))).toBe("0 dB");
  });
  it("labels engine max (2.0) as +6 dB", () => {
    expect(gainToDb(backendVolumeToUi(2.0))).toBe("+6 dB");
  });
  it("labels half engine gain as -6 dB and silence as -inf", () => {
    expect(gainToDb(backendVolumeToUi(0.5))).toBe("-6 dB");
    expect(gainToDb(0)).toBe("-∞ dB");
  });
});
