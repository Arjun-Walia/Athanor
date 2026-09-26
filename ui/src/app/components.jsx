// Small building blocks shared by every dashboard page: node colours,
// status badges, replica dots, cards, menus, toasts. Nothing here talks to
// the API; pages pass data in.

import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./icons.jsx";

// Warm neutrals and furnace tones, one per node, in ring-sorted order.
const NODE_TONES = ["#2c2c2a", "#e9b820", "#8f8a7e", "#5b6573", "#c7a26b", "#46604f", "#b8613f", "#7c6d99", "#4d7f8e"];

const LIGHT_TONES = new Set(["#e9b820", "#c7a26b", "#8f8a7e"]);

export function nodeTone(id, all) {
  const sorted = [...(all || [])].sort();
  const i = Math.max(0, sorted.indexOf(id));
  return NODE_TONES[i % NODE_TONES.length];
}

/** Text colour that stays readable on a node tone. */
export function inkOn(tone) {
  return LIGHT_TONES.has(tone) ? "#1d1d1b" : "#f7f5ee";
}

const STATUS = {
  alive: { label: "Alive", icon: "Check", tone: "alive" },
  suspect: { label: "Suspect", icon: "Alert", tone: "suspect" },
  dead: { label: "Dead", icon: "X", tone: "dead" },
  stopped: { label: "Stopped", icon: "Stop", tone: "stopped" },
  unknown: { label: "Unknown", icon: "Info", tone: "unknown" },
};

export function statusMeta(status) {
  return STATUS[status] || STATUS.unknown;
}

/** Node status as a word, an icon, and a colour. */
export function StatusBadge({ status, partitioned, compact = false }) {
  const meta = statusMeta(status);
  const I = Icon[meta.icon];
  return (
    <span className={`ath-status is-${meta.tone}${compact ? " is-compact" : ""}`}>
      <span className="ath-status-dot" aria-hidden="true">
        <I size={11} strokeWidth={2.6} />
      </span>
      <span>{meta.label}</span>
      {partitioned ? (
        <span className="ath-status-extra" title="Partitioned from this coordinator">
          <Icon.Scissors size={12} /> cut
        </span>
      ) : null}
    </span>
  );
}

export const REPLICA = {
  ok: { label: "Verified replica", short: "ok", icon: "Check" },
  hint: { label: "Hint parked", short: "hint", icon: "Clock" },
  stale: { label: "Stale version", short: "stale", icon: "Refresh" },
  missing: { label: "Missing", short: "missing", icon: "X" },
  tampered: { label: "Byte flipped, not caught yet", short: "flipped", icon: "Zap" },
  unreachable: { label: "Unreachable", short: "no answer", icon: "Info" },
  extra: { label: "Extra copy, rebalance pending", short: "extra", icon: "Layers" },
  corrupt: { label: "Checksum mismatch", short: "corrupt", icon: "ShieldAlert" },
};

/** One replica: a dot with an icon inside, so status is never colour alone. */
export function ReplicaDot({ replica, size = "md" }) {
  const meta = REPLICA[replica.status] || REPLICA.unreachable;
  const I = Icon[meta.icon];
  const title = replica.node
    ? `${replica.node}: ${meta.label}${replica.hint_for ? ` for ${replica.hint_for}` : ""}${replica.preferred === false ? " (not an owner)" : ""}`
    : meta.label;
  return (
    <span className={`ath-rdot is-${replica.status} is-${size}`} title={title}>
      <I size={size === "sm" ? 9 : 11} strokeWidth={2.6} aria-hidden="true" />
      <span className="sr-only">{title}</span>
    </span>
  );
}

export function Card({ as: Tag = "section", className = "", children, ...rest }) {
  return (
    <Tag className={`ath-card ${className}`} {...rest}>
      {children}
    </Tag>
  );
}

export function CardHead({ title, children, level = 2 }) {
  const H = `h${level}`;
  return (
    <header className="ath-card-head">
      <H className="ath-card-title">{title}</H>
      {children ? <div className="ath-card-tools">{children}</div> : null}
    </header>
  );
}

export function CornerLink({ onClick, label }) {
  return (
    <button type="button" className="icon-btn ath-corner" onClick={onClick} aria-label={label} title={label}>
      <Icon.ArrowUpRight size={18} />
    </button>
  );
}

