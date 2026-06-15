// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { BusLimiterControls, InputDspControls } from "./DspControls";
import {
  b1ProtectLimiter,
  defaultDspConfig,
  defaultLimiter,
  streamVoiceConfig,
} from "./dspDefaults";

afterEach(cleanup);

describe("InputDspControls", () => {
  it("renders every effect in the chain", () => {
    render(<InputDspControls dsp={defaultDspConfig()} onChange={() => {}} />);
    for (const title of [
      "Noise suppression (AI)",
      "High-pass",
      "Noise gate",
      "EQ",
      "Compressor",
      "Limiter",
    ]) {
      expect(screen.getByText(title)).toBeTruthy();
    }
  });

  it("toggling the AI denoiser emits denoise.enabled, preserving the chain", () => {
    const onChange = vi.fn();
    render(<InputDspControls dsp={defaultDspConfig()} onChange={onChange} />);

    fireEvent.click(screen.getByLabelText("Noise suppression (AI) off"));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next.denoise.enabled).toBe(true);
    expect(next.denoise.backend).toBe("rnnoise");
    // Untouched effects preserved.
    expect(next.hpf.enabled).toBe(false);
    expect(next.limiter.threshold_db).toBe(-1);
  });

  it("toggling an effect emits the full config with that effect enabled", () => {
    const onChange = vi.fn();
    render(<InputDspControls dsp={defaultDspConfig()} onChange={onChange} />);

    fireEvent.click(screen.getByLabelText("High-pass off"));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next.hpf.enabled).toBe(true);
    // Untouched effects are preserved.
    expect(next.gate.enabled).toBe(false);
    expect(next.compressor.ratio).toBe(4);
  });

  it("hides params until the effect is enabled, shows them once on", () => {
    const dsp = defaultDspConfig();
    const { rerender } = render(
      <InputDspControls dsp={dsp} onChange={() => {}} />,
    );
    // Gate off → its Threshold slider is not rendered.
    expect(screen.queryByText("Threshold")).toBeNull();

    rerender(
      <InputDspControls
        dsp={{ ...dsp, gate: { ...dsp.gate, enabled: true } }}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText("Threshold")).toBeTruthy();
  });

  it("editing a slider emits the changed value", () => {
    const onChange = vi.fn();
    const dsp = { ...defaultDspConfig(), hpf: { enabled: true, freq_hz: 80 } };
    render(<InputDspControls dsp={dsp} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Freq"), { target: { value: "120" } });

    expect(onChange).toHaveBeenCalled();
    const calls = onChange.mock.calls;
    const next = calls[calls.length - 1][0];
    expect(next.hpf.freq_hz).toBe(120);
  });

  it("renders the always-visible Stereo section with pan + toggles", () => {
    render(<InputDspControls dsp={defaultDspConfig()} onChange={() => {}} />);
    expect(screen.getByText("Stereo")).toBeTruthy();
    expect(screen.getByText("Pan")).toBeTruthy();
    expect(screen.getByText("Mono")).toBeTruthy();
    expect(screen.getByText("Swap L/R")).toBeTruthy();
  });

  it("editing pan emits stereo.pan, preserving the chain", () => {
    const onChange = vi.fn();
    render(<InputDspControls dsp={defaultDspConfig()} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Pan"), { target: { value: "1" } });

    const calls = onChange.mock.calls;
    const next = calls[calls.length - 1][0];
    expect(next.stereo.pan).toBe(1);
    expect(next.limiter.threshold_db).toBe(-1);
  });

  it("Mono toggle flips stereo.mono", () => {
    const onChange = vi.fn();
    render(<InputDspControls dsp={defaultDspConfig()} onChange={onChange} />);

    fireEvent.click(screen.getByText("Mono"));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].stereo.mono).toBe(true);
  });

  it("shows the Stream Voice + Reset preset row only when onStreamVoice is given", () => {
    const { rerender } = render(
      <InputDspControls dsp={defaultDspConfig()} onChange={() => {}} />,
    );
    expect(screen.queryByText("Stream Voice")).toBeNull();

    rerender(
      <InputDspControls
        dsp={defaultDspConfig()}
        onChange={() => {}}
        onStreamVoice={() => {}}
      />,
    );
    expect(screen.getByText("Stream Voice")).toBeTruthy();
    expect(
      screen.getByTitle("Reset all stages to defaults (bypassed)"),
    ).toBeTruthy();
  });

  it("Stream Voice button calls onStreamVoice; Reset emits the default config", () => {
    const onStreamVoice = vi.fn();
    const onChange = vi.fn();
    render(
      <InputDspControls
        dsp={streamVoiceConfig()}
        onChange={onChange}
        onStreamVoice={onStreamVoice}
      />,
    );

    fireEvent.click(screen.getByText("Stream Voice"));
    expect(onStreamVoice).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTitle("Reset all stages to defaults (bypassed)"));
    expect(onChange).toHaveBeenCalledWith(defaultDspConfig());
  });
});

