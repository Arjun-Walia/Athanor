import { useEffect, useRef } from "react";
import { clamp, requestScrollFrame, useLatest, useMediaQuery, useReducedMotion, useScrollFrame } from "./hooks.js";
import {
  IconBookmark,
  IconCheck,
  IconFile,
  IconHash,
  IconInfo,
  IconLayers,
  IconPulse,
  IconQuestion,
  IconRing,
  IconScan,
  IconWrench,
  IconX,
  IconZap,
} from "./icons.jsx";

/*
 * The story is driven by one number, --s, that runs from 0 to 6 as the reader
 * scrolls through the six steps (step i covers i..i+1). JavaScript only
 * writes --s. Every packet, badge and label below reads it in CSS through a
 * small window: `.ln-w` is visible while --at <= --s < --until, and a
 * `.ln-pk` packet travels its path while --s runs from --a to --a + 1/--k.
 * So scrolling back plays the story backwards for free, and React never
 * re-renders during a scroll.
 *
 * Everything here is an illustration of the algorithm, not cluster data.
 */

/* ---------- geometry (SVG user units, viewBox 640 x 640) ---------- */

const SIZE = 640;
const C = SIZE / 2;
const R_RING = 268;
const R_NODE = 164;

const r2 = (n) => Math.round(n * 100) / 100;
const pt = (r, deg) => {
  const a = (deg * Math.PI) / 180;
  return [r2(C + r * Math.sin(a)), r2(C - r * Math.cos(a))];
};
const pct = (v) => `${((v / SIZE) * 100).toFixed(3)}%`;
const win = (at, until = 99) => ({ "--at": at, "--until": until });

// sha256("report.pdf"). Its first 64 bits, as a fraction of 2^64, put the
// key 141.16 degrees clockwise from the top of the ring. That part is real
// arithmetic; the vnode positions around it are drawn for the illustration.
const DIGEST = "6466e450a16b77b865c5829d6b6c56d9f892956475642dbeb9ccc4340fe01b15";
const KEY_DEG = 141.156;
const DIGEST_GROUPS = DIGEST.match(/.{8}/g);

// Drawn with 12 vnode ticks per node (60 in all) so the walk is visible.
const TICK_EVERY = 6;

const NODES = [0, 1, 2, 3, 4].map((i) => {
  const deg = 36 + i * 72;
  const [x, y] = pt(R_NODE, deg);
  return { i, name: `node${i + 1}`, deg, x, y };
});

const WALK_A = 1.08;
const WALK_B = 1.72;
const WALK_END = 162;
const walkAt = (deg) => r2(WALK_A + ((WALK_B - WALK_A) * (deg - KEY_DEG)) / (WALK_END - KEY_DEG));

const WALK = [
  { deg: 144, node: 0, rank: 1 },
  { deg: 150, node: 0, rank: 0 },
  { deg: 156, node: 1, rank: 2 },
  { deg: 162, node: 2, rank: 3 },
].map((w, n) => ({ ...w, n: n + 1, at: walkAt(w.deg) }));
const NEXT_AT = 1.86;

/* ---------- packets ---------- */

const CENTER = [C, C];
const at = (end) => (end === "c" ? CENTER : [NODES[end].x, NODES[end].y]);

function packet(from, to, a, b, kind, bend = 0) {
  const p0 = at(from);
  const p2 = at(to);
  let p1 = [(p0[0] + p2[0]) / 2, (p0[1] + p2[1]) / 2];
  if (bend) {
    // Bow the path away from the centre so it clears the object badge.
    const dx = p1[0] - C;
    const dy = p1[1] - C;
    const len = Math.hypot(dx, dy) || 1;
    p1 = [p1[0] + (dx / len) * bend, p1[1] + (dy / len) * bend];
  }
  p1 = p1.map(r2);
  return { p0, p1, p2, a, b, kind, id: `${kind}-${from}-${to}-${a}` };
}

