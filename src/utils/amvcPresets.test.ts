import { describe, expect, it } from "vitest";
import type { DeviceInfo } from "../types/engine";
import {
  AMVC_ALL_DEVICE_NAMES,
  AMVC_CAPTURE_DEVICE_NAMES,
  AMVC_STREAM_OUTPUT,
  AMVC_VOICE_OUTPUT,
  compareDevicesForPicker,
  findAmvcCaptureDevices,
  hasAnyAmvcDevice,
  suggestAmvcBusDevice,
  suggestAppCaptureInput,
} from "./amvcPresets";

function dev(name: string, over: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: over.id ?? name,
    name,
    default_sample_rate: over.default_sample_rate ?? 48000,
    channels: over.channels ?? 2,
    is_default: over.is_default ?? false,
  };
}

describe("AMVC_ALL_DEVICE_NAMES", () => {
  it("contains exactly the 6 canonical endpoints", () => {
    expect(AMVC_ALL_DEVICE_NAMES).toHaveLength(6);
    expect(AMVC_ALL_DEVICE_NAMES).toContain("AudioManager Cable 1 Playback");
    expect(AMVC_ALL_DEVICE_NAMES).toContain("AudioManager Cable 1 Recording");
    expect(AMVC_ALL_DEVICE_NAMES).toContain("AudioManager Cable 2 Playback");
    expect(AMVC_ALL_DEVICE_NAMES).toContain("AudioManager Cable 2 Recording");
    expect(AMVC_ALL_DEVICE_NAMES).toContain(AMVC_STREAM_OUTPUT);
    expect(AMVC_ALL_DEVICE_NAMES).toContain(AMVC_VOICE_OUTPUT);
  });
});

describe("suggestAmvcBusDevice", () => {
  const outputs = [
    dev("Speakers (Realtek)", { is_default: true }),
    dev(AMVC_STREAM_OUTPUT),
    dev(AMVC_VOICE_OUTPUT),
  ];

  it("B1 → Stream Output", () => {
    expect(suggestAmvcBusDevice("B1", outputs)).toBe(AMVC_STREAM_OUTPUT);
  });

  it("B2 → Voice Output", () => {
    expect(suggestAmvcBusDevice("B2", outputs)).toBe(AMVC_VOICE_OUTPUT);
  });

  it("A1/A2 have no suggestion", () => {
    expect(suggestAmvcBusDevice("A1", outputs)).toBeNull();
    expect(suggestAmvcBusDevice("A2", outputs)).toBeNull();
  });

  it("returns null when target device is absent", () => {
    expect(suggestAmvcBusDevice("B1", [dev("Speakers (Realtek)")])).toBeNull();
  });

  it("matches case-insensitively and returns the device id", () => {
    const lower = [dev("audiomanager stream output", { id: "{guid-1}" })];
    expect(suggestAmvcBusDevice("B1", lower)).toBe("{guid-1}");
  });

  it("returns null for empty device list", () => {
    expect(suggestAmvcBusDevice("B1", [])).toBeNull();
  });
});

describe("findAmvcCaptureDevices", () => {
  it("returns only AudioManager Recording endpoints", () => {
    const inputs = [
      dev("Microphone (Realtek)"),
      dev("AudioManager Cable 1 Recording"),
      dev("AudioManager Cable 2 Recording"),
      dev("AudioManager Cable 1 Playback"),
      dev("CABLE Output (VB-Audio Virtual Cable)"),
    ];
    const found = findAmvcCaptureDevices(inputs);
    expect(found.map((d) => d.name)).toEqual([
      "AudioManager Cable 1 Recording",
      "AudioManager Cable 2 Recording",
    ]);
  });

  it("excludes Playback (render) endpoints", () => {
    const inputs = [dev("AudioManager Cable 1 Playback")];
    expect(findAmvcCaptureDevices(inputs)).toHaveLength(0);
  });

  it("returns empty for no AudioManager devices", () => {
    expect(findAmvcCaptureDevices([dev("Microphone")])).toHaveLength(0);
  });
});

