import { describe, it, expect } from "vitest";

import { defaultDspConfig } from "./dspDefaults";
import { orderedInputFx, reorderInputFx, setInputFxEnabled } from "./NodeFxPopover";

describe("input fx chain ordering", () => {
  it("orderedInputFx respects dsp.order and drops disabled stages", () => {
    let dsp = defaultDspConfig();
    dsp = setInputFxEnabled(dsp, "denoise", true);
    dsp = setInputFxEnabled(dsp, "limiter", true);
    // Canonical order → denoise before limiter; gate/hpf/etc disabled → absent.
    expect(orderedInputFx(dsp).map((f) => f.key)).toEqual(["denoise", "limiter"]);
  });

  it("reorderInputFx moves a stage immediately before the target", () => {
    let dsp = defaultDspConfig();
    dsp = setInputFxEnabled(dsp, "denoise", true);
    dsp = setInputFxEnabled(dsp, "limiter", true);
    dsp = reorderInputFx(dsp, "limiter", "denoise");
    expect(orderedInputFx(dsp).map((f) => f.key)).toEqual(["limiter", "denoise"]);
    // Full order stays a 6-permutation (engine relies on it).
    expect([...dsp.order].sort()).toEqual(
      ["comp", "denoise", "eq", "gate", "hpf", "limiter"],
    );
  });

  it("reorderInputFx is a no-op when from === before", () => {
    const dsp = defaultDspConfig();
    expect(reorderInputFx(dsp, "eq", "eq")).toBe(dsp);
  });

  it("reorder keeps every stage exactly once (no loss/dupe)", () => {
    let dsp = defaultDspConfig();
    dsp = reorderInputFx(dsp, "comp", "hpf");
    dsp = reorderInputFx(dsp, "denoise", "limiter");
    expect(dsp.order.length).toBe(6);
    expect(new Set(dsp.order).size).toBe(6);
  });
});
