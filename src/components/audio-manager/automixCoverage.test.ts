import { describe, expect, it } from "vitest";
import { groupGateCoverage } from "./automixCoverage";
import type { Bus, Send } from "./types";

// Fixtures: groupGateCoverage only reads id/enabled (Bus) and
// inputId/busId/enabled (Send); cast through unknown to skip the unrelated fields.
const bus = (id: Bus["id"], enabled = true): Bus =>
  ({ id, enabled }) as unknown as Bus;

const send = (inputId: string, busId: Send["busId"], enabled = true): Send => ({
  inputId,
  busId,
  enabled,
  gain: 1,
  muted: false,
});

describe("groupGateCoverage", () => {
  it("gates when two members share one enabled bus", () => {
    const r = groupGateCoverage(
      ["a", "b"],
      [send("a", "B1"), send("b", "B1")],
      [bus("B1")],
    );
    expect(r.gates).toBe(true);
    expect(r.gatingBuses).toEqual(["B1"]);
  });

  it("does NOT gate when members are split across different buses", () => {
    const r = groupGateCoverage(
      ["a", "b"],
      [send("a", "A1"), send("b", "B1")],
      [bus("A1"), bus("B1")],
    );
    expect(r.gates).toBe(false);
    expect(r.gatingBuses).toEqual([]);
  });

  it("ignores disabled sends and disabled buses", () => {
    const split = groupGateCoverage(
      ["a", "b"],
      [send("a", "B1"), send("b", "B1", false)],
      [bus("B1")],
    );
    expect(split.gates).toBe(false);

    const offBus = groupGateCoverage(
      ["a", "b"],
      [send("a", "B1"), send("b", "B1")],
      [bus("B1", false)],
    );
    expect(offBus.gates).toBe(false);
  });

  it("ignores non-member sends", () => {
    const r = groupGateCoverage(
      ["a", "b"],
      [send("a", "B1"), send("x", "B1")],
      [bus("B1")],
    );
    expect(r.gates).toBe(false);
  });
});
