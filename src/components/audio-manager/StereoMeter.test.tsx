// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { StereoMeter } from "./StereoMeter";

afterEach(cleanup);

describe("StereoMeter", () => {
  it("renders a single bar for a mono source", () => {
    const { container } = render(
      <StereoMeter levelL={0.5} levelR={0.5} channels={1} />,
    );
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
  });

  it("renders two bars for a stereo source", () => {
    const { container } = render(
      <StereoMeter levelL={0.4} levelR={0.8} channels={2} />,
    );
    expect(container.querySelectorAll("canvas")).toHaveLength(2);
  });

  it("treats an unknown channel count as stereo", () => {
    const { container } = render(<StereoMeter level={0.3} />);
    expect(container.querySelectorAll("canvas")).toHaveLength(2);
  });
});
