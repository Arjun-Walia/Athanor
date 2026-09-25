import { useRef, useState } from "react";
import { clamp, useLatest, useMediaQuery, useReducedMotion, useScrollFrame } from "./hooks.js";
import { IconBookmark, IconHash, IconLayers, IconPulse, IconWrench } from "./icons.jsx";

/*
 * Four steps, pinned. The ring on the left is one SVG whose state is set
 * by data-step on the section; every change is a CSS transition, so the
 * scene morphs rather than cuts as the reader moves between steps.
 */

const STEPS = [
  {
    id: "hash",
    Icon: IconHash,
    title: "A name becomes a place.",
    body: "Any node hashes the key with SHA-256. The first 64 bits are a point on a ring shared by every node. There is no central index to ask.",
    facts: ["any node coordinates", "no metadata cluster"],
  },
  {
    id: "replicate",
    Icon: IconLayers,
    title: "Walk clockwise to three owners.",
    body: "The write goes to the next three distinct nodes on the ring. The client hears back after two of them have the bytes on disk.",
    facts: ["N = 3", "W = 2", "201 after two acks"],
  },
  {
    id: "detect",
    Icon: IconPulse,
    title: "Lose a node. Keep the data.",
    body: "SWIM gossip notices the node that stopped answering. Writes route around it and park a hint on the next healthy node. Reads still find two copies.",
    facts: ["suspect, then dead", "hinted handoff", "R = 2"],
  },
  {
    id: "heal",
    Icon: IconWrench,
    title: "Catch the bad byte. Push the good one.",
    body: "A scrub or a read finds the copy whose checksum no longer matches. Repair(key) fetches the newest verified version and rewrites the bad replica. The node that died gets its hint back when it returns.",
    facts: ["SHA-256 on every read", "one Repair(key)", "hint replay"],
  },
];

/* ---------- ring geometry ---------- */

const SIZE = 520;
const C = SIZE / 2;
const R = 196;
const f = (n) => Math.round(n * 100) / 100;
const pt = (r, deg) => {
  const a = (deg * Math.PI) / 180;
  return [f(C + r * Math.sin(a)), f(C - r * Math.cos(a))];
};
const KEY_DEG = 141;
const NODES = [0, 1, 2, 3, 4].map((i) => {
  const deg = 162 + i * 72; // node1 sits just past the key
  const [x, y] = pt(R, deg);
  return { i, deg, x, y };
});
const arc = (r, from, to) => {
  const [x0, y0] = pt(r, from);
  const [x1, y1] = pt(r, to);
  return `M${x0} ${y0} A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1} ${y1}`;
};
const KEY = pt(R, KEY_DEG);
const KEY_IN = pt(R - 44, KEY_DEG);
const WALK = arc(R, KEY_DEG, NODES[2].deg);
const spoke = (i) => `M${C} ${C} L${NODES[i].x} ${NODES[i].y}`;
const link = (a, b) => `M${NODES[a].x} ${NODES[a].y} L${NODES[b].x} ${NODES[b].y}`;

