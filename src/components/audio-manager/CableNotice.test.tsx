// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AmvcHealthStatus, AmvcQueryResult } from "../../types/engine";

vi.mock("../../utils/amvc", () => ({
  queryAmvcHelper: vi.fn(),
  launchAmvcInstaller: vi.fn(),
}));

const { queryAmvcHelper, launchAmvcInstaller } = await import("../../utils/amvc");
const { CableNotice } = await import("./CableNotice");

const qMock = vi.mocked(queryAmvcHelper);
const iMock = vi.mocked(launchAmvcInstaller);

function ok(status: AmvcHealthStatus): AmvcQueryResult {
  return {
    kind: "ok",
    status,
    found: 0,
    expected: 6,
    driver_in_store: false,
    reboot_pending: false,
    detected: [],
    missing: [],
  };
}

beforeEach(() => {
  qMock.mockReset();
  iMock.mockReset();
  iMock.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("CableNotice", () => {
  it("launches the installer for not-installed and holds in Installing…", async () => {
    qMock.mockResolvedValue(ok("not-installed"));
    render(<CableNotice onDismiss={() => {}} onRecheck={() => {}} />);

    fireEvent.click(screen.getByText("Install / Repair"));

    await screen.findByText("Installing…");
    expect(iMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Re-check")).toBeTruthy();
    expect((screen.getByText("Installing…") as HTMLButtonElement).disabled).toBe(true);
  });

  it("does NOT spawn a second installer on a same-tick double-click", async () => {
    qMock.mockResolvedValue(ok("not-installed"));
    render(<CableNotice onDismiss={() => {}} onRecheck={() => {}} />);

    const btn = screen.getByText("Install / Repair");
    fireEvent.click(btn);
    fireEvent.click(btn); // second click in the same tick — must be ignored

    await screen.findByText("Installing…");
    expect(qMock).toHaveBeenCalledTimes(1);
    expect(iMock).toHaveBeenCalledTimes(1);
  });

  it("shows Reboot required and never launches the installer", async () => {
    qMock.mockResolvedValue(ok("needs-reboot"));
    render(<CableNotice onDismiss={() => {}} onRecheck={() => {}} />);

    fireEvent.click(screen.getByText("Install / Repair"));

    await screen.findByText("Reboot required");
    expect(iMock).not.toHaveBeenCalled();
    expect((screen.getByText("Reboot required") as HTMLButtonElement).disabled).toBe(true);
  });

  it("on installed-healthy re-checks devices instead of installing", async () => {
    qMock.mockResolvedValue(ok("installed-healthy"));
    const onRecheck = vi.fn();
    render(<CableNotice onDismiss={() => {}} onRecheck={onRecheck} />);

    fireEvent.click(screen.getByText("Install / Repair"));

    await waitFor(() => expect(onRecheck).toHaveBeenCalledTimes(1));
    expect(iMock).not.toHaveBeenCalled();
    // Returns to the actionable state (button enabled again).
    expect((screen.getByText("Install / Repair") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows Helper not found when the helper is unavailable", async () => {
    qMock.mockResolvedValue({ kind: "unavailable", reason: "not found" });
    render(<CableNotice onDismiss={() => {}} onRecheck={() => {}} />);

    fireEvent.click(screen.getByText("Install / Repair"));

    await screen.findByText("Helper not found");
    expect(iMock).not.toHaveBeenCalled();
  });

  it("Re-check button triggers onRecheck after install launches", async () => {
    qMock.mockResolvedValue(ok("not-installed"));
    const onRecheck = vi.fn();
    render(<CableNotice onDismiss={() => {}} onRecheck={onRecheck} />);

    fireEvent.click(screen.getByText("Install / Repair"));
    const recheck = await screen.findByText("Re-check");
    fireEvent.click(recheck);

    expect(onRecheck).toHaveBeenCalledTimes(1);
  });
});
