import { useLayoutEffect, useRef } from "react";
import { useActiveSection, useScrollFrame } from "./hooks.js";
import { IconArrowUpRight, IconBrand, IconGithub } from "./icons.jsx";
import { REPO_URL } from "./site.js";

const SECTIONS = [
  ["story", "Story"],
  ["design", "Design"],
  ["quorum", "Quorum"],
  ["build", "Build"],
  ["start", "Start"],
];
const SECTION_IDS = SECTIONS.map(([id]) => id);

export default function Nav() {
  const active = useActiveSection(SECTION_IDS);
  const headerRef = useRef(null);
  const groupRef = useRef(null);
  const indicatorRef = useRef(null);
  const scrolled = useRef(false);

  // Compact, frosted bar once the page has moved. Written straight to the
  // DOM: no React render for a scroll-driven flag.
  useScrollFrame((frame) => {
    const next = frame.y > 24;
    if (next === scrolled.current) return undefined;
    scrolled.current = next;
    return () => headerRef.current?.toggleAttribute("data-scrolled", next);
  });

  // The dark pill slides to whichever section is under the reading line.
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
        <a className="brand-pill ln-brand" href="#top" aria-label="Athanor, back to top">
          <IconBrand size="1.05em" className="ln-brand-glyph" />
          Athanor
        </a>

        <nav className="ln-nav-sections" aria-label="Page sections">
          <div className="pill-group ln-nav-group" ref={groupRef}>
            <span className="ln-nav-indicator" ref={indicatorRef} aria-hidden="true" />
            {SECTIONS.map(([id, label]) => (
              <a
                key={id}
                href={`#${id}`}
                data-section={id}
                className="pill-btn ln-nav-link"
                aria-current={active === id ? "true" : undefined}
              >
                {label}
              </a>
            ))}
          </div>
        </nav>

        <div className="ln-nav-actions">
          <a className="icon-btn ln-nav-gh" href={REPO_URL} aria-label="Athanor source on GitHub">
            <IconGithub size="1.3rem" />
          </a>
          <a className="ln-btn ln-btn-dark ln-nav-cta" href="/app">
            <span className="ln-nav-cta-long">Open dashboard</span>
            <span className="ln-nav-cta-short">Dashboard</span>
            <IconArrowUpRight size="1.05rem" />
          </a>
        </div>
      </div>
    </header>
  );
}