/**
 * A small popover menu. Closes on outside click and Escape; the arrow keys
 * move between items, Home/End jump, and focus returns to the button on
 * close, as the WAI-ARIA menu button pattern asks.
 */
export function Menu({ label, icon = "More", children, align = "end", buttonClass = "ath-menu-btn", disabled }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const buttonRef = useRef(null);
  const popRef = useRef(null);
  const id = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    // Focus the first item once the popover is in the DOM.
    const raf = window.requestAnimationFrame(() => popRef.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus());
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.cancelAnimationFrame(raf);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const onKeyDown = (e) => {
    const items = [...(popRef.current?.querySelectorAll('[role="menuitem"]:not(:disabled)') ?? [])];
    const i = items.indexOf(document.activeElement);
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        close();
        break;
      case "ArrowDown":
        e.preventDefault();
        items[(i + 1) % items.length]?.focus();
        break;
      case "ArrowUp":
        e.preventDefault();
        items[(i - 1 + items.length) % items.length]?.focus();
        break;
      case "Home":
        e.preventDefault();
        items[0]?.focus();
        break;
      case "End":
        e.preventDefault();
        items[items.length - 1]?.focus();
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
    }
  };

  const I = Icon[icon];
  return (
    <div className={`ath-menu is-${align}`} ref={ref}>
      <button
        ref={buttonRef}
        type="button"
        className={buttonClass}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <I size={18} />
      </button>
      {open ? (
        <div
          className="ath-menu-pop"
          role="menu"
          id={id}
          tabIndex={-1}
          ref={popRef}
          onKeyDown={onKeyDown}
          // Choosing an item closes the menu; a form inside it (the token
          // field) keeps it open.
          onClick={(e) => {
            if (e.target.closest('[role="menuitem"]')) setOpen(false);
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function MenuItem({ icon, children, onSelect, tone, disabled }) {
  const I = icon ? Icon[icon] : null;
  return (
    <button type="button" role="menuitem" className={`ath-menu-item${tone ? ` is-${tone}` : ""}`} onClick={onSelect} disabled={disabled}>
      {I ? <I size={16} /> : null}
      <span>{children}</span>
    </button>
  );
}

export function MenuLabel({ children }) {
  return <div className="ath-menu-label">{children}</div>;
}

/** Collapsible row with a dotted rule, as in the reference's accordion. */
export function Disclosure({ title, defaultOpen = false, children, meta }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={`ath-disclosure${open ? " is-open" : ""}`}>
      <button type="button" className="ath-disclosure-btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <span className="ath-disclosure-title">{title}</span>
        {meta ? <span className="ath-disclosure-meta">{meta}</span> : null}
        {open ? <Icon.ChevronUp size={18} /> : <Icon.ChevronDown size={18} />}
      </button>
      <div id={id} className="ath-disclosure-body" hidden={!open}>
        {children}
      </div>
    </div>
  );
}

export function Toasts({ items, onDismiss }) {
  return (
    <div className="ath-toasts" role="status" aria-live="polite">
      {items.map((t) => {
        const I = t.tone === "error" ? Icon.Alert : t.tone === "warn" ? Icon.Info : Icon.Check;
        return (
          <div key={t.id} className={`ath-toast is-${t.tone}`}>
            <span className="ath-toast-icon">
              <I size={16} />
            </span>
            <span className="ath-toast-text">{t.text}</span>
            <button type="button" className="ath-toast-x" onClick={() => onDismiss(t.id)} aria-label="Dismiss">
              <Icon.X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** A yes/no fact with a word and an icon, never colour alone. */
export function Fact({ ok, children }) {
  const I = ok ? Icon.Check : Icon.Alert;
  return (
    <span className={`ath-fact ${ok ? "is-ok" : "is-warn"}`}>
      <I size={13} strokeWidth={2.4} />
      {children}
    </span>
  );
}

export function Empty({ icon = "Box", title, children }) {
  const I = Icon[icon];
  return (
    <div className="ath-empty">
      <span className="ath-empty-icon">
        <I size={22} />
      </span>
      <p className="ath-empty-title">{title}</p>
      {children ? <p className="ath-empty-text">{children}</p> : null}
    </div>
  );
}
