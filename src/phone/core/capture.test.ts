// @vitest-environment jsdom
//
// This suite touches the `navigator` global. vitest's default `node`
// environment only exposes `navigator` on Node 21+, so on the CI-pinned Node 20
// these tests threw `ReferenceError: navigator is not defined`. jsdom provides a
// `navigator` regardless of Node version, making the suite node-version-stable.
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
