// A small inline icon set for the landing page. 24px grid, 1.7 stroke,
// drawn with currentColor. Decorative by default (aria-hidden); pass
// `title` when an icon is the only thing carrying meaning.
//
// Kept separate from the dashboard's set on purpose: the landing bundle is
// lazy-loaded and should not pull the dashboard's icons in with it.

function Svg({ children, size = "1.25em", title, strokeWidth = 1.7, ...rest }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      aria-hidden={title ? undefined : "true"}
      role={title ? "img" : undefined}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export function IconBrand(props) {
  return (
    <Svg strokeWidth={2.4} {...props}>
      <circle cx="12" cy="12" r="8" strokeDasharray="35 15" transform="rotate(-90 12 12)" />
      <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconGithub(props) {
  return (
    <Svg stroke="none" {...props}>
      <path
        fill="currentColor"
        d="M12 .6C5.7.6.6 5.7.6 12c0 5 3.3 9.3 7.8 10.8.6.1.8-.2.8-.6v-2.1c-3.2.7-3.8-1.4-3.8-1.4-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.5-.3-5.2-1.3-5.2-5.6 0-1.2.4-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.1 1.2a10.8 10.8 0 0 1 5.7 0c2.2-1.5 3.1-1.2 3.1-1.2.6 1.6.2 2.8.1 3.1.7.8 1.2 1.9 1.2 3.1 0 4.4-2.7 5.4-5.2 5.6.4.4.8 1.1.8 2.2v3.2c0 .3.2.7.8.6A11.4 11.4 0 0 0 23.4 12C23.4 5.7 18.3.6 12 .6Z"
      />
    </Svg>
  );
}

export const IconArrowUpRight = (p) => (
  <Svg {...p}>
    <path d="M7 17 17 7M9 7h8v8" />
  </Svg>
);
export const IconArrowRight = (p) => (
  <Svg {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
);
export const IconArrowDown = (p) => (
  <Svg {...p}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </Svg>
);
export const IconArrowUp = (p) => (
  <Svg {...p}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Svg>
);
export const IconCheck = (p) => (
  <Svg strokeWidth={2.2} {...p}>
    <path d="m5 12.5 4.2 4.2L19 7" />
  </Svg>
);
export const IconX = (p) => (
  <Svg strokeWidth={2.2} {...p}>
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </Svg>
);
export const IconAlert = (p) => (
  <Svg {...p}>
    <path d="M12 3.8 2.9 19.5h18.2L12 3.8Z" />
    <path d="M12 10v4.2M12 17.1v.1" />
  </Svg>
);
export const IconQuestion = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.6 9.3a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.7-.9 1.3v.4M12 16.8v.1" />
  </Svg>
);
export const IconFile = (p) => (
  <Svg {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
    <path d="M14 3v5h5M9 13h6M9 17h4" />
  </Svg>
);
export const IconHash = (p) => (
  <Svg {...p}>
    <path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />
  </Svg>
);
export const IconRing = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="4" r="1.9" fill="currentColor" stroke="none" />
    <circle cx="19" cy="15.6" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="6.2" cy="17.7" r="1.4" fill="currentColor" stroke="none" />
  </Svg>
);
export const IconServer = (p) => (
  <Svg {...p}>
    <rect x="3.5" y="4" width="17" height="7" rx="2.2" />
    <rect x="3.5" y="13" width="17" height="7" rx="2.2" />
    <path d="M7.5 7.5h.01M7.5 16.5h.01" strokeWidth={2.6} />
  </Svg>
);
export const IconCopy = (p) => (
  <Svg {...p}>
    <rect x="8.5" y="8.5" width="12" height="12" rx="2.4" />
    <path d="M15.5 8.5V6a2.4 2.4 0 0 0-2.4-2.4H6A2.4 2.4 0 0 0 3.6 6v7.1A2.4 2.4 0 0 0 6 15.5h2.5" />
  </Svg>
);
export const IconLayers = (p) => (
  <Svg {...p}>
    <path d="m12 3.5 8.5 4.6L12 12.7 3.5 8.1 12 3.5Z" />
    <path d="m3.5 12 8.5 4.6 8.5-4.6M3.5 15.9l8.5 4.6 8.5-4.6" />
  </Svg>
);
export const IconEye = (p) => (
  <Svg {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="2.8" />
  </Svg>
);
export const IconPulse = (p) => (
  <Svg {...p}>
    <path d="M3 12h4l2.2-5.5 4.4 11 2.2-5.5H21" />
  </Svg>
);
export const IconUnlink = (p) => (
  <Svg {...p}>
    <path d="M9.5 7H7.6a5 5 0 0 0 0 10h1.9M14.5 7h1.9a5 5 0 0 1 0 10h-1.9M8 12h1.6M14.4 12H16M12 3.5v2M12 18.5v2" />
  </Svg>
);
export const IconZap = (p) => (
  <Svg {...p}>
    <path d="M13.2 2.8 4.5 13.6h6.6l-1 7.6 8.7-10.8h-6.6l1-7.6Z" />
  </Svg>
);
export const IconShield = (p) => (
  <Svg {...p}>
    <path d="M12 3.2 19.5 6v5.6c0 4.6-3.1 7.8-7.5 9.2-4.4-1.4-7.5-4.6-7.5-9.2V6L12 3.2Z" />
    <path d="m8.9 12 2.2 2.2 4-4.3" />
  </Svg>
);
export const IconSync = (p) => (
  <Svg {...p}>
    <path d="M19.8 12.5a7.9 7.9 0 0 1-14 4.5M4.2 11.5a7.9 7.9 0 0 1 14-4.5" />
    <path d="M18.6 3.2V7h-3.8M5.4 20.8V17h3.8" />
  </Svg>
);
export const IconShuffle = (p) => (
  <Svg {...p}>
    <path d="M4 7.5h12.5M13.5 4.2l3.3 3.3-3.3 3.3M20 16.5H7.5M10.5 13.2l-3.3 3.3 3.3 3.3" />
  </Svg>
);
export const IconRadio = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="1.9" />
    <path d="M8 8a5.7 5.7 0 0 0 0 8M16 8a5.7 5.7 0 0 1 0 8M5.2 5.2a9.6 9.6 0 0 0 0 13.6M18.8 5.2a9.6 9.6 0 0 1 0 13.6" />
  </Svg>
);
export const IconWrench = (p) => (
  <Svg {...p}>
    <path d="M14.8 3.6a5 5 0 0 0-4.6 6.9l-6.4 6.4a1.9 1.9 0 0 0 2.7 2.7l6.4-6.4a5 5 0 0 0 6.9-4.6l-3 3-3-.9-.9-3 3-3.1Z" />
  </Svg>
);
export const IconScan = (p) => (
  <Svg {...p}>
    <circle cx="10.8" cy="10.8" r="6.3" />
    <path d="m15.5 15.5 5 5M8.2 10.8h5.2" />
  </Svg>
);
export const IconPlay = (p) => (
  <Svg {...p}>
    <path d="M7.5 5.2v13.6L19 12 7.5 5.2Z" fill="currentColor" />
  </Svg>
);
export const IconPause = (p) => (
  <Svg strokeWidth={2.4} {...p}>
    <path d="M8.5 5.5v13M15.5 5.5v13" />
  </Svg>
);
export const IconPower = (p) => (
  <Svg {...p}>
    <path d="M12 3.5v8M6.6 6.8a7.6 7.6 0 1 0 10.8 0" />
  </Svg>
);
export const IconTerminal = (p) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4" />
  </Svg>
);
export const IconSliders = (p) => (
  <Svg {...p}>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="17" r="2" />
  </Svg>
);
export const IconBookmark = (p) => (
  <Svg {...p}>
    <path d="M6.5 3.5h11v17L12 16.8l-5.5 3.7v-17Z" />
  </Svg>
);
export const IconInfo = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5M12 7.8v.1" />
  </Svg>
);
export const IconBox = (p) => (
  <Svg {...p}>
    <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
    <path d="m4 7.5 8 4.5 8-4.5M12 12v9" />
  </Svg>
);
export const IconDot = (p) => (
  <Svg stroke="none" {...p}>
    <circle cx="12" cy="12" r="5" fill="currentColor" />
  </Svg>
);
export const IconPen = (p) => (
  <Svg {...p}>
    <path d="m14.5 5.5 4 4M4 20l1-5L15.8 4.2a1.8 1.8 0 0 1 2.6 0l1.4 1.4a1.8 1.8 0 0 1 0 2.6L9 19l-5 1Z" />
  </Svg>
);

export function IconDownload(props) {
  return (
    <Svg {...props}>
      <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M4.5 19.5h15" />
    </Svg>
  );
}

export function IconRotate(props) {
  return (
    <Svg {...props}>
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 4v5h-5" />
    </Svg>
  );
}

export function IconSkull(props) {
  return (
    <Svg {...props}>
      <path d="M12 3a8 8 0 0 0-8 8c0 2.6 1.2 4.5 3 5.7V20h10v-3.3c1.8-1.2 3-3.1 3-5.7a8 8 0 0 0-8-8Z" />
      <circle cx="9" cy="11" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="15" cy="11" r="1.4" fill="currentColor" stroke="none" />
      <path d="M10.5 16h3" />
    </Svg>
  );
}

export function IconMinus(props) {
  return (
    <Svg {...props}>
      <path d="M5 12h14" />
    </Svg>
  );
}

export function IconPlus(props) {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}
