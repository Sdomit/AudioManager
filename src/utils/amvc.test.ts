import { describe, expect, it } from "vitest";
import { isAmvcHealthy, isAmvcInstalled, parseAmvcHelperOutput } from "./amvc";

const HEALTHY_JSON = JSON.stringify({
  status: "installed-healthy",
  found: 6,
  expected: 6,
  driver_in_store: true,
  reboot_pending: false,
  detected: [
    "AudioManager Cable 1 Playback",
    "AudioManager Cable 1 Recording",
    "AudioManager Cable 2 Playback",
    "AudioManager Cable 2 Recording",
    "AudioManager Stream Output",
    "AudioManager Voice Output",
  ],
  missing: [],
});

const NOT_INSTALLED_JSON = JSON.stringify({
  status: "not-installed",
  found: 0,
  expected: 6,
  driver_in_store: false,
  reboot_pending: false,
  detected: [],
  missing: [
    "AudioManager Cable 1 Playback",
    "AudioManager Cable 1 Recording",
    "AudioManager Cable 2 Playback",
    "AudioManager Cable 2 Recording",
    "AudioManager Stream Output",
    "AudioManager Voice Output",
  ],
});

const NEEDS_REPAIR_JSON = JSON.stringify({
  status: "needs-repair",
  found: 4,
  expected: 6,
  driver_in_store: true,
  reboot_pending: false,
  detected: [
    "AudioManager Cable 1 Playback",
    "AudioManager Cable 1 Recording",
    "AudioManager Cable 2 Playback",
    "AudioManager Cable 2 Recording",
  ],
  missing: ["AudioManager Stream Output", "AudioManager Voice Output"],
});

const NEEDS_REBOOT_JSON = JSON.stringify({
  status: "needs-reboot",
  found: 6,
  expected: 6,
  driver_in_store: true,
  reboot_pending: true,
  detected: [
    "AudioManager Cable 1 Playback",
    "AudioManager Cable 1 Recording",
    "AudioManager Cable 2 Playback",
    "AudioManager Cable 2 Recording",
    "AudioManager Stream Output",
    "AudioManager Voice Output",
  ],
  missing: [],
});

describe("parseAmvcHelperOutput", () => {
  it("parses healthy status with all fields", () => {
    const r = parseAmvcHelperOutput(HEALTHY_JSON);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.status).toBe("installed-healthy");
      expect(r.found).toBe(6);
      expect(r.expected).toBe(6);
      expect(r.driver_in_store).toBe(true);
      expect(r.reboot_pending).toBe(false);
      expect(r.detected).toHaveLength(6);
      expect(r.missing).toHaveLength(0);
    }
  });

  it("parses not-installed with zero found and 6 missing", () => {
    const r = parseAmvcHelperOutput(NOT_INSTALLED_JSON);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.status).toBe("not-installed");
      expect(r.found).toBe(0);
      expect(r.missing).toHaveLength(6);
      expect(r.detected).toHaveLength(0);
    }
  });

  it("parses needs-repair with partial detection", () => {
    const r = parseAmvcHelperOutput(NEEDS_REPAIR_JSON);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.status).toBe("needs-repair");
      expect(r.found).toBe(4);
      expect(r.detected).toHaveLength(4);
      expect(r.missing).toHaveLength(2);
    }
  });

  it("parses needs-reboot with reboot_pending=true", () => {
    const r = parseAmvcHelperOutput(NEEDS_REBOOT_JSON);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.status).toBe("needs-reboot");
      expect(r.reboot_pending).toBe(true);
    }
  });

  it("returns unavailable for invalid JSON", () => {
    const r = parseAmvcHelperOutput("not json");
    expect(r.kind).toBe("unavailable");
  });

  it("returns unavailable for empty string", () => {
    const r = parseAmvcHelperOutput("");
    expect(r.kind).toBe("unavailable");
  });

  it("returns unavailable when status field is missing", () => {
    const r = parseAmvcHelperOutput(JSON.stringify({ found: 0, expected: 6 }));
    expect(r.kind).toBe("unavailable");
  });

  it("tolerates missing arrays by defaulting to []", () => {
    const r = parseAmvcHelperOutput(
      JSON.stringify({ status: "not-installed", found: 0, expected: 6 }),
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.detected).toEqual([]);
      expect(r.missing).toEqual([]);
    }
  });
});

describe("isAmvcInstalled", () => {
  it("returns false for not-installed", () => {
    expect(isAmvcInstalled(parseAmvcHelperOutput(NOT_INSTALLED_JSON))).toBe(false);
  });

  it("returns true for installed-healthy", () => {
    expect(isAmvcInstalled(parseAmvcHelperOutput(HEALTHY_JSON))).toBe(true);
  });

  it("returns true for needs-repair (installed but broken)", () => {
    expect(isAmvcInstalled(parseAmvcHelperOutput(NEEDS_REPAIR_JSON))).toBe(true);
  });

  it("returns true for needs-reboot", () => {
    expect(isAmvcInstalled(parseAmvcHelperOutput(NEEDS_REBOOT_JSON))).toBe(true);
  });

  it("returns false for unavailable", () => {
    expect(isAmvcInstalled({ kind: "unavailable", reason: "not found" })).toBe(false);
  });
});

describe("isAmvcHealthy", () => {
  it("returns true only for installed-healthy", () => {
    expect(isAmvcHealthy(parseAmvcHelperOutput(HEALTHY_JSON))).toBe(true);
  });

  it("returns false for needs-repair", () => {
    expect(isAmvcHealthy(parseAmvcHelperOutput(NEEDS_REPAIR_JSON))).toBe(false);
  });

  it("returns false for needs-reboot", () => {
    expect(isAmvcHealthy(parseAmvcHelperOutput(NEEDS_REBOOT_JSON))).toBe(false);
  });

  it("returns false for not-installed", () => {
    expect(isAmvcHealthy(parseAmvcHelperOutput(NOT_INSTALLED_JSON))).toBe(false);
  });

  it("returns false for unavailable", () => {
    expect(isAmvcHealthy({ kind: "unavailable", reason: "not found" })).toBe(false);
  });
});