describe("FxOrderStrip (#feature5 reorder)", () => {
  const twoEnabled = () => {
    const d = defaultDspConfig();
    return {
      ...d,
      hpf: { ...d.hpf, enabled: true },
      gate: { ...d.gate, enabled: true },
    };
  };

  it("is hidden when fewer than two effects are enabled", () => {
    render(<InputDspControls dsp={defaultDspConfig()} onChange={() => {}} />);
    expect(screen.queryByRole("list", { name: /Effect order/i })).toBeNull();
  });

  it("lists enabled effects in wired order", () => {
    render(<InputDspControls dsp={twoEnabled()} onChange={() => {}} />);
    const strip = screen.getByRole("list", { name: /Effect order/i });
    const chips = within(strip).getAllByRole("listitem");
    expect(chips).toHaveLength(2);
    // Default order is denoise→hpf→gate→…, so High-pass precedes Gate.
    expect(chips[0].textContent).toContain("High-pass");
    expect(chips[1].textContent).toContain("Gate");
  });

  it("Alt+ArrowRight reorders without dropping disabled stages", () => {
    const onChange = vi.fn();
    render(<InputDspControls dsp={twoEnabled()} onChange={onChange} />);
    const chips = within(
      screen.getByRole("list", { name: /Effect order/i }),
    ).getAllByRole("listitem");

    fireEvent.keyDown(chips[0], { key: "ArrowRight", altKey: true });

    expect(onChange).toHaveBeenCalled();
    const calls = onChange.mock.calls;
    const next = calls[calls.length - 1][0];
    const order = next.order as string[];
    // hpf now sits after gate…
    expect(order.indexOf("gate")).toBeLessThan(order.indexOf("hpf"));
    // …and every stage is still present (no stages dropped from the chain).
    expect([...order].sort()).toEqual(
      ["comp", "denoise", "eq", "gate", "hpf", "limiter"].sort(),
    );
  });
});

describe("streamVoiceConfig / b1ProtectLimiter (#33 locked spec)", () => {
  it("Stream Voice enables HP→gate→EQ→comp, leaves the input limiter off", () => {
    const c = streamVoiceConfig();
    expect(c.hpf.enabled).toBe(true);
    expect(c.hpf.freq_hz).toBe(80);
    expect(c.gate.enabled).toBe(true);
    expect(c.eq.enabled).toBe(true);
    expect(c.eq.bands.filter((b) => b.enabled).length).toBe(3);
    expect(c.compressor.enabled).toBe(true);
    expect(c.compressor.makeup_db).toBe(4);
    // The per-input limiter stays off — final protection lives on the B1 bus.
    expect(c.limiter.enabled).toBe(false);
  });

  it("B1 protection limiter is a -1 dBFS brick wall", () => {
    const lim = b1ProtectLimiter();
    expect(lim.enabled).toBe(true);
    expect(lim.threshold_db).toBe(-1);
  });
});

describe("BusLimiterControls", () => {
  it("toggles the limiter on", () => {
    const onChange = vi.fn();
    render(<BusLimiterControls limiter={defaultLimiter()} onChange={onChange} />);

    fireEvent.click(screen.getByLabelText("Limiter off"));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].enabled).toBe(true);
  });

  it("shows ceiling/attack/release only when enabled", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <BusLimiterControls limiter={defaultLimiter()} onChange={onChange} />,
    );
    expect(screen.queryByText("Ceiling")).toBeNull();

    rerender(
      <BusLimiterControls
        limiter={{ ...defaultLimiter(), enabled: true }}
        onChange={onChange}
      />,
    );
    expect(screen.getByText("Ceiling")).toBeTruthy();
    expect(screen.getByText("Release")).toBeTruthy();
  });
});
