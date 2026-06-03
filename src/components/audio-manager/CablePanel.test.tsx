// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AmvcHealthStatus, AmvcQueryResult } from "../../types/engine";

vi.mock("../../utils/amvc", () => ({
  queryAmvcHelper: vi.fn(),
  launchAmvcInstaller: vi.fn(),
}));

const { queryAmvcHelper, launchAmvcInstaller } = await import("../../utils/amvc");
const { CablePanel } = await import("./CablePanel");

const qMock = vi.mocked(queryAmvcHelper);
const iMock = vi.mocked(launchAmvcInstaller);

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
    detected,
    missing: ALL.filter((n) => !detected.includes(n)),
  };
}

beforeEach(() => {
  qMock.mockReset();
  iMock.mockReset();
  iMock.mockResolvedValue(undefined);
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

  it("unavailable → Helper not found", async () => {
    qMock.mockResolvedValue({ kind: "unavailable", reason: "not found" });
    render(<CablePanel open />);
    await screen.findByText(/Helper not found/);
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
});
