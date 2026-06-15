import { describe, expect, it } from "vitest";
import { correlation, suggestPhoneGroups, variance } from "./automixSuggest";

/** A noisy ramp; `phase`-shifted copies are correlated, an independent one is not. */
function wave(n: number, seed: number, scale = 1): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push((0.5 + 0.5 * Math.sin((i + seed) * 0.5)) * scale);
  }
  return out;
}

describe("correlation", () => {
  it("is ~1 for identical series and ~-1 for inverted", () => {
    const a = wave(40, 0);
    const b = a.map((x) => 1 - x);
    expect(correlation(a, a)).toBeCloseTo(1, 5);
    expect(correlation(a, b)).toBeCloseTo(-1, 5);
  });

  it("is 0 for a flat (zero-variance) series", () => {
    expect(correlation(wave(40, 0), new Array(40).fill(0.3))).toBe(0);
  });
});

describe("variance", () => {
  it("is zero for a constant series and positive for a varying one", () => {
    expect(variance(new Array(20).fill(0.5))).toBe(0);
    expect(variance(wave(40, 0))).toBeGreaterThan(0);
  });
});

describe("suggestPhoneGroups", () => {
  it("groups phones whose levels move together and excludes an independent one", () => {
    const a = wave(40, 0);
    const history = {
      "phone:a": a,
      "phone:b": wave(40, 0.05), // nearly in phase with a → correlated
      "phone:c": a.map((x) => 1 - x), // inverted → anti-correlated with a/b
    };
    const groups = suggestPhoneGroups(history, ["phone:a", "phone:b", "phone:c"]);
    expect(groups).toHaveLength(1);
    expect(groups[0].sort()).toEqual(["phone:a", "phone:b"]);
  });

  it("ignores inputs without enough samples or activity", () => {
    const history = {
      "phone:a": wave(40, 0),
      "phone:b": wave(8, 0.05), // too few samples
      "phone:c": new Array(40).fill(0.2), // flat / idle
    };
    expect(suggestPhoneGroups(history, ["phone:a", "phone:b", "phone:c"])).toEqual([]);
  });

  it("returns nothing with fewer than two candidates", () => {
    expect(suggestPhoneGroups({ "phone:a": wave(40, 0) }, ["phone:a"])).toEqual([]);
  });
});
