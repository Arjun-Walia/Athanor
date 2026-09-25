import { useEffect, useId, useRef, useState } from "react";

// The desktop shell (desktop/main.cjs) exposes window.athanorDesktop through
// its preload script. When it is present the page is running inside the
// frameless Electron window and draws its own window controls.

export function markDesktop() {
  if (typeof window !== "undefined" && window.athanorDesktop) {
    const root = document.documentElement;
    root.classList.add("is-desktop");
    root.dataset.platform = window.athanorDesktop.platform || "";
  }
}

markDesktop();

function desktop() {
  return typeof window !== "undefined" ? window.athanorDesktop : null;
}

function WinIcon({ kind }) {
  if (kind === "min") {
    return (
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <path d="M5 12.5h14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === "full") {
    return (
      <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
        <rect x="5" y="5" width="14" height="14" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <path d="M7 7l10 10M17 7 7 17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function DesktopChrome() {
  const api = desktop();
  const [full, setFull] = useState(() => Boolean(api?.isFullscreen?.()));
  useEffect(() => {
    if (!api?.onFullscreen) return undefined;
    return api.onFullscreen(setFull);
  }, [api]);
  if (!api) return null;
  // macOS draws its own traffic lights (hiddenInset); only the fullscreen
  // toggle is ours there.
  const mac = api.platform === "darwin";
  return (
    <div className="desk-chrome" role="group" aria-label="Window">
      {mac ? null : (
        <button type="button" className="desk-winbtn" aria-label="Minimize" onClick={() => api.minimize()}>
          <WinIcon kind="min" />
        </button>
      )}
      <button
        type="button"
        className="desk-winbtn"
        aria-label={full ? "Leave full screen" : "Full screen"}
        aria-pressed={full}
        onClick={async () => setFull(await api.toggleFullscreen())}
      >
        <WinIcon kind="full" />
      </button>
      {mac ? null : (
        <button type="button" className="desk-winbtn is-close" aria-label="Close" onClick={() => api.close()}>
          <WinIcon kind="close" />
        </button>
      )}
    </div>
  );
}

// Installers are published on GitHub Releases by the desktop CI job. The
// "latest" links resolve to the newest tagged build for each platform.
const RELEASES = "https://github.com/Arjun-Walia/Athanor/releases";
const LATEST = `${RELEASES}/latest/download`;

const DOWNLOADS = [
  { id: "mac", name: "macOS", note: "Apple silicon and Intel · .dmg", href: `${LATEST}/Athanor-mac-universal.dmg` },
  { id: "win", name: "Windows", note: "64-bit installer · .exe", href: `${LATEST}/Athanor-win-x64.exe` },
  { id: "linux", name: "Linux", note: "AppImage · runs anywhere", href: `${LATEST}/Athanor-linux-x86_64.AppImage` },
];

function guessPlatform() {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/Mac/i.test(ua)) return "mac";
  if (/Win/i.test(ua)) return "win";
  if (/Linux/i.test(ua)) return "linux";
  return null;
}

const BUILD_CMD = "make desktop";

export function InstallDialog({ open, onClose }) {
  const titleId = useId();
  const closeRef = useRef(null);
  const [copied, setCopied] = useState(false);
  const mine = guessPlatform();

  useEffect(() => {
    if (!open) return undefined;
    setCopied(false);
    const prev = document.activeElement;
    closeRef.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      if (prev instanceof HTMLElement) prev.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(BUILD_CMD);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      className="desk-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="desk-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <button ref={closeRef} type="button" className="desk-x" onClick={onClose} aria-label="Close">
          <WinIcon kind="close" />
        </button>
        <div className="desk-preview" aria-hidden="true">
          <span className="desk-preview-orb" />
        </div>
        <p className="desk-kicker">Desktop</p>
        <h2 id={titleId}>Install Athanor</h2>
        <p>The dashboard as a frameless app. It finds a local cluster first and falls back to the public one.</p>
        <ul className="desk-downloads">
          {DOWNLOADS.map((d) => (
            <li key={d.id}>
              <a className={`desk-download${mine === d.id ? " is-mine" : ""}`} href={d.href}>
                <span className="desk-download-name">
                  {d.name}
                  {mine === d.id ? <span className="desk-download-tag">this device</span> : null}
                </span>
                <span className="desk-download-note">{d.note}</span>
              </a>
            </li>
          ))}
        </ul>
        <p className="desk-note">
          Every build is on{" "}
          <a href={RELEASES} target="_blank" rel="noreferrer">
            GitHub Releases
          </a>
          . Or build it yourself from the repo root:
        </p>
        <div className="desk-cmd">
          <code>{BUILD_CMD}</code>
          <button type="button" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function InstallButton({ className, children }) {
  const [open, setOpen] = useState(false);
  if (desktop()) return null;
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        {children}
      </button>
      <InstallDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
