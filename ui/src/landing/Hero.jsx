import { Fragment, useRef } from "react";
import { useMagnetic, usePointerParallax, useReducedMotion } from "./hooks.js";
import { IconArrowDown, IconArrowUpRight } from "./icons.jsx";
import { InstallButton } from "../shell.jsx";
import { DASHBOARD_PATH } from "./site.js";

const HEADLINE = [
  ["Storage", "that"],
  ["heals", "itself."],
];
const LINE_START = HEADLINE.map((_, li) => HEADLINE.slice(0, li).reduce((n, line) => n + line.length, 0));

/* ---------- the ring behind the headline ---------- */

const SIZE = 600;
const C = SIZE / 2;
const R = 236;
const f = (n) => Math.round(n * 100) / 100;
const pt = (r, deg) => {
  const a = (deg * Math.PI) / 180;
  return [f(C + r * Math.sin(a)), f(C - r * Math.cos(a))];
};

// Five nodes, evenly spaced. The write lands on 1, 2 and 3; node 2 dies for
// a while and node 4 holds its hint; node 3's copy is flipped and healed.
const NODES = [0, 1, 2, 3, 4].map((i) => {
  const deg = 18 + i * 72;
  const [x, y] = pt(R, deg);
  return { i, deg, x, y, name: `n${i + 1}` };
});

const TICKS = Array.from({ length: 90 }, (_, i) => {
  const deg = i * 4;
  const long = i % 5 === 0;
  const [x1, y1] = pt(long ? R + 44 : R + 50, deg);
  const [x2, y2] = pt(R + 56, deg);
  return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className={long ? "is-long" : undefined} />;
});

function path(to) {
  const n = NODES[to];
  const mx = f((C + n.x) / 2);
  const my = f((C + n.y) / 2);
  return `M${C} ${C} Q${mx} ${my} ${n.x} ${n.y}`;
}

function pathBetween(a, b, bend = 60) {
  const p = NODES[a];
  const q = NODES[b];
  let mx = (p.x + q.x) / 2;
  let my = (p.y + q.y) / 2;
  const dx = mx - C;
  const dy = my - C;
  const len = Math.hypot(dx, dy) || 1;
  mx = f(mx + (dx / len) * bend);
  my = f(my + (dy / len) * bend);
  return `M${p.x} ${p.y} Q${mx} ${my} ${q.x} ${q.y}`;
}

// Each packet is a CSS animation along an offset-path, timed on a shared
// 12-second loop (see .ln-hero-pk in landing.css).
const PACKETS = [
  { id: "w1", d: path(0), kind: "write", delay: 0.6 },
  { id: "w2", d: path(1), kind: "write", delay: 0.75 },
  { id: "w3", d: path(2), kind: "write", delay: 0.9 },
  { id: "h4", d: path(3), kind: "hint", delay: 5.2 },
  { id: "r3", d: pathBetween(0, 2), kind: "repair", delay: 7.6 },
  { id: "b2", d: pathBetween(3, 1), kind: "hint", delay: 9.8 },
];

function Ring() {
  return (
    <svg className="ln-hero-ring" viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="ln-hero-core" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#fff3c2" stopOpacity="0.95" />
          <stop offset="45%" stopColor="#f6cf45" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#f6cf45" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx={C} cy={C} r={R - 30} fill="url(#ln-hero-core)" className="ln-hero-core" />
      <g className="ln-hero-ticks">{TICKS}</g>
      <circle cx={C} cy={C} r={R} className="ln-hero-track" />
      <circle cx={C} cy={C} r={R} className="ln-hero-arc" pathLength="100" />
      {NODES.map((n) => (
        <line key={`s-${n.i}`} className="ln-hero-spoke" x1={C} y1={C} x2={n.x} y2={n.y} />
      ))}
      {PACKETS.map((p) => (
        <path key={`t-${p.id}`} d={p.d} className={`ln-hero-trail is-${p.kind}`} style={{ "--d": `${p.delay}s` }} />
      ))}
      {NODES.map((n) => (
        <g key={n.i} className="ln-hero-node" style={{ "--i": n.i }} transform={`translate(${n.x} ${n.y})`}>
          <circle r="36" className="ln-hero-node-halo" />
          <circle r="27" className="ln-hero-node-body" />
          <text dy="-0.1em" className="ln-hero-node-label">
            {n.name}
          </text>
          <g className="ln-hero-node-mark">
            <path d="M-6 0l4 4 8-8" className="is-ok" />
            <path d="M-5-5l10 10M5-5l-10 10" className="is-x" />
          </g>
        </g>
      ))}
      <circle r="9" className="ln-hero-obj" cx={C} cy={C} />
      {PACKETS.map((p) => (
        <circle
          key={p.id}
          r={p.kind === "repair" ? 8 : 6.5}
          className={`ln-hero-pk is-${p.kind}`}
          style={{ "--d": `${p.delay}s`, offsetPath: `path("${p.d}")` }}
        />
      ))}
    </svg>
  );
}

/* ---------- section ---------- */

export default function Hero() {
  const rootRef = useRef(null);
  const ctaRef = useRef(null);
  const reduced = useReducedMotion();
  usePointerParallax(rootRef, !reduced);
  useMagnetic(ctaRef);

  return (
    <section className="ln-hero" id="top" ref={rootRef} aria-labelledby="ln-hero-title">
      <div className="ln-hero-glow" aria-hidden="true" />
      <div className="ln-hero-stage" aria-hidden="true">
        <Ring />
      </div>

      <div className="ln-hero-copy">
        <p className="ln-hero-kicker ln-rise" style={{ "--i": 0 }}>
          A fault-tolerant object store
        </p>
        <h1 id="ln-hero-title" className="ln-h1">
          <span className="sr-only">Storage that heals itself.</span>
          {HEADLINE.map((line, li) => (
            <span key={li} className="ln-h1-line" aria-hidden="true">
              {line.map((w, wi) => (
                <Fragment key={w}>
                  {wi > 0 ? " " : null}
                  <span className="ln-word">
                    <span className={`ln-word-in${w === "heals" ? " ln-word-mark" : ""}`} style={{ "--i": LINE_START[li] + wi + 1 }}>
                      {w}
                    </span>
                  </span>
                </Fragment>
              ))}
            </span>
          ))}
        </h1>
        <p className="ln-lede ln-rise" style={{ "--i": 5 }}>
          Three copies of every object. A node can die, a byte can flip, and the read still comes back right.
        </p>
        <div className="ln-hero-ctas ln-rise" style={{ "--i": 6 }}>
          <a className="ln-btn ln-btn-dark ln-btn-lg ln-magnet" href={DASHBOARD_PATH} ref={ctaRef}>
            Open the dashboard <IconArrowUpRight size="1.05rem" />
          </a>
          <InstallButton className="ln-btn ln-btn-ghost ln-btn-lg">Install the app</InstallButton>
        </div>
      </div>

      <a className="ln-hero-cue ln-rise" style={{ "--i": 8 }} href="#how" aria-label="Scroll to how it works">
        <span className="ln-hero-cue-line" aria-hidden="true" />
        <IconArrowDown size="1rem" />
        <span>How it works</span>
      </a>
    </section>
  );
}
