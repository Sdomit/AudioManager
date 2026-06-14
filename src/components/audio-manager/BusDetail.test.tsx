// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { BusDetail } from "./BusDetail";
import { defaultEq, defaultLimiter } from "./dspDefaults";
import type { Bus, BusId, BusRole } from "./types";

afterEach(cleanup);

function makeBus(overrides: Partial<Bus> = {}): Bus {
  return {
    id: "B1" as BusId,
    role: "stream" as BusRole,
    label: "B1 Stream",
    device: "Speakers",
    state: "running",
    enabled: true,
    muted: false,
    volume: 0.75,
    level: 0.2,
    clipUntil: null,
    error: null,
    bufferSizeFrames: null,
    underruns: 0,
    overruns: 0,
    eq: defaultEq(),
    limiter: defaultLimiter(),
    loudness: null,
    ...overrides,
  };
}

const noopHandlers = {
  routedInputs: [],
  activeRecordings: [],
  onVolumeChange: () => {},
  onToggleEnabled: () => {},
  onToggleMuted: () => {},
  onPickDevice: () => {},
  onSelectInput: () => {},
  onBufferSizeChange: () => {},
  onEqChange: () => {},
  onStartRecording: () => {},
  onStopRecording: () => {},
};

describe("BusDetail B1 protection (#33)", () => {
  it("shows Unprotected + a Protect button when B1's limiter is off", () => {
    render(
      <BusDetail
        bus={makeBus({ limiter: { ...defaultLimiter(), enabled: false } })}
        onLimiterChange={() => {}}
        {...noopHandlers}
      />,
    );
    expect(screen.getByText("Unprotected")).toBeTruthy();
    expect(screen.getByText("Protect")).toBeTruthy();
  });

  it("shows Protected once the limiter is armed", () => {
    render(
      <BusDetail
        bus={makeBus({
          limiter: { ...defaultLimiter(), enabled: true, threshold_db: -1 },
        })}
        onLimiterChange={() => {}}
        {...noopHandlers}
      />,
    );
    expect(screen.getByText("Protected")).toBeTruthy();
    expect(screen.getByText("Protected (-1 dB)")).toBeTruthy();
  });

  it("Protect arms the limiter at -1 dBFS", () => {
    const onLimiterChange = vi.fn();
    render(
      <BusDetail
        bus={makeBus({ limiter: { ...defaultLimiter(), enabled: false } })}
        onLimiterChange={onLimiterChange}
        {...noopHandlers}
      />,
    );
    fireEvent.click(screen.getByText("Protect"));
    const next = onLimiterChange.mock.calls[0][0];
    expect(next.enabled).toBe(true);
    expect(next.threshold_db).toBe(-1);
  });

  it("disarms when already protected", () => {
    const onLimiterChange = vi.fn();
    render(
      <BusDetail
        bus={makeBus({ limiter: { ...defaultLimiter(), enabled: true } })}
        onLimiterChange={onLimiterChange}
        {...noopHandlers}
      />,
    );
    fireEvent.click(screen.getByText("Protected (-1 dB)"));
    expect(onLimiterChange.mock.calls[0][0].enabled).toBe(false);
  });

  it("does not render protection UI for non-B1 buses", () => {
    render(
      <BusDetail
        bus={makeBus({ id: "A1" as BusId, role: "monitor" as BusRole, label: "A1" })}
        onLimiterChange={() => {}}
        {...noopHandlers}
      />,
    );
    expect(screen.queryByText("Protect")).toBeNull();
    expect(screen.queryByText("Unprotected")).toBeNull();
    expect(screen.queryByText("Protected")).toBeNull();
  });
});