describe("AMVC_CAPTURE_DEVICE_NAMES", () => {
  it("is the two Cable Recording endpoints in canonical order", () => {
    expect(AMVC_CAPTURE_DEVICE_NAMES).toEqual([
      "AudioManager Cable 1 Recording",
      "AudioManager Cable 2 Recording",
    ]);
  });
});

describe("suggestAppCaptureInput", () => {
  it("returns Cable 1 Recording when present", () => {
    const inputs = [
      dev("Microphone (Realtek)", { is_default: true }),
      dev("AudioManager Cable 2 Recording", { id: "c2" }),
      dev("AudioManager Cable 1 Recording", { id: "c1" }),
    ];
    expect(suggestAppCaptureInput(inputs)).toBe("c1");
  });

  it("falls back to Cable 2 when Cable 1 is absent", () => {
    const inputs = [dev("AudioManager Cable 2 Recording", { id: "c2" })];
    expect(suggestAppCaptureInput(inputs)).toBe("c2");
  });

  it("ignores Playback (render) endpoints", () => {
    const inputs = [dev("AudioManager Cable 1 Playback", { id: "p1" })];
    expect(suggestAppCaptureInput(inputs)).toBeNull();
  });

  it("returns null when no AudioManager capture device exists", () => {
    expect(suggestAppCaptureInput([dev("Microphone")])).toBeNull();
    expect(suggestAppCaptureInput([])).toBeNull();
  });

  it("returns the device id (not the name)", () => {
    const inputs = [dev("AudioManager Cable 1 Recording", { id: "{guid-cap-1}" })];
    expect(suggestAppCaptureInput(inputs)).toBe("{guid-cap-1}");
  });
});

describe("hasAnyAmvcDevice", () => {
  it("true when an AudioManager device is in outputs", () => {
    expect(hasAnyAmvcDevice([dev(AMVC_STREAM_OUTPUT)], [])).toBe(true);
  });

  it("true when an AudioManager device is in inputs", () => {
    expect(hasAnyAmvcDevice([], [dev("AudioManager Cable 1 Recording")])).toBe(true);
  });

  it("false when only third-party / physical devices present", () => {
    expect(
      hasAnyAmvcDevice([dev("Speakers"), dev("CABLE Input")], [dev("Microphone")]),
    ).toBe(false);
  });

  it("false for two empty lists", () => {
    expect(hasAnyAmvcDevice([], [])).toBe(false);
  });
});

describe("compareDevicesForPicker", () => {
  it("AudioManager devices sort before everything else", () => {
    const list = [
      dev("Speakers (Realtek)", { is_default: true }),
      dev("ZZZ Virtual"),
      dev(AMVC_VOICE_OUTPUT),
      dev(AMVC_STREAM_OUTPUT),
    ];
    const sorted = [...list].sort(compareDevicesForPicker);
    expect(sorted[0].name).toBe(AMVC_STREAM_OUTPUT);
    expect(sorted[1].name).toBe(AMVC_VOICE_OUTPUT);
  });

  it("within non-AMVC tier, default sorts before alpha", () => {
    const list = [
      dev("ZZZ Device"),
      dev("AAA Device"),
      dev("Default Speakers", { is_default: true }),
    ];
    const sorted = [...list].sort(compareDevicesForPicker);
    expect(sorted[0].name).toBe("Default Speakers");
    expect(sorted[1].name).toBe("AAA Device");
    expect(sorted[2].name).toBe("ZZZ Device");
  });

  it("within AMVC tier, default sorts before alpha", () => {
    const list = [
      dev("AudioManager Voice Output"),
      dev("AudioManager Stream Output", { is_default: true }),
    ];
    const sorted = [...list].sort(compareDevicesForPicker);
    expect(sorted[0].name).toBe("AudioManager Stream Output");
  });

  it("is a stable total order (idempotent re-sort)", () => {
    const list = [
      dev("Mic B"),
      dev(AMVC_STREAM_OUTPUT),
      dev("Mic A", { is_default: true }),
      dev(AMVC_VOICE_OUTPUT),
    ];
    const once = [...list].sort(compareDevicesForPicker);
    const twice = [...once].sort(compareDevicesForPicker);
    expect(twice).toEqual(once);
  });
});
