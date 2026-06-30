// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AmvcHealthStatus, AmvcQueryResult, BusStatus } from "../../types/engine";
import type { BusId } from "./types";

vi.mock("../../utils/amvc", () => ({
  queryAmvcHelper: vi.fn(),
  launchAmvcInstaller: vi.fn(),
  applyAmvcRoutingPreset: vi.fn(),
}));

vi.mock("../../ipc/commands", () => ({
  listBuses: vi.fn(),
}));

vi.mock("../../ipc/events", () => ({
  onDevicesChanged: vi.fn(() => Promise.resolve(() => {})),
}));

const { queryAmvcHelper, launchAmvcInstaller, applyAmvcRoutingPreset } =
  await import("../../utils/amvc");
const { listBuses } = await import("../../ipc/commands");
const { CablePanel } = await import("./CablePanel");

const qMock = vi.mocked(queryAmvcHelper);
const iMock = vi.mocked(launchAmvcInstaller);
const pMock = vi.mocked(applyAmvcRoutingPreset);
const bMock = vi.mocked(listBuses);

function bus(id: BusId, device: string | null): BusStatus {
  return {
    id,
    name: id,
    output_device: device,
    volume: 1,
    muted: false,
    enabled: true,
    running: false,
    output_peak: 0,
    clipped_recently: false,
    last_error: null,
  };
}

const ALL = [
  "AudioManager Cable 1 Playback",
  "AudioManager Cable 1 Recording",
  "AudioManager Cable 2 Playback",
  "AudioManager Cable 2 Recording",
  "AudioManager Stream Output",
  "AudioManager Voice Output",
];

function ok(status: AmvcHealthStatus, detected: string[]): AmvcQueryResult {
  return {
    kind: "ok",
    status,
    found: detected.length,
    expected: 6,
    driver_in_store: status !== "not-installed",
    reboot_pending: status === "needs-reboot",
    names_aligned: false,
    detected,
    missing: ALL.filter((n) => !detected.includes(n)),
  };
}

beforeEach(() => {
  qMock.mockReset();
  iMock.mockReset();
  pMock.mockReset();
  bMock.mockReset();
  iMock.mockResolvedValue(undefined);
  pMock.mockResolvedValue({
    b1Applied: true,
    b2Applied: true,
    b1DeviceId: "AudioManager Stream Output",
    b2DeviceId: "AudioManager Voice Output",
  });
  bMock.mockResolvedValue([]);
});
afterEach(cleanup);

describe("CablePanel", () => {
  it("does not query while closed", () => {
    qMock.mockResolvedValue(ok("installed-healthy", ALL));
    render(<CablePanel open={false} />);
    expect(qMock).not.toHaveBeenCalled();
  });

  it("healthy → Connected, no install button", async () => {
    qMock.mockResolvedValue(ok("installed-healthy", ALL));
    render(<CablePanel open />);
    await screen.findByText(/Connected/);
    expect(screen.queryByText("Install")).toBeNull();
    expect(screen.queryByText("Repair")).toBeNull();
    expect(screen.getByText("Re-check")).toBeTruthy();
  });

  it("not-installed → Install button, launches installer", async () => {
    qMock.mockResolvedValue(ok("not-installed", []));
    render(<CablePanel open />);
    const btn = await screen.findByText("Install");
    fireEvent.click(btn);
    await waitFor(() => expect(iMock).toHaveBeenCalledTimes(1));
  });

  it("needs-repair → Repair button and partial count", async () => {
    qMock.mockResolvedValue(
      ok("needs-repair", ["AudioManager Cable 1 Playback", "AudioManager Cable 1 Recording"]),
    );
    render(<CablePanel open />);
    await screen.findByText("Repair");
    expect(screen.getByText(/2 of 6/)).toBeTruthy();
  });

  it("needs-reboot → Reboot required, no install button", async () => {
    qMock.mockResolvedValue(ok("needs-reboot", ALL));
    render(<CablePanel open />);
    await screen.findByText(/Reboot required/);
    expect(screen.queryByText("Install")).toBeNull();
    expect(screen.queryByText("Repair")).toBeNull();
  });

  it("unavailable → Optional add-on", async () => {
    qMock.mockResolvedValue({ kind: "unavailable", reason: "not found" });
    render(<CablePanel open />);
    await screen.findByText(/Optional add-on/);
    expect(iMock).not.toHaveBeenCalled();
  });

  it("Re-check re-queries the helper", async () => {
    qMock.mockResolvedValue(ok("installed-healthy", ALL));
    render(<CablePanel open />);
    await screen.findByText(/Connected/);
    expect(qMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Re-check"));
    await waitFor(() => expect(qMock).toHaveBeenCalledTimes(2));
  });

  // ── Phase 11C: multi-cable assignment map ───────────────────────────────

  it("healthy → Auto-route buses applies the routing preset", async () => {
    qMock.mockResolvedValue(ok("installed-healthy", ALL));
    render(<CablePanel open />);
    const btn = await screen.findByText("Auto-route buses");
    fireEvent.click(btn);
    await waitFor(() => expect(pMock).toHaveBeenCalledTimes(1));
    // Assignments re-pulled after applying (once on open, once after).
    await waitFor(() => expect(bMock).toHaveBeenCalledTimes(2));
  });

  it("not-installed → no Auto-route button", async () => {
    qMock.mockResolvedValue(ok("not-installed", []));
    render(<CablePanel open />);
    await screen.findByText("Install");
    expect(screen.queryByText("Auto-route buses")).toBeNull();
  });

  it("shows which bus is bound to each endpoint", async () => {
    qMock.mockResolvedValue(ok("installed-healthy", ALL));
    bMock.mockResolvedValue([
      bus("B1", "AudioManager Stream Output"),
      bus("B2", "AudioManager Voice Output"),
      bus("A1", "Speakers (Realtek)"),
    ]);
    render(<CablePanel open />);
    await screen.findByText("B1");
    expect(screen.getByText("B2")).toBeTruthy();
    // Non-AMVC assignment gets no tag.
    expect(screen.queryByText("A1")).toBeNull();
    expect(screen.queryByText(/share/)).toBeNull();
  });

  it("flags two buses sharing one endpoint", async () => {
    qMock.mockResolvedValue(ok("installed-healthy", ALL));
    bMock.mockResolvedValue([
      bus("B1", "AudioManager Stream Output"),
      bus("B2", "AudioManager Stream Output"),
    ]);
    render(<CablePanel open />);
    await screen.findByText("B1 + B2");
    expect(screen.getByText(/B1 and B2 share Stream Output/)).toBeTruthy();
  });
});
