import { describe, expect, it } from "vitest";
import {
  getAudioManagerDeviceHint,
  getVirtualDeviceHint,
  isAudioManagerVirtualDevice,
  isLikelyVirtualAudioDevice,
} from "./devices";

describe("isAudioManagerVirtualDevice", () => {
  it("matches all 6 canonical devices", () => {
    const names = [
      "AudioManager Cable 1 Playback",
      "AudioManager Cable 1 Recording",
      "AudioManager Cable 2 Playback",
      "AudioManager Cable 2 Recording",
      "AudioManager Stream Output",
      "AudioManager Voice Output",
    ];
    for (const name of names) {
      expect(isAudioManagerVirtualDevice(name), name).toBe(true);
    }
  });

  it("is case-insensitive", () => {
    expect(isAudioManagerVirtualDevice("audiomanager stream output")).toBe(true);
    expect(isAudioManagerVirtualDevice("AUDIOMANAGER VOICE OUTPUT")).toBe(true);
    expect(isAudioManagerVirtualDevice("AudioManager Cable 1 Playback")).toBe(true);
  });

  it("requires the prefix at position 0", () => {
    expect(isAudioManagerVirtualDevice("My AudioManager device")).toBe(false);
    expect(isAudioManagerVirtualDevice(" AudioManager Cable 1")).toBe(false);
  });

  it("rejects third-party and physical devices", () => {
    expect(isAudioManagerVirtualDevice("VB-Cable Input")).toBe(false);
    expect(isAudioManagerVirtualDevice("Voicemeeter Input")).toBe(false);
    expect(isAudioManagerVirtualDevice("Realtek HD Audio")).toBe(false);
    expect(isAudioManagerVirtualDevice("")).toBe(false);
  });
});

describe("isLikelyVirtualAudioDevice", () => {
  it("returns true for all 6 AudioManager devices", () => {
    expect(isLikelyVirtualAudioDevice("AudioManager Stream Output")).toBe(true);
    expect(isLikelyVirtualAudioDevice("AudioManager Voice Output")).toBe(true);
    expect(isLikelyVirtualAudioDevice("AudioManager Cable 1 Recording")).toBe(true);
  });

  it("still returns true for third-party virtual cables", () => {
    expect(isLikelyVirtualAudioDevice("CABLE Input (VB-Audio Virtual Cable)")).toBe(true);
    expect(isLikelyVirtualAudioDevice("Voicemeeter Input")).toBe(true);
    expect(isLikelyVirtualAudioDevice("OBS Virtual Audio")).toBe(true);
  });

  it("returns false for physical devices", () => {
    expect(isLikelyVirtualAudioDevice("Realtek HD Audio")).toBe(false);
    expect(isLikelyVirtualAudioDevice("Speakers (Realtek)")).toBe(false);
    expect(isLikelyVirtualAudioDevice("Headphones")).toBe(false);
  });
});

describe("getAudioManagerDeviceHint", () => {
  it("stream output → B1 hint", () => {
    const hint = getAudioManagerDeviceHint("AudioManager Stream Output");
    expect(hint).not.toBeNull();
    expect(hint).toContain("B1");
  });

  it("voice output → B2 hint", () => {
    const hint = getAudioManagerDeviceHint("AudioManager Voice Output");
    expect(hint).not.toBeNull();
    expect(hint).toContain("B2");
  });

  it("cable playback gets a non-null hint", () => {
    expect(getAudioManagerDeviceHint("AudioManager Cable 1 Playback")).not.toBeNull();
    expect(getAudioManagerDeviceHint("AudioManager Cable 2 Playback")).not.toBeNull();
  });

  it("cable recording gets a non-null hint", () => {
    expect(getAudioManagerDeviceHint("AudioManager Cable 1 Recording")).not.toBeNull();
    expect(getAudioManagerDeviceHint("AudioManager Cable 2 Recording")).not.toBeNull();
  });

  it("returns null for non-AudioManager devices", () => {
    expect(getAudioManagerDeviceHint("VB-Cable Input")).toBeNull();
    expect(getAudioManagerDeviceHint("Voicemeeter Output")).toBeNull();
    expect(getAudioManagerDeviceHint("")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(getAudioManagerDeviceHint("audiomanager stream output")).toContain("B1");
    expect(getAudioManagerDeviceHint("AUDIOMANAGER VOICE OUTPUT")).toContain("B2");
  });
});

describe("getVirtualDeviceHint", () => {
  it("AudioManager stream output gets B1 hint", () => {
    const hint = getVirtualDeviceHint("AudioManager Stream Output");
    expect(hint).not.toBeNull();
    expect(hint).toContain("B1");
  });

  it("AudioManager voice output gets B2 hint", () => {
    const hint = getVirtualDeviceHint("AudioManager Voice Output");
    expect(hint).not.toBeNull();
    expect(hint).toContain("B2");
  });

  it("third-party VB-Cable still gets a hint", () => {
    expect(getVirtualDeviceHint("CABLE Input (VB-Audio Virtual Cable)")).not.toBeNull();
    expect(getVirtualDeviceHint("CABLE Output (VB-Audio Virtual Cable)")).not.toBeNull();
  });

  it("Voicemeeter still gets a hint", () => {
    expect(getVirtualDeviceHint("Voicemeeter Output")).not.toBeNull();
  });

  it("physical device returns null", () => {
    expect(getVirtualDeviceHint("Realtek HD Audio")).toBeNull();
  });
});
