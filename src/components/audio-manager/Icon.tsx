import type { SVGProps } from "react";

/**
 * Inline SVG icon set for AudioManager.
 *
 * All icons are 24×24 viewBox, stroke-based, currentColor.
 * Default render size 16px (set via fontSize on the parent or via width/height).
 *
 * Avoids pulling in an icon library. Add icons here as needed.
 */

export type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Base({ size = 16, children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}

export const PowerIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 3v9" />
    <path d="M5.5 7.5a8 8 0 1 0 13 0" />
  </Base>
);

export const MuteIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M11 5 6 9H3v6h3l5 4V5z" />
    <path d="M22 9l-6 6" />
    <path d="M16 9l6 6" />
  </Base>
);

export const VolumeIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M11 5 6 9H3v6h3l5 4V5z" />
    <path d="M16 9a4 4 0 0 1 0 6" />
    <path d="M19 6a8 8 0 0 1 0 12" />
  </Base>
);

export const MicIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="9" y="3" width="6" height="12" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0" />
    <path d="M12 18v3" />
  </Base>
);

export const PhoneIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="7" y="2" width="10" height="20" rx="2.5" />
    <path d="M11 18h2" />
  </Base>
);

export const SpeakerIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="5" y="3" width="14" height="18" rx="2" />
    <circle cx="12" cy="14" r="3" />
    <circle cx="12" cy="7" r="0.5" fill="currentColor" />
  </Base>
);

export const HeadphonesIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M3 18v-6a9 9 0 1 1 18 0v6" />
    <path d="M21 18a2 2 0 0 1-2 2h-1v-6h3z" />
    <path d="M3 18a2 2 0 0 0 2 2h1v-6H3z" />
  </Base>
);

export const RadioIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="2" />
    <path d="M16.24 7.76a6 6 0 0 1 0 8.49" />
    <path d="M7.76 16.24a6 6 0 0 1 0-8.48" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    <path d="M4.93 19.07a10 10 0 0 1 0-14.14" />
  </Base>
);

export const RecordIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="3.5" fill="currentColor" />
  </Base>
);

export const AppIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </Base>
);

export const ChainIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M9 17H7a5 5 0 0 1 0-10h2" />
    <path d="M15 7h2a5 5 0 0 1 0 10h-2" />
    <path d="M8 12h8" />
  </Base>
);

export const SearchIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Base>
);

export const PlusIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </Base>
);

export const MoreIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="5" r="1.2" fill="currentColor" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    <circle cx="12" cy="19" r="1.2" fill="currentColor" />
  </Base>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="m6 9 6 6 6-6" />
  </Base>
);

export const ChevronRightIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="m9 6 6 6-6 6" />
  </Base>
);

export const XIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M6 6l12 12" />
    <path d="M18 6 6 18" />
  </Base>
);

export const CheckIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="m5 12 5 5 9-11" />
  </Base>
);

export const AlertIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 4 2 20h20Z" />
    <path d="M12 10v5" />
    <circle cx="12" cy="17.5" r="0.6" fill="currentColor" />
  </Base>
);

export const InfoIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5" />
    <circle cx="12" cy="8" r="0.6" fill="currentColor" />
  </Base>
);

export const SettingsIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Base>
);

export const GridIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </Base>
);

export const FlowIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="5" cy="6" r="2" />
    <circle cx="5" cy="18" r="2" />
    <circle cx="19" cy="12" r="2" />
    <path d="M7 6c5 0 7 2 10 6" />
    <path d="M7 18c5 0 7-2 10-6" />
  </Base>
);

export const BroadcastIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="1.6" fill="currentColor" />
    <path d="M8.5 8.5a5 5 0 0 0 0 7" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    <path d="M5 5a10 10 0 0 0 0 14" />
    <path d="M19 5a10 10 0 0 1 0 14" />
  </Base>
);

/** Pick the right icon for an input source kind. */
export function iconForKind(kind: string) {
  switch (kind) {
    case "microphone": return <MicIcon />;
    case "system":     return <SpeakerIcon />;
    case "app":        return <AppIcon />;
    case "loopback":   return <ChainIcon />;
    case "virtual":    return <RadioIcon />;
    case "phone":      return <PhoneIcon />;
    default:           return <AppIcon />;
  }
}

/** Pick the right icon for a bus role. */
export function iconForBusRole(role: string) {
  switch (role) {
    case "monitor":  return <HeadphonesIcon />;
    case "speakers": return <SpeakerIcon />;
    case "stream":   return <BroadcastIcon />;
    case "record":   return <RecordIcon />;
    default:         return <SpeakerIcon />;
  }
}
