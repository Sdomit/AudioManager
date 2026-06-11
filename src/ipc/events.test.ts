// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const listenMock = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

// Imported after vi.mock so the mocked event module is in place.
import { DEVICES_CHANGED_EVENT, onDevicesChanged } from "./events";
import type { DeviceDiff } from "../types/engine";

afterEach(() => {
  listenMock.mockReset();
});

describe("onDevicesChanged", () => {
  it("subscribes to the devices-changed event and unwraps the payload", async () => {
    const unlisten = vi.fn();
    let captured: ((event: { payload: DeviceDiff }) => void) | null = null;
    listenMock.mockImplementation(
      (event: string, cb: (event: { payload: DeviceDiff }) => void) => {
        expect(event).toBe(DEVICES_CHANGED_EVENT);
        captured = cb;
        return Promise.resolve(unlisten);
      },
    );

    const handler = vi.fn();
    const un = await onDevicesChanged(handler);

    const diff: DeviceDiff = {
      added_inputs: ["mic"],
      removed_inputs: [],
      added_outputs: [],
      removed_outputs: ["cable"],
    };
    captured!({ payload: diff });
    expect(handler).toHaveBeenCalledWith(diff);

    un();
    expect(unlisten).toHaveBeenCalled();
  });

  it("resolves to a no-op outside a Tauri webview instead of rejecting", async () => {
    listenMock.mockRejectedValue(new Error("no __TAURI_INTERNALS__"));
    const un = await onDevicesChanged(() => {});
    expect(typeof un).toBe("function");
    expect(() => un()).not.toThrow();
  });
});
