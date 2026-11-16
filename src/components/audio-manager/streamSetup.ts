import { isLikelyVirtualAudioDevice } from "../../utils/devices";
import type { AudioInput, Bus, Send, StreamSetupStep } from "./types";

export function deriveStreamSetupSteps(
  buses: Bus[],
  inputs: AudioInput[],
  sends: Send[],
): StreamSetupStep[] {
  // Role overrides are cosmetic; B1 is the stream bus the engine routes to capture apps.
  const bus = buses.find((b) => b.id === "B1");
  if (!bus) return [];
  const name = `${bus.id} ${bus.label}`;

  const device: StreamSetupStep = bus.device
    ? { id: "busdevice", title: "Stream bus has an output", status: "ok", detail: `${name} → ${bus.device}.` }
    : { id: "busdevice", title: "Stream bus has an output", status: "error", detail: `Pick an output for ${name}, usually a virtual cable such as CABLE Input.` };

  const cable: StreamSetupStep = !bus.device
    ? { id: "vcable", title: "Output is a virtual cable", status: "pending", detail: "Waiting for an output device." }
    : isLikelyVirtualAudioDevice(bus.device)
    ? { id: "vcable", title: "Output is a virtual cable", status: "ok", detail: "Capture apps can record this bus." }
    : { id: "vcable", title: "Output is a virtual cable", status: "warning", detail: `${bus.device} looks like a physical device. OBS/Discord can only pick up this bus through a virtual cable.` };

  const routedIds = new Set(sends.filter((s) => s.busId === bus.id && s.enabled && !s.muted).map((s) => s.inputId));
  const routed = inputs.filter((i) => routedIds.has(i.id)).map((i) => i.name);
  const routing: StreamSetupStep = routed.length
    ? { id: "routing", title: "Inputs routed to Stream", status: "ok", detail: `${routed.join(", ")}.` }
    : { id: "routing", title: "Inputs routed to Stream", status: "warning", detail: `Nothing is sent to ${name} yet. Turn on its send for your mic.` };

  const failed = bus.state === "error" || !!bus.error;
  const live: StreamSetupStep = failed
    ? { id: "enabled", title: "Stream bus live", status: "error", detail: `${name} output failed: ${bus.error ?? "device error"}.` }
    : bus.enabled && !bus.muted
      ? { id: "enabled", title: "Stream bus live", status: "ok", detail: `${name} is on and unmuted.` }
      : { id: "enabled", title: "Stream bus live", status: bus.device ? "warning" : "pending", detail: bus.muted ? `${name} is muted.` : `${name} is disabled.` };

  return [device, cable, routing, live];
}
