import { useRef } from "react";
import { clamp, useLatest, useReducedMotion, useScrollFrame } from "./hooks.js";
import { IconArrowUp, IconArrowUpRight, IconBrand, IconGithub } from "./icons.jsx";
import { REPO_URL } from "./site.js";

const LINKS = [
  ["Source on GitHub", REPO_URL],
  ["Design plan (PLAN.md)", `${REPO_URL}/blob/HEAD/PLAN.md`],
  ["README", `${REPO_URL}/blob/HEAD/README.md`],
  ["Dashboard", "/app"],
];

export default function Footer() {
  const ref = useRef(null);
  const lastP = useRef(-1);
  const reduced = useLatest(useReducedMotion());

  // The furnace rises behind the wordmark as the page ends.
  useScrollFrame((frame) => {
    const el = ref.current;
    if (!el) return undefined;
    const rect = el.getBoundingClientRect();
    if (rect.top > frame.vh) {
      if (lastP.current === 0) return undefined;
      lastP.current = 0;
      return () => el.style.setProperty("--fp", "0");
    }
    const p = reduced.current ? 1 : clamp((frame.vh - rect.top) / Math.max(1, Math.min(rect.height, frame.vh)));
    const q = Math.round(p * 1000) / 1000;
    if (q === lastP.current) return undefined;
    lastP.current = q;
    return () => el.style.setProperty("--fp", String(q));
  });

  return (
    <footer className="ln-footer" ref={ref}>
      <div className="ln-footer-orb" aria-hidden="true" />
      <div className="ln-footer-inner">
        <div className="ln-footer-top">
          <div className="ln-footer-brand">
            <a className="brand-pill" href="#top">
              <IconBrand size="1.05em" className="ln-brand-glyph" />
              Athanor
            </a>
            <p>The furnace that keeps every copy whole.</p>
          </div>
          <nav className="ln-footer-links" aria-label="Project links">
            <ul>
              {LINKS.map(([label, href]) => (
                <li key={label}>
                  <a href={href}>
                    {label === "Source on GitHub" ? <IconGithub size="1rem" /> : null}
                    {label}
                    <IconArrowUpRight size="0.95rem" />
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <p className="ln-footer-word" aria-hidden="true">
          Athanor
        </p>

        <div className="ln-footer-bottom">
          <p>Illustrations, not live cluster data.</p>
          <a className="icon-btn" href="#top" aria-label="Back to top">
            <IconArrowUp size="1.2rem" />
          </a>
        </div>
      </div>
    </footer>
  );
}
