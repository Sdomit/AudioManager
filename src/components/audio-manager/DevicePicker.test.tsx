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
];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "list_output_devices") return OUTPUTS;
    if (cmd === "list_input_devices") return INPUTS;
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
