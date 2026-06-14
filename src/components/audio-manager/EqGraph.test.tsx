// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { BusEqControls } from "./DspControls";
import { defaultEq } from "./dspDefaults";
import type { BandKind, EqConfig } from "../../types/engine";

afterEach(cleanup);

function eq(kind: BandKind, ...enabledBands: number[]): EqConfig {
  const c = defaultEq();
  c.enabled = true;
  c.bands = c.bands.map((b, i) => ({
    ...b,
    kind,
    enabled: enabledBands.includes(i),
  }));
  return c;
}

describe("BusEqControls / EqEditor / EqGraph", () => {
  it("renders one draggable node per enabled band", () => {
    const { container } = render(
      <BusEqControls eq={eq("peaking", 0, 2)} onChange={() => {}} />,
    );
    expect(container.querySelector("svg")).toBeTruthy();
    // The only <circle> elements are band nodes (grid = lines, curve = polyline).
    expect(container.querySelectorAll("circle").length).toBe(2);
  });

  it("changing a band's type emits the new kind", () => {
    const onChange = vi.fn();
    render(<BusEqControls eq={eq("peaking", 0)} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Band 1 type"), {
      target: { value: "low_pass" },
    });

    expect(onChange).toHaveBeenCalled();
    const c1 = onChange.mock.calls;
    const next: EqConfig = c1[c1.length - 1][0];
    expect(next.bands[0].kind).toBe("low_pass");
  });

  it("toggling a band emits enabled, preserving other bands", () => {
    const onChange = vi.fn();
    render(<BusEqControls eq={eq("peaking")} onChange={onChange} />);

    fireEvent.click(screen.getByLabelText("Band 2 off"));

    const c2 = onChange.mock.calls;
    const next: EqConfig = c2[c2.length - 1][0];
    expect(next.bands[1].enabled).toBe(true);
    expect(next.bands[0].enabled).toBe(false);
  });

  it("cut shapes hide Gain and show Q", () => {
    render(<BusEqControls eq={eq("low_pass", 0)} onChange={() => {}} />);
    expect(screen.queryByText("Gain")).toBeNull();
    expect(screen.getAllByText("Q").length).toBeGreaterThan(0);
  });

  it("shelf shapes show Gain and hide Q", () => {
    render(<BusEqControls eq={eq("low_shelf", 0)} onChange={() => {}} />);
    expect(screen.getAllByText("Gain").length).toBeGreaterThan(0);
    expect(screen.queryByText("Q")).toBeNull();
  });

  it("hides the editor entirely until EQ is enabled", () => {
    const off = { ...defaultEq(), enabled: false };
    const { container } = render(
      <BusEqControls eq={off} onChange={() => {}} />,
    );
    expect(container.querySelector("svg")).toBeNull();
  });
});