const KEY_PATH = (() => {
  const p0 = CENTER;
  const p2 = pt(R_RING, KEY_DEG);
  return { p0, p1: [r2((p0[0] + p2[0]) / 2), r2((p0[1] + p2[1]) / 2)], p2, a: 0.12, b: 0.62 };
})();

const PACKETS = [
  // (c) replicate v1, then acks. node2's ack is late: after the 201.
  packet("c", 0, 2.05, 2.32, "write"),
  packet("c", 1, 2.08, 2.36, "write"),
  packet("c", 2, 2.06, 2.34, "write"),
  packet(0, "c", 2.4, 2.56, "ack"),
  packet(2, "c", 2.46, 2.62, "ack"),
  packet(1, "c", 2.74, 2.9, "ack"),
  // (d) probes to node2 go unanswered; v2 is written around it; a read.
  packet(0, 1, 3.04, 3.2, "probe"),
  packet(2, 1, 3.1, 3.27, "probe"),
  packet("c", 0, 3.6, 3.78, "write"),
  packet("c", 2, 3.61, 3.79, "write"),
  packet("c", 3, 3.62, 3.8, "hint"),
  packet("c", 0, 3.8, 3.86, "read"),
  packet("c", 2, 3.8, 3.86, "read"),
  packet(0, "c", 3.87, 3.92, "ack"),
  packet(2, "c", 3.87, 3.92, "ack"),
  // (e) Repair(key) pushes the winner from node1 to node3.
  packet(0, 2, 4.46, 4.74, "repair", 72),
  // (f) node4 replays the hint to node2.
  packet(3, 1, 5.3, 5.58, "hint", 72),
];

const pathD = ({ p0, p1, p2 }) => `M${p0[0]} ${p0[1]} Q${p1[0]} ${p1[1]} ${p2[0]} ${p2[1]}`;

function packetStyle({ p0, p1, p2, a, b }) {
  return {
    "--a": a,
    "--k": r2(1 / (b - a)),
    "--x0": p0[0],
    "--y0": p0[1],
    "--x1": p1[0],
    "--y1": p1[1],
    "--x2": p2[0],
    "--y2": p2[1],
  };
}

