// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { onDeviceChange } from "./capture";

describe("onDeviceChange", () => {
  afterEach(() => {
    delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  });

  it("registers and unregisters a devicechange listener", () => {
    const add = vi.fn();
    const remove = vi.fn();
    (navigator as { mediaDevices?: unknown }).mediaDevices = {
      addEventListener: add,
      removeEventListener: remove,
    };
    const handler = () => {};
    const off = onDeviceChange(handler);
    expect(add).toHaveBeenCalledWith("devicechange", handler);
    off();
    expect(remove).toHaveBeenCalledWith("devicechange", handler);
  });

  it("is a safe no-op when mediaDevices is unavailable", () => {
    delete (navigator as { mediaDevices?: unknown }).mediaDevices;
    expect(() => onDeviceChange(() => {})()).not.toThrow();
  });
});
