// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DeviceInfo } from "../../types/engine";

const OUTPUTS: DeviceInfo[] = [
  { id: "spk", name: "Speakers (Realtek)", default_sample_rate: 48000, channels: 2, is_default: true },
  { id: "vb", name: "CABLE Input (VB-Audio Virtual Cable)", default_sample_rate: 48000, channels: 2, is_default: false },
  { id: "amvc-stream", name: "AudioManager Stream Output", default_sample_rate: 48000, channels: 2, is_default: false },
  { id: "amvc-voice", name: "AudioManager Voice Output", default_sample_rate: 48000, channels: 2, is_default: false },
];

const INPUTS: DeviceInfo[] = [
  { id: "mic", name: "Microphone (Realtek)", default_sample_rate: 48000, channels: 1, is_default: true },
  { id: "amvc-cap-1", name: "AudioManager Cable 1 Recording", default_sample_rate: 48000, channels: 2, is_default: false },
];

const SESSIONS = [{ pid: 4242, name: "chrome.exe", source_id: "app:chrome.exe" }];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "list_output_devices") return OUTPUTS;
    if (cmd === "list_input_devices") return INPUTS;
    if (cmd === "list_audio_sessions") return SESSIONS;
    return [];
  }),
}));

// Imported after vi.mock so the mocked core module is in place.
const { DevicePicker } = await import("./DevicePicker");

afterEach(cleanup);

/** Device rows are the buttons whose label includes the "Hz" meta line. */
function deviceButtonNames(): string[] {
  return screen
    .getAllByRole("button")
    .filter((b) => /Hz/.test(b.textContent ?? ""))
    .map((b) => {
      const m = (b.textContent ?? "").match(/^(.*?)\d+ Hz/);
      return m ? m[1].trim() : (b.textContent ?? "");
    });
}

describe("DevicePicker (output, B1)", () => {
  it("sorts AudioManager devices to the top", async () => {
    render(
      <DevicePicker
        open
        kind="output"
        title="Output device for B1 Stream"
        highlightVirtual
        recommendedDeviceId="amvc-stream"
        onPick={() => {}}
        onClose={() => {}}
      />,
    );

    await screen.findByText("AudioManager Stream Output");
    const names = deviceButtonNames();

    // Both AMVC endpoints precede the physical + third-party devices.
    const streamIdx = names.indexOf("AudioManager Stream Output");
    const voiceIdx = names.indexOf("AudioManager Voice Output");
    const spkIdx = names.indexOf("Speakers (Realtek)");
    const vbIdx = names.findIndex((n) => n.startsWith("CABLE Input"));

    expect(streamIdx).toBeGreaterThanOrEqual(0);
    expect(streamIdx).toBeLessThan(spkIdx);
    expect(voiceIdx).toBeLessThan(spkIdx);
    expect(streamIdx).toBeLessThan(vbIdx);
  });

  it("shows a Recommended badge on the suggested device", async () => {
    render(
      <DevicePicker
        open
        kind="output"
        title="Output device for B1 Stream"
        highlightVirtual
        recommendedDeviceId="amvc-stream"
        onPick={() => {}}
        onClose={() => {}}
      />,
    );

    const badge = await screen.findByText("Recommended");
    expect(badge).toBeTruthy();
    // The badge lives inside the same button as the recommended device.
    const row = badge.closest("button");
    expect(row?.textContent).toContain("AudioManager Stream Output");
  });

  it("renders a role hint for AudioManager endpoints", async () => {
    render(
      <DevicePicker
        open
        kind="output"
        title="Output device for B1 Stream"
        highlightVirtual
        onPick={() => {}}
        onClose={() => {}}
      />,
    );

    expect(await screen.findByText(/B1 stream bus/i)).toBeTruthy();
    expect(screen.getByText(/B2 voice bus/i)).toBeTruthy();
  });

  it("calls onPick with the device id when a row is clicked", async () => {
    const onPick = vi.fn();
    render(
      <DevicePicker
        open
        kind="output"
        title="Output device for B1 Stream"
        highlightVirtual
        onPick={onPick}
        onClose={() => {}}
      />,
    );

    const row = (await screen.findByText("AudioManager Stream Output")).closest("button");
    expect(row).toBeTruthy();
    fireEvent.click(row!);
    expect(onPick).toHaveBeenCalledWith("amvc-stream");
  });

  it("excludes ids passed via excludeIds", async () => {
    render(
      <DevicePicker
        open
        kind="output"
        title="Output device for B1 Stream"
        excludeIds={new Set(["amvc-stream"])}
        onPick={() => {}}
        onClose={() => {}}
      />,
    );

    await screen.findByText("AudioManager Voice Output");
    expect(screen.queryByText("AudioManager Stream Output")).toBeNull();
  });
});

describe("DevicePicker (input, app-capture)", () => {
  it("marks an AudioManager Cable Recording source as Recommended", async () => {
    const onPick = vi.fn();
    render(
      <DevicePicker
        open
        kind="input"
        title="Add input device"
        highlightVirtual
        recommendedDeviceId="amvc-cap-1"
        onPick={onPick}
        onClose={() => {}}
      />,
    );

    const cap = await screen.findByText("AudioManager Cable 1 Recording");
    const row = cap.closest("button");
    expect(row?.textContent).toContain("Recommended");

    fireEvent.click(row!);
    expect(onPick).toHaveBeenCalledWith("amvc-cap-1");
  });
});

describe("DevicePicker (input, loopback sources)", () => {
  it("offers System sound + app sessions and picks their synthetic ids", async () => {
    const onPick = vi.fn();
    render(
      <DevicePicker
        open
        kind="input"
        title="Add input"
        includeLoopbackSources
        onPick={onPick}
        onClose={() => {}}
      />,
    );

    // App session resolved from list_audio_sessions.
    const app = await screen.findByText("chrome.exe");
    fireEvent.click(app.closest("button")!);
    expect(onPick).toHaveBeenCalledWith("app:chrome.exe");

    // "System sound" is a static loopback entry mapped to sys:default.
    const sys = screen.getByText("System sound");
    fireEvent.click(sys.closest("button")!);
    expect(onPick).toHaveBeenCalledWith("sys:default");
  });

  it("does not fetch sessions for output pickers", async () => {
    render(
      <DevicePicker
        open
        kind="output"
        title="Output device"
        includeLoopbackSources
        onPick={() => {}}
        onClose={() => {}}
      />,
    );
    await screen.findByText("Speakers (Realtek)");
    expect(screen.queryByText("System sound")).toBeNull();
  });
});
