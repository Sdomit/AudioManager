import type { BusId } from "./types";

export interface BusTemplate {
  id: BusId;
  name: string;
  volume: number;
  enabled: boolean;
}

export interface DeviceTemplate {
  id: string;
  name: string;
  description: string;
  buses: BusTemplate[];
}

const vol = (pct: number) => pct / 100;

export const DEVICE_TEMPLATES: DeviceTemplate[] = [
  {
    id: "streaming-podcast",
    name: "Streaming + Podcast",
    description: "Headphone monitoring, room speakers, stream output, and a dedicated recording bus.",
    buses: [
      { id: "A1", name: "Headphones",    volume: vol(75), enabled: true },
      { id: "A2", name: "Speakers",      volume: vol(65), enabled: true },
      { id: "B1", name: "Stream",        volume: vol(75), enabled: true },
      { id: "B2", name: "Recording",     volume: vol(75), enabled: true },
    ],
  },
  {
    id: "gaming-chat",
    name: "Gaming + Chat",
    description: "Game audio on main output, separate chat mix on headset, stream and clip capture.",
    buses: [
      { id: "A1", name: "Game Audio",    volume: vol(75), enabled: true },
      { id: "A2", name: "Chat Mix",      volume: vol(70), enabled: true },
      { id: "B1", name: "Stream",        volume: vol(75), enabled: true },
      { id: "B2", name: "Clips",         volume: vol(75), enabled: false },
    ],
  },
  {
    id: "studio-monitor",
    name: "Studio Monitoring",
    description: "Main monitors and headphone cue, with a mix-minus recording output.",
    buses: [
      { id: "A1", name: "Main Monitors", volume: vol(75), enabled: true },
      { id: "A2", name: "Headphone Cue", volume: vol(70), enabled: true },
      { id: "B1", name: "Mix Minus",     volume: vol(75), enabled: true },
      { id: "B2", name: "Recording",     volume: vol(75), enabled: true },
    ],
  },
  {
    id: "live-event",
    name: "Live Event",
    description: "Front-of-house PA, stage monitor, broadcast feed, and multi-track recording.",
    buses: [
      { id: "A1", name: "FOH PA",        volume: vol(80), enabled: true },
      { id: "A2", name: "Stage Monitor", volume: vol(65), enabled: true },
      { id: "B1", name: "Broadcast",     volume: vol(75), enabled: true },
      { id: "B2", name: "Multitrack",    volume: vol(75), enabled: true },
    ],
  },
];
