/**
 * Public surface of the AudioManager UI package.
 *
 * Mount <AudioManager /> in your app shell to get the full layout.
 *
 * Import individual components for finer control if you want to swap
 * pieces (custom InputList, custom Topbar, etc.).
 */

export { AudioManager } from "./AudioManager";

export { TopBar } from "./TopBar";
export { BusRail } from "./BusRail";
export { BusCard } from "./BusCard";
export { InputList } from "./InputList";
export { InputRow } from "./InputRow";
export { RoutingView } from "./RoutingView";
export { MatrixView } from "./MatrixView";
export { FlowView } from "./FlowView";
export { DetailPanel } from "./DetailPanel";
export { InputDetail } from "./InputDetail";
export { BusDetail } from "./BusDetail";
export { StreamSetupSheet } from "./StreamSetupSheet";
export { PresetBanner } from "./PresetBanner";

export { MeterCanvas } from "./MeterCanvas";
export { Pill } from "./Pill";

export { useAudioManager } from "./useAudioManager";
export * as tauri from "./tauriCommands";

export type {
  Bus,
  BusId,
  BusRole,
  BusState,
  AudioInput,
  InputSourceKind,
  Send,
  Preset,
  PresetVersion,
  RoutingView as RoutingViewKind,
  Density,
  DetailSelection,
  StreamSetupStep,
  StreamSetupStepStatus,
  AudioManagerActions,
  AudioManagerState,
  UseAudioManager,
} from "./types";
