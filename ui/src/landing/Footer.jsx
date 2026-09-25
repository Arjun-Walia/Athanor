import { useRef } from "react";
import { useProgress } from "./hooks.js";
import { IconArrowUp, IconArrowUpRight, IconBrand, IconGithub } from "./icons.jsx";
import { DASHBOARD_PATH, REPO_URL } from "./site.js";

const LINKS = [
  ["Source", REPO_URL, IconGithub],
  ["Design plan", `${REPO_URL}/blob/HEAD/PLAN.md`],
  ["README", `${REPO_URL}/blob/HEAD/README.md`],
  ["Releases", `${REPO_URL}/releases`],
  ["Dashboard", DASHBOARD_PATH],
];

const NOT_BUILT = ["Raft", "version vectors", "Merkle trees", "erasure coding", "S3"];

export default function Footer() {
  const ref = useRef(null);
  // The wordmark rises out of the furnace as the page ends.
  useProgress(ref, { start: 1, end: 0.4, name: "--fp" });

  return (
    <footer className="ln-footer" ref={ref}>
      <div className="ln-footer-glow" aria-hidden="true" />
      <div className="ln-footer-inner">
        <div className="ln-footer-top">
          <div className="ln-footer-brand">
            <a className="ln-brand" href="#top">
              <IconBrand size="1.15em" className="ln-brand-glyph" />
              <span>Athanor</span>
            </a>
            <p>Six phases in the plan. All of them shipped.</p>
            <p className="ln-footer-not">
              Chosen not to build: {NOT_BUILT.join(", ")}.
            </p>
          </div>
          <nav className="ln-footer-links" aria-label="Project links">
            <ul>
              {LINKS.map(([label, href, Icon]) => (
                <li key={label}>
                  <a href={href}>
                    {Icon ? <Icon size="1rem" /> : null}
                    {label}
                    <IconArrowUpRight size="0.9rem" />
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
          <p>Illustrations on this page, not live cluster data. The dashboard is live.</p>
          <a className="ln-footer-top-btn" href="#top" aria-label="Back to top">
            <IconArrowUp size="1.1rem" />
          </a>
        </div>
      </div>
    </footer>
  );
}
