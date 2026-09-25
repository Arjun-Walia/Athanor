import { Fragment, useRef } from "react";
import { clamp, useLatest, usePointerParallax, useReducedMotion, useScrollFrame } from "./hooks.js";
import {
  IconArrowDown,
  IconArrowUpRight,
  IconBox,
  IconCheck,
  IconEye,
  IconFile,
  IconLayers,
  IconRing,
  IconServer,
  IconShield,
} from "./icons.jsx";

const HEADLINE = [
  ["Storage", "that", "keeps"],
  ["its", "own", "fire", "lit."],
];
// Index of each line's first word, for the staggered rise.
const LINE_START = HEADLINE.map((_, li) => HEADLINE.slice(0, li).reduce((n, line) => n + line.length, 0));

const STATS = [
  { n: "3", label: "copies of every object", sub: "N", Icon: IconLayers },
  { n: "2", label: "acks before a write returns", sub: "W", Icon: IconCheck },
  { n: "2", label: "replicas behind every read", sub: "R", Icon: IconEye },
  { n: "64", label: "vnodes per node on the ring", sub: "", Icon: IconRing },
  { n: "5", label: "nodes in the compose topology", sub: "", Icon: IconServer },
];

// Tick marks for the dial that circles the furnace orb.
const ORB_TICKS = Array.from({ length: 72 }, (_, i) => {
  const a = (i * 5 * Math.PI) / 180;
  const long = i % 6 === 0;
  const r1 = long ? 88 : 92;
  const r2 = 97;
  const f = (n) => Math.round(n * 100) / 100;
  return (
    <line
      key={i}
      x1={f(100 + r1 * Math.sin(a))}
      y1={f(100 - r1 * Math.cos(a))}
      x2={f(100 + r2 * Math.sin(a))}
      y2={f(100 - r2 * Math.cos(a))}
      className={long ? "is-long" : undefined}
    />
  );
});

const DIAL_TICKS = Array.from({ length: 40 }, (_, i) => {
  const a = (i * 9 * Math.PI) / 180;
  const f = (n) => Math.round(n * 100) / 100;
  return (
    <line
      key={i}
      x1={f(50 + 38 * Math.sin(a))}
      y1={f(50 - 38 * Math.cos(a))}
      x2={f(50 + 43 * Math.sin(a))}
      y2={f(50 - 43 * Math.cos(a))}
    />
  );
});

