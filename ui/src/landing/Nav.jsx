import { useLayoutEffect, useRef } from "react";
import { useActiveSection, useScrollFrame } from "./hooks.js";
import { IconArrowUpRight, IconBrand, IconGithub } from "./icons.jsx";
import { InstallButton } from "../shell.jsx";
import { DASHBOARD_PATH, REPO_URL, SECTIONS } from "./site.js";

const SECTION_IDS = SECTIONS.map(([id]) => id);

/**
 * A floating pill. Transparent over the hero, frosted once the page has
 * moved. A dark indicator slides under whichever section is being read.
 */
export default function Nav() {
  const active = useActiveSection(SECTION_IDS);
  const headerRef = useRef(null);
  const groupRef = useRef(null);
  const indicatorRef = useRef(null);
  const scrolled = useRef(false);

  useScrollFrame((frame) => {
    const next = frame.y > 32;
    if (next === scrolled.current) return undefined;
    scrolled.current = next;
    return () => headerRef.current?.toggleAttribute("data-scrolled", next);
  });

  useLayoutEffect(() => {
    const group = groupRef.current;
    const indicator = indicatorRef.current;
    if (!group || !indicator) return undefined;
    const place = () => {
      const link = active ? group.querySelector(`[data-section="${active}"]`) : null;
      if (!link) {
        indicator.style.opacity = "0";
        return;
      }
      indicator.style.opacity = "1";
      indicator.style.width = `${link.offsetWidth}px`;
      indicator.style.transform = `translateX(${link.offsetLeft}px)`;
    };
    place();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    ro?.observe(group);
    return () => ro?.disconnect();
  }, [active]);

  return (
    <header className="ln-nav" ref={headerRef}>
      <div className="ln-nav-bar">
        <a className="brand ln-brand" href="#top" aria-label="Athanor, back to top">
          <IconBrand size="1.15em" className="brand-glyph" />
          <span>Athanor</span>
        </a>

        <nav className="ln-nav-sections" aria-label="Page sections">
          <div className="ln-nav-group" ref={groupRef}>
            <span className="ln-nav-indicator" ref={indicatorRef} aria-hidden="true" />
            {SECTIONS.map(([id, label]) => (
              <a key={id} href={`#${id}`} data-section={id} className="ln-nav-link" aria-current={active === id ? "true" : undefined}>
                {label}
              </a>
            ))}
          </div>
        </nav>

        <div className="ln-nav-actions">
          <a className="ln-nav-icon" href={REPO_URL} aria-label="Athanor source on GitHub">
            <IconGithub size="1.2rem" />
          </a>
          <InstallButton className="ln-btn ln-btn-ghost ln-nav-cta">Install</InstallButton>
          <a className="ln-btn ln-btn-dark ln-nav-cta" href={DASHBOARD_PATH}>
            <span className="ln-nav-cta-long">Open dashboard</span>
            <span className="ln-nav-cta-short">Dashboard</span>
            <IconArrowUpRight size="1rem" />
          </a>
        </div>
      </div>
    </header>
  );
}
