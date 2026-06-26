// Shared Mythera icon set for the launcher. Dependency-free inline SVGs.

import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

// Default intrinsic size so an icon always renders even with no width/height class.
const sized = { width: '1em', height: '1em' } as const;

const base = {
  ...sized,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

// Coin — blocky/pixel style for the balance pill
export function CoinIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...sized} {...props}>
      <circle cx="12" cy="12" r="9" fill="#f5b942" />
      <circle cx="12" cy="12" r="9" fill="none" stroke="#c98a1e" strokeWidth="1.4" />
      <path d="M9.5 8h4.2c1.4 0 2.3.9 2.3 2.1S15.1 12 13.7 12H11v4H9.5V8Z" fill="#9c6a16" />
      <rect x="11" y="9.4" width="3" height="1.4" fill="#f7d27a" />
    </svg>
  );
}

// Arrow right — action buttons (rotate 90° for a download/down arrow)
export function ArrowRightIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <path d="M4.5 12h14" />
      <path d="m13 6.5 6 5.5-6 5.5" />
    </svg>
  );
}

// Log out — door + arrow
export function LogoutIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <path d="M15 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H15" />
      <path d="M10 12h10M16.5 8l4 4-4 4" />
    </svg>
  );
}

// Diamond — section eyebrows ("FEATURED SERVER", "SERVERS")
export function DiamondIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...sized} fill="currentColor" {...props}>
      <path d="M12 2.5 21.5 12 12 21.5 2.5 12 12 2.5Z" />
    </svg>
  );
}

// Star — marks the featured server in the sidebar
export function StarIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...sized} fill="currentColor" {...props}>
      <path d="M12 2.5l2.7 5.9 6.3.7-4.7 4.3 1.3 6.3L12 16.9 6.1 20l1.3-6.3L2.7 9.4l6.3-.7L12 2.5Z" />
    </svg>
  );
}

// Cube — VERSION stat tile
export function CubeIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z" />
      <path d="M4 7l8 4 8-4M12 11v10" />
    </svg>
  );
}

// Gamepad — MODE stat tile
export function ModeIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <path d="M7 8.5h10a4.5 4.5 0 0 1 4.4 5.6l-.7 2.8A2.4 2.4 0 0 1 16 17l-1.3-1.5h-5.4L8 17a2.4 2.4 0 0 1-4-.1l-.7-2.8A4.5 4.5 0 0 1 7 8.5Z" />
      <path d="M7.5 11.5v2.2M6.4 12.6h2.2M15.5 12h.01M17.5 13.6h.01" />
    </svg>
  );
}

// Layers — LOADER stat tile
export function LayersIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <path d="M12 3 3 8l9 5 9-5-9-5Z" />
      <path d="M3 13l9 5 9-5M3 16.5l9 5 9-5" />
    </svg>
  );
}

// Users — PLAYERS ONLINE header
export function UsersIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <path d="M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19" />
      <circle cx="10" cy="8" r="3.2" />
      <path d="M20 19v-1.5a3.5 3.5 0 0 0-2.6-3.4M15.5 5.2a3.2 3.2 0 0 1 0 5.6" />
    </svg>
  );
}

// Crossed swords — the Play / Launch CTA (Mythera motif)
export function SwordsIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <path d="M14.5 14.5 20 9V4h-5l-5.5 5.5M14.5 14.5 19 19l1.5-1.5L16 13M14.5 14.5l-2-2" />
      <path d="M9.5 14.5 4 9V4h5l5.5 5.5M9.5 14.5 5 19l-1.5-1.5L8 13M9.5 14.5l2-2" />
    </svg>
  );
}

// Window controls (frameless title bar)
export function MinimizeIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <path d="M5 12h14" />
    </svg>
  );
}
export function MaximizeIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <rect x="5.5" y="5.5" width="13" height="13" rx="1.5" />
    </svg>
  );
}
export function CloseIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}
export function ChevronDownIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

// Gear — settings
export function GearIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 13.5a1.6 1.6 0 0 0 .3 1.8l.05.05a2 2 0 1 1-2.8 2.8l-.05-.05a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.05.05a2 2 0 1 1-2.8-2.8l.05-.05a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.05-.05a2 2 0 1 1 2.8-2.8l.05.05a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.05-.05a2 2 0 1 1 2.8 2.8l-.05.05a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
    </svg>
  );
}

// Arrow left — back
export function ArrowLeftIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <path d="M19 12H5M11 18l-6-6 6-6" />
    </svg>
  );
}

// CPU/RAM — performance
export function CpuIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
      <path d="M9.5 2.5v2M14.5 2.5v2M9.5 19.5v2M14.5 19.5v2M2.5 9.5h2M2.5 14.5h2M19.5 9.5h2M19.5 14.5h2" />
    </svg>
  );
}

// Gauge — performance mode
export function GaugeIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <path d="M4.5 18a8 8 0 1 1 15 0" />
      <path d="M12 14l3.5-3.5" />
    </svg>
  );
}

// Monitor — game display
export function MonitorIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <rect x="3" y="4.5" width="18" height="12" rx="1.5" />
      <path d="M9 20h6M12 16.5V20" />
    </svg>
  );
}

// Folder — game directory
export function FolderIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2.5h8A1.5 1.5 0 0 1 20.5 9v8A1.5 1.5 0 0 1 19 18.5H5A1.5 1.5 0 0 1 3.5 17V6.5Z" />
    </svg>
  );
}

// Play — solid triangle CTA
export function PlayIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...sized} fill="currentColor" {...props}>
      <path d="M8 5.5v13a1 1 0 0 0 1.5.87l11-6.5a1 1 0 0 0 0-1.74l-11-6.5A1 1 0 0 0 8 5.5Z" />
    </svg>
  );
}

// Star outline — un-favorited state (filled StarIcon = favorited)
export function StarOutlineIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <path d="M12 3.5l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.9 6.7 20l1.2-6-4.5-4.1 6-.7L12 3.5Z" />
    </svg>
  );
}

// Download — tray + down arrow (dropup: reinstall)
export function DownloadIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <path d="M12 4v10m0 0 4-4m-4 4-4-4" />
      <path d="M5 18.5h14" />
    </svg>
  );
}

// Upload — tray + up arrow (skin upload)
export function UploadIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <path d="M12 16V6m0 0-4 4m4-4 4 4" />
      <path d="M5 18.5h14" />
    </svg>
  );
}

// Check-shield — dropup: verify files
export function CheckIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <path d="M12 3.5 5 6v5.5c0 4 3 7 7 8.5 4-1.5 7-4.5 7-8.5V6l-7-2.5Z" />
      <path d="m9 11.5 2 2 4-4" />
    </svg>
  );
}

// Refresh — two clockwise arcs with arrowheads (shares the stroked base style of the set)
export function RefreshIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...base} {...props}>
      <path d="M20 11a8 8 0 0 0-14-4.5L4 8" />
      <path d="M4 4v4h4" />
      <path d="M4 13a8 8 0 0 0 14 4.5L20 16" />
      <path d="M20 20v-4h-4" />
    </svg>
  );
}