function Scene({ step }) {
  return (
    <svg className="ln-how-ring" viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true" focusable="false" data-step={step}>
      <circle cx={C} cy={C} r={R} className="ln-how-track" />
      <circle
        cx={C}
        cy={C}
        r={R}
        className="ln-how-vnodes"
        strokeDasharray={`1.6 ${f((2 * Math.PI * R) / 60 - 1.6)}`}
        transform={`rotate(-90 ${C} ${C})`}
      />
      {/* step 0: the key lands on the ring */}
      <path className="ln-how-keypath" d={`M${C} ${C} L${KEY[0]} ${KEY[1]}`} />
      <circle className="ln-how-obj" cx={C} cy={C} r="11" />
      <text className="ln-how-objlabel" x={C} y={C + 32}>
        report.pdf
      </text>
      <circle className="ln-how-key" cx={KEY[0]} cy={KEY[1]} r="8" />
      <text className="ln-how-keylabel" x={KEY_IN[0]} y={KEY_IN[1]} dy="0.35em">
        141°
      </text>
      {/* step 1: the clockwise walk */}
      <path className="ln-how-walk" d={WALK} pathLength="100" />
      {[0, 1, 2].map((i) => (
        <path key={`w-${i}`} className="ln-how-spoke is-write" d={spoke(i)} pathLength="100" style={{ "--i": i }} />
      ))}
      {/* step 2: hint to node4 */}
      <path className="ln-how-spoke is-hint" d={spoke(3)} pathLength="100" />
      {/* step 3: repair node3 from node1, hint back to node2 */}
      <path className="ln-how-link is-repair" d={link(0, 2)} pathLength="100" />
      <path className="ln-how-link is-return" d={link(3, 1)} pathLength="100" />
      {NODES.map((n) => (
        <g key={n.i} className="ln-how-node" style={{ "--i": n.i }} transform={`translate(${n.x} ${n.y})`}>
          <circle r="28" className="ln-how-node-ring" />
          <circle r="20" className="ln-how-node-body" />
          <text dy="0.36em" className="ln-how-node-label">
            n{n.i + 1}
          </text>
          <g className="ln-how-node-badge" transform="translate(18 -18)">
            <circle r="9" />
            <text dy="0.35em" className="ln-how-node-badge-text">
              {n.i + 1}
            </text>
          </g>
          <g className="ln-how-node-mark">
            <path d="M-5 0l3.5 3.5 7-7" className="is-ok" />
            <path d="M-4.5-4.5l9 9M4.5-4.5l-9 9" className="is-x" />
            <path d="M-4.5 2.5l4.5-7 4.5 7z" className="is-flip" />
          </g>
        </g>
      ))}
      <g className="ln-how-caption">
        <rect x={C - 118} y={SIZE - 46} width="236" height="30" rx="15" />
        {["hash → 141° on the ring", "owners n1, n2, n3 · acked by two", "n2 is dead · hint parked on n4", "n3 healed from n1 · n2 gets its hint"].map((t, i) => (
          <text key={i} x={C} y={SIZE - 26} className="ln-how-caption-text" style={{ "--i": i }}>
            {t}
          </text>
        ))}
      </g>
    </svg>
  );
}

/* ---------- section ---------- */

export default function HowItWorks() {
  const [step, setStep] = useState(0);
  const stepRef = useRef(0);
  const listRef = useRef(null);
  const itemRefs = useRef([]);
  const wide = useLatest(useMediaQuery("(min-width: 64rem)"));
  const reduced = useLatest(useReducedMotion());
  const lastP = useRef(-1);

  useScrollFrame((frame) => {
    const list = listRef.current;
    if (!list) return undefined;
    const box = list.getBoundingClientRect();
    if (box.bottom < -frame.vh || box.top > frame.vh * 2) return undefined;
    const focus = wide.current ? frame.vh * 0.5 : frame.vh * 0.72;
    let active = 0;
    let p = 0;
    itemRefs.current.forEach((el, i) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.top <= focus) {
        active = i;
        p = clamp((focus - r.top) / Math.max(1, r.height));
      }
    });
    const s = reduced.current ? active : Math.round((active + p) * 500) / 500;
    if (s === lastP.current) return undefined;
    lastP.current = s;
    return () => {
      list.parentElement?.style.setProperty("--s", String(s));
      if (active !== stepRef.current) {
        stepRef.current = active;
        setStep(active);
      }
    };
  });

  return (
    <section className="ln-how" id="how" aria-labelledby="ln-how-title">
      <header className="ln-how-head">
        <p className="ln-eyebrow">How it works</p>
        <h2 id="ln-how-title" className="ln-h2">
          One file, on a bad day.
        </h2>
      </header>

      <div className="ln-how-body">
        <div className="ln-how-stage">
          <div className="ln-how-count" aria-hidden="true">
            <span className="num">0{step + 1}</span>
            <span className="ln-how-count-of"> / 04</span>
          </div>
          <Scene step={step} />
          <p className="ln-how-note">Illustration. The dashboard shows the real ring.</p>
        </div>

        <ol className="ln-how-steps" ref={listRef}>
          {STEPS.map(({ id, Icon, title, body, facts }, i) => (
            <li
              key={id}
              className={`ln-how-step${i === step ? " is-active" : ""}`}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
            >
              <span className="ln-how-step-icon">
                <Icon size="1.1rem" />
              </span>
              <p className="ln-how-step-num num">0{i + 1}</p>
              <h3 className="ln-how-step-title">{title}</h3>
              <p className="ln-how-step-body">{body}</p>
              <ul className="ln-how-step-facts" aria-label="Key terms">
                {facts.map((fact) => (
                  <li key={fact}>{fact}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