function arcD(r, from, to) {
  const [x0, y0] = pt(r, from);
  const [x1, y1] = pt(r, to);
  const large = to - from > 180 ? 1 : 0;
  return `M${x0} ${y0} A${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
}

const KEY_LABEL = pt(R_RING + 22, KEY_DEG - 13);

const WALK_LEN = r2((R_RING * (WALK_END - KEY_DEG) * Math.PI) / 180);

/* ---------- node overlays ---------- */

const STATUS = {
  alive: { word: "alive", Icon: IconCheck },
  suspect: { word: "suspect", Icon: IconQuestion },
  dead: { word: "dead", Icon: IconX },
};

const NODE_STATUS = [
  [["alive", -9, 99]],
  [
    ["alive", -9, 3.3],
    ["suspect", 3.3, 3.55],
    ["dead", 3.55, 5.1],
    ["alive", 5.1, 99],
  ],
  [["alive", -9, 99]],
  [["alive", -9, 99]],
  [["alive", -9, 99]],
];

// [label, at, until, tone]
const NODE_DATA = [
  [
    ["v1", 2.32, 3.78, "ver"],
    ["v2", 3.78, 99, "ver"],
  ],
  [
    ["v1", 2.36, 5.58, "ver"],
    ["v2", 5.58, 99, "ver"],
  ],
  [
    ["v1", 2.34, 3.79, "ver"],
    ["v2", 3.79, 99, "ver"],
  ],
  [["v2 · hint", 3.8, 5.58, "hint"]],
  [],
];

// [label, at, until, tone, Icon]
const NODE_ALERTS = [
  [],
  [["no reply", 3.08, 3.3, "warn", IconQuestion]],
  [
    ["bit flip", 4.12, 4.3, "warn", IconZap],
    ["bad checksum", 4.3, 4.74, "bad", IconX],
    ["healed", 4.74, 5.3, "ok", IconCheck],
  ],
  [["next in line", NEXT_AT, 3.6, "outline", IconRing]],
  [],
];

const RANK = [
  { n: 1, at: WALK[0].at },
  { n: 2, at: WALK[2].at },
  { n: 3, at: WALK[3].at },
  null,
  null,
];

/* ---------- static SVG, built once ---------- */

const RING_SVG = (
  <svg className="ln-ring-svg" viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true" focusable="false">
    <defs>
      <radialGradient id="ln-ring-core" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="#fff6cf" stopOpacity="0.95" />
        <stop offset="55%" stopColor="#f6cf45" stopOpacity="0.16" />
        <stop offset="100%" stopColor="#f6cf45" stopOpacity="0" />
      </radialGradient>
      <filter id="ln-ring-blur" x="-10%" y="-10%" width="120%" height="120%">
        <feGaussianBlur stdDeviation="7" />
      </filter>
    </defs>

    <circle cx={C} cy={C} r={236} fill="url(#ln-ring-core)" className="ln-ring-core" />
    <circle cx={C} cy={C} r={R_RING} className="ln-ring-glow ln-w" style={win(5.6)} filter="url(#ln-ring-blur)" />
    <circle cx={C} cy={C} r={R_RING} className="ln-ring-base" />
    {/* 360 hairline degree marks and 60 vnode ticks, each drawn by one dashed circle. */}
    <circle
      cx={C}
      cy={C}
      r={R_RING}
      className="ln-ring-minor"
      strokeDasharray={`0.6 ${r2((2 * Math.PI * R_RING) / 360 - 0.6)}`}
      transform={`rotate(-90 ${C} ${C})`}
    />
    <circle
      cx={C}
      cy={C}
      r={R_RING}
      className="ln-ring-ticks"
      strokeDasharray={`1.8 ${r2((2 * Math.PI * R_RING * TICK_EVERY) / 360 - 1.8)}`}
      strokeDashoffset="0.9"
      transform={`rotate(-90 ${C} ${C})`}
    />
    <circle cx={C} cy={C} r={R_NODE} className="ln-orbit" />
    {NODES.map((n) => (
      <line key={n.name} className="ln-spoke" x1={C} y1={C} x2={n.x} y2={n.y} />
    ))}

    {/* (b) the clockwise walk from the key to the third distinct node */}
    <path
      className="ln-walk ln-w"
      d={arcD(R_RING, KEY_DEG, WALK_END)}
      style={{ "--a": WALK_A, "--k": r2(1 / (WALK_B - WALK_A)), "--len": WALK_LEN, ...win(WALK_A, 2.1) }}
      strokeDasharray={WALK_LEN}
    />
    <path className="ln-walk-settled ln-w" d={arcD(R_RING, KEY_DEG, WALK_END)} style={win(2.02)} />
    <path className="ln-walk-next ln-w" d={arcD(R_RING, WALK_END, 168)} style={win(NEXT_AT, 3.62)} />
    {WALK.map((w) => {
      const [x1, y1] = pt(R_RING - 17, w.deg);
      const [x2, y2] = pt(R_RING + 17, w.deg);
      const [bx, by] = pt(R_RING + 38, w.deg);
      return (
        <g key={w.deg} className={`ln-wmark ln-w ln-pop${w.rank ? "" : " is-skip"}`} style={win(w.at)}>
          <line x1={x1} y1={y1} x2={x2} y2={y2} />
          <circle cx={bx} cy={by} r="12.5" />
          <text x={bx} y={by} dy="0.36em">
            {w.n}
          </text>
        </g>
      );
    })}

    {/* (a) the key travels from the object to its point on the ring */}
    {PACKETS.map((p) => (
      <path key={`t-${p.id}`} className={`ln-trail ln-trail-${p.kind} ln-w`} d={pathD(p)} style={win(p.a - 0.03, p.b + 0.03)} />
    ))}
    <path className="ln-trail ln-trail-key ln-w" d={pathD(KEY_PATH)} style={win(KEY_PATH.a, 1.02)} />
    <g className="ln-keypin ln-w ln-pop" style={win(KEY_PATH.b)}>
      <circle cx={KEY_PATH.p2[0]} cy={KEY_PATH.p2[1]} r="13" />
    </g>
    <text className="ln-keylabel ln-w" x={KEY_LABEL[0]} y={KEY_LABEL[1]} style={win(KEY_PATH.b)}>
      report.pdf
    </text>
    <circle className="ln-pk ln-pk-key is-stay" r="8" style={packetStyle(KEY_PATH)} />

    {PACKETS.map((p) => (
      <circle key={p.id} className={`ln-pk ln-pk-${p.kind}`} r={p.kind === "repair" ? 8.5 : 7} style={packetStyle(p)} />
    ))}
  </svg>
);

/* ---------- copy ---------- */

const STEPS = [
  {
    short: "Hash",
    title: "A name becomes a place",
    body: (
      <>
        Any node hashes <code>report.pdf</code> onto the ring.
      </>
    ),
    facts: ["SHA-256", "any node coordinates", "no central index"],
  },
  {
    short: "Walk",
    title: "Walk clockwise to three machines",
    body: (
      <>
        Clockwise to three owners. node1, node2, node3.
      </>
    ),
    facts: ["64 vnodes per node", "N = 3", "preference list"],
  },
  {
    short: "Write",
    title: "Answer after two",
    body: <>All three are written. The client returns after two.</>,
    facts: ["W = 2", "201 Created", "LWW version"],
  },
  {
    short: "Fail",
    title: "Lose a node, keep the data",
    body: <>node2 dies. node4 keeps its copy, and the read still finds two.</>,
    facts: ["SWIM gossip", "suspect → dead", "sloppy quorum", "R = 2"],
  },
  {
    short: "Heal",
    title: "Catch the flipped byte",
    body: <>A flipped byte fails its checksum. node1 pushes the good copy back.</>,
    facts: ["scrubber", "checksum mismatch", "Repair(key)"],
  },
  {
    short: "Return",
    title: "Come back whole",
    body: <>node2 returns. The hint replays, and all three copies match.</>,
    facts: ["hint replay", "ring version", "3 of 3 replicas"],
  },
];

function Row({ at: from, until, icon: Icon, tone, children }) {
  return (
    <div className={`ln-prow ln-w${tone ? ` is-${tone}` : ""}`} style={win(from, until)}>
      {Icon ? (
        <span className="ln-prow-icon">
          <Icon size="0.95rem" />
        </span>
      ) : null}
      <span className="ln-prow-text">{children}</span>
    </div>
  );
}

const PANELS = [
  {
    head: "report.pdf becomes a point on the ring",
    rows: (
      <>
        <Row icon={IconFile}>
          <span className="ln-k">key</span> <code>report.pdf</code>
        </Row>
        <Row at={0.1} icon={IconHash}>
          <span className="ln-k">sha-256</span>{" "}
          <code className="ln-digest">
            <mark>
              {DIGEST_GROUPS[0]} {DIGEST_GROUPS[1]}
            </mark>{" "}
            {DIGEST_GROUPS.slice(2).join(" ")}
          </code>
        </Row>
        <Row at={KEY_PATH.b} icon={IconRing}>
          <span className="ln-k">ring</span> first 64 bits → <strong>141.2°</strong> clockwise from the top
        </Row>
      </>
    ),
  },
  {
    head: "Walk clockwise, keep three distinct nodes",
    rows: (
      <>
        <div className="ln-ledger">
          {WALK.map((w) => (
            <span key={w.deg} className={`ln-ledger-item ln-w ln-pop${w.rank ? "" : " is-skip"}`} style={win(w.at)}>
              <span className="ln-ledger-n">{w.n}</span>
              {NODES[w.node].name}
              {w.rank ? (
                <span className="ln-ledger-tag">
                  <IconCheck size="0.85rem" />#{w.rank}
                </span>
              ) : (
                <span className="ln-ledger-tag">skip, listed</span>
              )}
            </span>
          ))}
        </div>
        <Row at={NEXT_AT} icon={IconRing}>
          Preference list: <strong>node1, node2, node3</strong>. node4 is next in line.
        </Row>
      </>
    ),
  },
  {
    head: "Send to three, answer after two",
    rows: (
      <>
        <div className="ln-acks">
          {[
            ["node1", 2.56, ""],
            ["node3", 2.62, ""],
            ["node2", 2.9, "late"],
          ].map(([name, when, note]) => (
            <span key={name} className="ln-ack">
              <span className="ln-stack">
                <span className="ln-ack-wait ln-w" style={win(-9, when)}>
                  {name} · waiting
                </span>
                <span className="ln-ack-done ln-w ln-pop" style={win(when)}>
                  <IconCheck size="0.85rem" />
                  {name} ack{note ? ` · ${note}` : ""}
                </span>
              </span>
            </span>
          ))}
        </div>
        <div className="ln-stack">
          <Row until={2.64} icon={IconLayers}>
            Waiting for <strong>W = 2</strong> acknowledgements
          </Row>
          <Row at={2.64} icon={IconCheck} tone="ok">
            Two of three acks → <strong>201 Created</strong>
          </Row>
        </div>
      </>
    ),
  },
  {
    head: "node2 fails; reads carry on",
    rows: (
      <>
        <div className="ln-swim" aria-hidden="true">
          <span className="ln-swim-seg is-alive">
            <IconCheck size="0.8rem" /> alive
          </span>
          <span className="ln-swim-seg is-suspect ln-w" style={win(3.3)}>
            <IconQuestion size="0.8rem" /> suspect
          </span>
          <span className="ln-swim-seg is-dead ln-w" style={win(3.55)}>
            <IconX size="0.8rem" /> dead
          </span>
        </div>
        <Row at={3.6} icon={IconBookmark}>
          put v2 → node1, node3, and node4 <span className="ln-muted">(hint for node2)</span>
        </Row>
        <Row at={3.92} icon={IconCheck} tone="ok">
          get → node1 ✓ node3 ✓ · R = 2 met · <strong>200 OK</strong>
        </Row>
      </>
    ),
  },
  {
    head: "A flipped byte, caught and repaired",
    rows: (
      <>
        <Row at={4.12} icon={IconZap} tone="warn">
          node3&rsquo;s copy of v2 changes on disk
        </Row>
        <Row at={4.3} icon={IconScan} tone="bad">
          scrub: recomputed SHA-256 ≠ stored SHA-256
        </Row>
        <Row at={4.46} icon={IconWrench}>
          <code>Repair(key)</code>: winner is v2 on node1
        </Row>
        <Row at={4.74} icon={IconCheck} tone="ok">
          node3 rewritten; checksum matches
        </Row>
      </>
    ),
  },
  {
    head: "node2 is back; nothing is missing",
    rows: (
      <>
        <Row at={5.1} icon={IconPulse}>
          swim: node2 alive again · ring version bumped
        </Row>
        <Row at={5.3} icon={IconBookmark}>
          hint replay: node4 → node2 (v2)
        </Row>
        <Row at={5.58} icon={IconCheck} tone="ok">
          node1, node2, node3 all hold v2 · hint dropped
        </Row>
      </>
    ),
  },
];

const REDUCED_AT = 0.965;

const pageWindow = (i) => win(i === 0 ? -9 : i, i === STEPS.length - 1 ? 99 : i + 1);

/* ---------- component ---------- */

export default function RingStory() {
  const bodyRef = useRef(null);
  const stageRef = useRef(null);
  const stepRefs = useRef([]);
  const lastS = useRef(-1);
  const reducedMotion = useReducedMotion();
  const reduced = useLatest(reducedMotion);
  const wide = useLatest(useMediaQuery("(min-width: 64rem)"));

  // Re-derive --s straight away if the motion preference flips mid-read.
  useEffect(() => {
    requestScrollFrame();
  }, [reducedMotion]);

  useScrollFrame((frame) => {
    const body = bodyRef.current;
    const stage = stageRef.current;
    if (!body || !stage) return undefined;
    const box = body.getBoundingClientRect();
    if (box.bottom < -frame.vh || box.top > frame.vh * 2) return undefined;

    // The reading line: mid-viewport on wide screens; mid-way through the
    // space under the pinned ring on narrow ones.
    let focus = frame.vh * 0.5;
    if (!wide.current) {
      const stageBottom = stage.getBoundingClientRect().bottom;
      focus = stageBottom + (frame.vh - stageBottom) * 0.5;
    }

    const steps = stepRefs.current;
    let s = 0;
    for (let i = 0; i < steps.length; i += 1) {
      if (!steps[i]) return undefined;
      const r = steps[i].getBoundingClientRect();
      if (focus < r.top) {
        s = i;
        break;
      }
      if (focus < r.bottom) {
        s = i + (focus - r.top) / Math.max(1, r.height);
        break;
      }
      s = i + 1;
    }
    s = clamp(s, 0, STEPS.length);
    // Reduced motion: no scrubbed movement. Each step shows its end state.
    // Every event in a step lands by i + 0.93 and windows fade over 1/30,
    // so i + 0.965 shows the whole end state at full opacity.
    if (reduced.current) s = s >= STEPS.length ? STEPS.length : Math.floor(s) + REDUCED_AT;
    s = Math.round(s * 2000) / 2000;
    if (s === lastS.current) return undefined;
    lastS.current = s;
    return () => body.style.setProperty("--s", String(s));
  });

  return (
    <section className="ln-story" id="story" aria-labelledby="ln-story-title">
      <header className="ln-section-head ln-story-head">
        <p className="ln-eyebrow">
          <span className="ln-eyebrow-num">01</span> A write, a failure, a repair
        </p>
        <h2 id="ln-story-title" className="ln-h2">
          Follow one file through a bad day.
        </h2>
        <p className="ln-intro">Scroll. One file, from the write to the repair.</p>
      </header>

      <div className="ln-story-body" ref={bodyRef}>
        <div className="ln-stage" ref={stageRef}>
          <div className="ln-stage-top">
            <span className="chip outline ln-illus">
              <IconInfo size="0.95rem" /> Illustration · not live data
            </span>
            <span className="ln-stage-count ln-stack" aria-hidden="true">
              {STEPS.map((step, i) => (
                <span key={step.short} className="ln-w" style={pageWindow(i)}>
                  <span className="num">0{i + 1}</span>
                  <span className="ln-stage-count-of"> / 06</span>
                </span>
              ))}
            </span>
          </div>

          <div className="ln-stage-bar" aria-hidden="true">
            {STEPS.map((step, i) => (
              <span key={step.short} className="ln-seg" style={{ "--i": i }}>
                <span className="ln-seg-track">
                  <span className="ln-seg-fill" />
                  <span className="ln-seg-done" />
                </span>
                <span className="ln-seg-label">{step.short}</span>
              </span>
            ))}
          </div>

          <figure
            className="ln-ring"
            role="img"
            aria-label="Illustration: a consistent-hash ring with five nodes. Its state follows the step you are reading."
          >
            {RING_SVG}
            <div className="ln-ring-overlay" aria-hidden="true">
              <div className="ln-obj">
                <IconFile size="1.1em" className="ln-obj-icon" />
                <span className="ln-obj-name">report.pdf</span>
                <span className="ln-stack ln-obj-ver">
                  <span className="ln-w" style={win(-9, 2)}>
                    new
                  </span>
                  <span className="ln-w" style={win(2, 3.6)}>
                    v1
                  </span>
                  <span className="ln-w" style={win(3.6)}>
                    v2
                  </span>
                </span>
              </div>

              {NODES.map((node) => (
                <div key={node.name} className="ln-st" style={{ left: pct(node.x), top: pct(node.y) }}>
                  <div className="ln-st-alerts ln-stack">
                    {NODE_ALERTS[node.i].map(([label, from, until, tone, Icon]) => (
                      <span key={label} className={`ln-st-alert is-${tone} ln-w ln-pop`} style={win(from, until)}>
                        <Icon size="0.8em" />
                        {label}
                      </span>
                    ))}
                  </div>
                  <div className="ln-st-bubble">
                    <span className="ln-st-layer is-pref ln-w" style={win(RANK[node.i]?.at ?? 99)} />
                    {NODE_STATUS[node.i]
                      .filter(([state]) => state !== "alive")
                      .map(([state, from, until]) => (
                        <span key={state} className={`ln-st-layer is-${state} ln-w`} style={win(from, until)} />
                      ))}
                    <span className="ln-st-name">
                      <small>node</small>
                      {node.i + 1}
                    </span>
                    {RANK[node.i] ? (
                      <span className="ln-st-rank ln-w ln-pop" style={win(RANK[node.i].at)}>
                        #{RANK[node.i].n}
                      </span>
                    ) : null}
                    <span className="ln-st-icon ln-stack">
                      {NODE_STATUS[node.i].map(([state, from, until]) => {
                        const { Icon } = STATUS[state];
                        return (
                          <span key={`${state}-${from}`} className={`is-${state} ln-w`} style={win(from, until)}>
                            <Icon size="0.75em" />
                          </span>
                        );
                      })}
                    </span>
                  </div>
                  <div className="ln-st-status ln-stack">
                    {NODE_STATUS[node.i].map(([state, from, until]) => (
                      <span key={`${state}-${from}`} className={`ln-st-word is-${state} ln-w`} style={win(from, until)}>
                        {STATUS[state].word}
                      </span>
                    ))}
                  </div>
                  <div className="ln-st-data ln-stack">
                    {NODE_DATA[node.i].map(([label, from, until, tone]) => (
                      <span key={label} className={`ln-st-tag is-${tone} ln-w ln-pop`} style={win(from, until)}>
                        {label}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </figure>

          <div className="ln-panel" aria-hidden="true">
            <div className="ln-stack">
              {PANELS.map((panel, i) => (
                <div key={panel.head} className="ln-panel-page ln-w" style={pageWindow(i)}>
                  <p className="ln-panel-head">
                    <span className="ln-panel-num num">0{i + 1}</span>
                    {panel.head}
                  </p>
                  <div className="ln-panel-rows">{panel.rows}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <ol className="ln-steps">
          {STEPS.map((step, i) => (
            <li
              key={step.short}
              className={`ln-step${i === 3 ? " is-long" : ""}`}
              style={{ "--i": i }}
              ref={(el) => {
                stepRefs.current[i] = el;
              }}
            >
              <article className="ln-step-card">
                <p className="ln-step-num">
                  <span className="num">0{i + 1}</span> {step.short}
                </p>
                <h3 className="ln-step-title">{step.title}</h3>
                <p className="ln-step-body">{step.body}</p>
                <ul className="ln-step-facts" aria-label="Key terms">
                  {step.facts.map((fact) => (
                    <li key={fact} className="chip outline">
                      {fact}
                    </li>
                  ))}
                </ul>
              </article>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