export default function Hero() {
  const rootRef = useRef(null);
  const reduced = useReducedMotion();
  const reducedRef = useLatest(reduced);
  const lastP = useRef(-1);

  usePointerParallax(rootRef, !reduced);

  useScrollFrame(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const rect = el.getBoundingClientRect();
    const p = reducedRef.current ? 0 : clamp(-rect.top / Math.max(1, rect.height));
    const q = Math.round(p * 1000) / 1000;
    if (q === lastP.current) return undefined;
    lastP.current = q;
    return () => el.style.setProperty("--hp", String(q));
  });

  return (
    <section className="ln-hero" id="top" ref={rootRef} aria-labelledby="ln-hero-title">
      <div className="ln-hero-inner">
        <div className="ln-hero-copy">
          <p className="ln-hero-tags">
            <span className="chip outline">
              <IconBox size="0.95rem" /> Source on GitHub · written in Go
            </span>
            <span className="chip yellow">N 3 · W 2 · R 2 by default</span>
          </p>

          <h1 id="ln-hero-title" className="ln-h1">
            <span className="sr-only">Storage that keeps its own fire lit.</span>
            {HEADLINE.map((line, li) => (
              <span key={li} className="ln-h1-line" aria-hidden="true">
                {line.map((w, wi) => (
                  <Fragment key={w}>
                    {wi > 0 ? " " : null}
                    <span className="ln-word">
                      <span
                        className={w === "fire" ? "ln-word-in ln-fire" : "ln-word-in"}
                        style={{ "--i": LINE_START[li] + wi }}
                      >
                        {w}
                      </span>
                    </span>
                  </Fragment>
                ))}
              </span>
            ))}
          </h1>

          <p className="ln-lede">
            Athanor is a fault-tolerant object store. Each object is copied to three nodes, each copy carries a SHA-256,
            and when a node dies or a byte rots, the cluster notices and puts it right. The dashboard lets you watch it
            happen.
          </p>

          <div className="ln-hero-ctas">
            <a className="ln-btn ln-btn-dark ln-btn-lg" href="/app">
              Open the dashboard <IconArrowUpRight size="1.1rem" />
            </a>
            <a className="ln-btn ln-btn-ghost ln-btn-lg" href="#story">
              Follow a write through a failure <IconArrowDown size="1.1rem" />
            </a>
          </div>
        </div>

        <div className="ln-hero-visual" aria-hidden="true">
          <div className="ln-orb-wrap">
            <div className="ln-orb-halo" />
            <div className="ln-orb">
              <span className="ln-orb-shimmer" />
              <span className="ln-orb-core" />
            </div>
            <svg className="ln-orb-ring" viewBox="0 0 200 200" focusable="false">
              <g className="ln-orb-ring-spin">
                {ORB_TICKS}
                <circle cx="100" cy="100" r="80" className="ln-orb-arc" pathLength="100" />
              </g>
            </svg>
          </div>

          <div className="ln-frag ln-frag-node" style={{ "--d": 0.65 }}>
            <div className="ln-frag-in" style={{ "--i": 0 }}>
              <div className="ln-frag-body surface-card ln-fcard">
                <div className="ln-fcard-head">
                  <span className="ln-fcard-icon">
                    <IconServer size="1.05rem" />
                  </span>
                  <span className="ln-fcard-title">node1</span>
                  <span className="chip dark">
                    <IconCheck size="0.8rem" /> alive
                  </span>
                </div>
                <div className="ln-fcard-row">
                  <span>vnodes</span>
                  <span className="ln-fcard-num num">64</span>
                </div>
                <div className="ln-fcard-bars">
                  <span className="is-dark" />
                  <span className="is-yellow" />
                  <span className="is-hatch hatched" />
                  <span className="is-outline" />
                </div>
              </div>
            </div>
          </div>

          <div className="ln-frag ln-frag-quorum" style={{ "--d": 1.15 }}>
            <div className="ln-frag-in" style={{ "--i": 1 }}>
              <div className="ln-frag-body ln-qpill">
                <span className="is-dark">
                  N <b>3</b>
                </span>
                <span className="is-yellow">
                  W <b>2</b>
                </span>
                <span className="is-hatch hatched">
                  R <b>2</b>
                </span>
              </div>
            </div>
          </div>

          <div className="ln-frag ln-frag-replicas" style={{ "--d": 0.9 }}>
            <div className="ln-frag-in" style={{ "--i": 2 }}>
              <div className="ln-frag-body surface-card ln-rcard">
                <span className="ln-rcard-file">
                  <IconFile size="1rem" /> report.pdf
                </span>
                <span className="ln-rcard-dots">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <span key={n} className={n <= 3 ? "is-on" : undefined}>
                      <i />
                      n{n}
                    </span>
                  ))}
                </span>
              </div>
            </div>
          </div>

          <div className="ln-frag ln-frag-sum" style={{ "--d": 1.4 }}>
            <div className="ln-frag-in" style={{ "--i": 3 }}>
              <div className="ln-frag-body ln-sumchip">
                <span className="ln-sumchip-icon">
                  <IconShield size="1.05rem" />
                </span>
                <span>
                  <b>SHA-256 match</b>
                  <code>6466e450…fe01b15</code>
                </span>
              </div>
            </div>
          </div>

          <div className="ln-frag ln-frag-dial" style={{ "--d": 0.4 }}>
            <div className="ln-frag-in" style={{ "--i": 4 }}>
              <div className="ln-frag-body ln-dialcard surface-card">
                <svg viewBox="0 0 100 100" focusable="false">
                  <g className="ln-dial-ticks">{DIAL_TICKS}</g>
                  <circle cx="50" cy="50" r="31" className="ln-dial-track" />
                  <circle cx="50" cy="50" r="31" className="ln-dial-arc" pathLength="100" />
                </svg>
                <span className="ln-dialcard-text">
                  <b className="num">3.0×</b>
                  <span>storage</span>
                </span>
              </div>
            </div>
          </div>

          <div className="ln-frag ln-frag-log" style={{ "--d": 0.95 }}>
            <div className="ln-frag-in" style={{ "--i": 5 }}>
              <div className="ln-frag-body ln-logpill">
                <span className="ln-logpill-icon">
                  <IconCheck size="0.85rem" />
                </span>
                node3 repaired from node1
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="ln-hero-foot">
        <ul className="ln-stats" aria-label="Defaults in the design">
          {STATS.map(({ n, label, sub, Icon }) => (
            <li key={label} className="ln-stat">
              <span className="ln-stat-icon">
                <Icon size="1rem" />
              </span>
              <span className="ln-stat-n num">
                {n}
                {sub ? <small>{sub}</small> : null}
              </span>
              <span className="ln-stat-label">{label}</span>
            </li>
          ))}
        </ul>
        <p className="ln-hero-caption">
          The floating pieces are drawn from the dashboard to show what it looks like. They are not live data.
        </p>
      </div>
    </section>
  );
}
