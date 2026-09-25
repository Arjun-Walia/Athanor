// Line icons in one stroke weight, drawn on a 24px grid. Decorative by
// default; pass a `title` to make one announce itself. The landing page has
// its own smaller set so the two bundles stay independent.

function Svg({ size = 20, title, children, strokeWidth = 1.7, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export const Icon = {
  Server: (p) => (
    <Svg {...p}>
      <rect x="3.5" y="4" width="17" height="6.5" rx="2" />
      <rect x="3.5" y="13.5" width="17" height="6.5" rx="2" />
      <path d="M7.5 7.25h.01M7.5 16.75h.01M11 7.25h5.5M11 16.75h5.5" />
    </Svg>
  ),
  Nodes: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="5.5" r="2.25" />
      <circle cx="5.5" cy="17.5" r="2.25" />
      <circle cx="18.5" cy="17.5" r="2.25" />
      <path d="M10.9 7.5 6.6 15.5M13.1 7.5l4.3 8M7.75 17.5h8.5" />
    </Svg>
  ),
  Box: (p) => (
    <Svg {...p}>
      <path d="M12 3 20 7.5v9L12 21l-8-4.5v-9L12 3Z" />
      <path d="M4 7.5 12 12l8-4.5M12 12v9" />
    </Svg>
  ),
  Layers: (p) => (
    <Svg {...p}>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </Svg>
  ),
  Activity: (p) => (
    <Svg {...p}>
      <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />
    </Svg>
  ),
  Bell: (p) => (
    <Svg {...p}>
      <path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 1.5h-15L6 16.5Z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </Svg>
  ),
  Gear: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.54V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.54 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.54-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.54V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.54 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.54 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z" />
    </Svg>
  ),
  Plug: (p) => (
    <Svg {...p}>
      <path d="M9 3v4M15 3v4M6.5 7h11v4a5.5 5.5 0 0 1-11 0V7ZM12 16.5V21" />
    </Svg>
  ),
  ArrowUpRight: (p) => (
    <Svg {...p}>
      <path d="M7 17 17 7M8 7h9v9" />
    </Svg>
  ),
  Play: (p) => (
    <Svg {...p}>
      <path d="M8 5.5v13l10.5-6.5L8 5.5Z" />
    </Svg>
  ),
  Stop: (p) => (
    <Svg {...p}>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
    </Svg>
  ),
  Power: (p) => (
    <Svg {...p}>
      <path d="M12 3v8M6.4 6.6a8 8 0 1 0 11.2 0" />
    </Svg>
  ),
  Clock: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l2.5 2.5M5 4 2.5 6.5M19 4l2.5 2.5" />
    </Svg>
  ),
  Check: (p) => (
    <Svg {...p}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Svg>
  ),
  X: (p) => (
    <Svg {...p}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  ),
  Alert: (p) => (
    <Svg {...p}>
      <path d="M12 3.5 2.5 20h19L12 3.5Z" />
      <path d="M12 10v4.5M12 17.5h.01" />
    </Svg>
  ),
  Info: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 7.5h.01" />
    </Svg>
  ),
  Shield: (p) => (
    <Svg {...p}>
      <path d="M12 3 19.5 6v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6L12 3Z" />
      <path d="m8.75 12 2.25 2.25 4.25-4.5" />
    </Svg>
  ),
  ShieldAlert: (p) => (
    <Svg {...p}>
      <path d="M12 3 19.5 6v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6L12 3Z" />
      <path d="M12 8.5v4.5M12 16h.01" />
    </Svg>
  ),
  Upload: (p) => (
    <Svg {...p}>
      <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M4.5 15.5v3a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-3" />
    </Svg>
  ),
  Download: (p) => (
    <Svg {...p}>
      <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M4.5 15.5v3a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-3" />
    </Svg>
  ),
  Eye: (p) => (
    <Svg {...p}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.75" />
    </Svg>
  ),
  Trash: (p) => (
    <Svg {...p}>
      <path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5" />
    </Svg>
  ),
  Zap: (p) => (
    <Svg {...p}>
      <path d="M13 2.5 4.5 13.5H12L11 21.5l8.5-11H12l1-8Z" />
    </Svg>
  ),
  Heal: (p) => (
    <Svg {...p}>
      <path d="M20.5 8.5a8.5 8.5 0 0 0-15.5-2M3.5 15.5a8.5 8.5 0 0 0 15.5 2" />
      <path d="M5 2.5v4h4M19 21.5v-4h-4M12 9v6M9 12h6" />
    </Svg>
  ),
  ChevronDown: (p) => (
    <Svg {...p}>
      <path d="m6 9 6 6 6-6" />
    </Svg>
  ),
  ChevronUp: (p) => (
    <Svg {...p}>
      <path d="m6 15 6-6 6 6" />
    </Svg>
  ),
  More: (p) => (
    <Svg {...p}>
      <path d="M12 5.5h.01M12 12h.01M12 18.5h.01" strokeWidth="2.6" />
    </Svg>
  ),
  Scissors: (p) => (
    <Svg {...p}>
      <circle cx="6" cy="6.5" r="2.5" />
      <circle cx="6" cy="17.5" r="2.5" />
      <path d="M8 8 20 18M8 16 20 6" />
    </Svg>
  ),
  Link: (p) => (
    <Svg {...p}>
      <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" />
      <path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" />
    </Svg>
  ),
  Refresh: (p) => (
    <Svg {...p}>
      <path d="M20 11a8 8 0 0 0-14.5-4.5L3.5 9M4 13a8 8 0 0 0 14.5 4.5l2-2.5" />
      <path d="M3.5 4v5h5M20.5 20v-5h-5" />
    </Svg>
  ),
  Search: (p) => (
    <Svg {...p}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.35-4.35" />
    </Svg>
  ),
  File: (p) => (
    <Svg {...p}>
      <path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5L13.5 3Z" />
      <path d="M13.5 3v5.5H19" />
    </Svg>
  ),
  Hash: (p) => (
    <Svg {...p}>
      <path d="M5 9h15M4 15h15M10 3.5 8 20.5M16 3.5l-2 17" />
    </Svg>
  ),
  Flame: (p) => (
    <Svg {...p}>
      <path d="M12 21.5c4 0 7-2.8 7-6.8 0-4.4-3.4-6.7-4.4-10.7-2.6 1.6-3.4 4.1-3.1 6.3-1.3-.6-2.1-1.8-2.3-3.3C7.1 8.8 5 11.5 5 14.7c0 4 3 6.8 7 6.8Z" />
    </Svg>
  ),
  Dot: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
    </Svg>
  ),
  Github: (p) => (
    <Svg {...p}>
      <path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21" />
    </Svg>
  ),
  Sliders: (p) => (
    <Svg {...p}>
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
      <circle cx="15" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="18" r="2" />
    </Svg>
  ),
};
