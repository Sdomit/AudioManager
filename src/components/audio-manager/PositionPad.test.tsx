// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { PositionPad } from "./PositionPad";

afterEach(cleanup);

describe("PositionPad", () => {
  it("renders a slider with a position-describing label", () => {
    render(<PositionPad azimuthDeg={0} distance={0} onChange={() => {}} />);
    const pad = screen.getByRole("slider");
    expect(pad.getAttribute("aria-valuetext")).toContain("centre");
  });

  it("describes a placed source by angle + side", () => {
    render(<PositionPad azimuthDeg={90} distance={0.5} onChange={() => {}} />);
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toContain(
      "90° right",
    );
  });

  it("Arrow keys nudge azimuth and distance", () => {
    const onChange = vi.fn();
    render(<PositionPad azimuthDeg={0} distance={0.5} onChange={onChange} />);
    const pad = screen.getByRole("slider");

    fireEvent.keyDown(pad, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(5, 0.5);

    fireEvent.keyDown(pad, { key: "ArrowUp" });
    // distance += 0.05 (float-safe check)
    const [, d] = onChange.mock.calls[onChange.mock.calls.length - 1];
    expect(d).toBeCloseTo(0.55, 5);
  });

  it("Home recenters to front", () => {
    const onChange = vi.fn();
    render(<PositionPad azimuthDeg={120} distance={0.8} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("slider"), { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith(0, 0);
  });

  it("clamps distance at the rim and wraps azimuth", () => {
    const onChange = vi.fn();
    render(<PositionPad azimuthDeg={178} distance={1} onChange={onChange} />);
    const pad = screen.getByRole("slider");
    fireEvent.keyDown(pad, { key: "ArrowUp" }); // distance 1 → stays 1
    expect(onChange).toHaveBeenLastCalledWith(178, 1);
    fireEvent.keyDown(pad, { key: "ArrowRight" }); // 178 + 5 → wraps to -177
    expect(onChange).toHaveBeenLastCalledWith(-177, 1);
  });
});
