import { useEffect, useId, useRef, useState } from "react";

export function markDesktop() {
  if (typeof window !== "undefined" && window.athanorDesktop) {
    document.documentElement.classList.add("is-desktop");
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
  const [full, setFull] = useState(true);
  if (!api) return null;
  return (
    <div className="desk-chrome" role="group" aria-label="Window">
      <button type="button" className="desk-winbtn" aria-label="Minimize" onClick={() => api.minimize()}>
        <WinIcon kind="min" />
      </button>
      <button
        type="button"
        className="desk-winbtn"
        aria-label={full ? "Leave full screen" : "Full screen"}
        aria-pressed={full}
        onClick={async () => setFull(await api.toggleFullscreen())}
      >
        <WinIcon kind="full" />
      </button>
      <button type="button" className="desk-winbtn is-close" aria-label="Close" onClick={() => api.close()}>
        <WinIcon kind="close" />
      </button>
    </div>
  );
}

const INSTALL_CMD = "make install-desktop";

export function InstallDialog({ open, onClose }) {
  const titleId = useId();
  const closeRef = useRef(null);
  const [copied, setCopied] = useState(false);

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
      await navigator.clipboard.writeText(INSTALL_CMD);
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
        <p>A full-screen window. No borders.</p>
        <ul className="desk-facts">
          <li>Frameless</li>
          <li>Full screen</li>
          <li>Same cluster</li>
        </ul>
        <div className="desk-cmd">
          <code>{INSTALL_CMD}</code>
          <button type="button" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="desk-note">From the repo root.</p>
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
