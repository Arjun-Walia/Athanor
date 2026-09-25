// The dashboard's drawings: the live hash ring, the scrub dial, the replica
// bars, and the activity timeline. All SVG or plain DOM; no chart library.

import { useMemo } from "react";
import { inkOn, nodeTone, statusMeta } from "./components.jsx";
import { chipLabel, eventColumn, groupEvents, notable } from "./story.js";
import { clock, nodeShort } from "./format.js";

const TAU = Math.PI * 2;
const polar = (cx, cy, r, turn) => {
  const a = turn * TAU - Math.PI / 2;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
};

function arcPath(cx, cy, r, from, to) {
  let sweep = to - from;
  if (sweep < 0) sweep += 1;
  const [x1, y1] = polar(cx, cy, r, from);
  const [x2, y2] = polar(cx, cy, r, from + sweep);
  const large = sweep > 0.5 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
}

/**
 * The consistent-hash ring, drawn from the live vnode positions. Each tick
 * is one vnode. With a placement, the key's position is marked and the
 * clockwise walk to its preference list is traced.
 */
export function HashRing({ ring, nodes, placement, size = 420 }) {
  const cx = 200;
  const cy = 200;
  const r = 148;
  const ids = ring?.nodes ?? [];
  const statusOf = useMemo(() => {
    const m = new Map();
    for (const n of nodes ?? []) m.set(n.id, n.status);
    return m;
  }, [nodes]);

  const walk = useMemo(() => {
    if (!placement || !ring?.tokens?.length) return null;
    const tokens = ring.tokens;
    let start = tokens.findIndex((t) => t.pos >= placement.pos);
    if (start < 0) start = 0;
    const firstHit = new Map();
    for (let i = 0; i < tokens.length && firstHit.size < ids.length; i++) {
      const t = tokens[(start + i) % tokens.length];
      if (!firstHit.has(t.node)) firstHit.set(t.node, t);
    }
    const pref = placement.preference.map((id) => firstHit.get(id)).filter(Boolean);
    const end = pref.length ? pref[pref.length - 1].pos : placement.pos;
    return { pref, end };
  }, [placement, ring, ids.length]);

  if (!ring) {
    return <div className="ath-ring-empty">Loading ring…</div>;
  }

  return (
    <svg className="ath-ring" viewBox="-40 -40 480 480" width={size} role="img" aria-label={`Hash ring version ${ring.version} with ${ids.length} nodes and ${ring.tokens.length} virtual nodes`}>
      <defs>
        <radialGradient id="ringGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#f6cf45" stopOpacity="0.35" />
          <stop offset="70%" stopColor="#f6cf45" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx={cx} cy={cy} r={r + 28} fill="url(#ringGlow)" />
      <circle cx={cx} cy={cy} r={r} className="ath-ring-track" />
      {ring.tokens.map((t, i) => {
        const [x1, y1] = polar(cx, cy, r - 11, t.pos);
        const [x2, y2] = polar(cx, cy, r + 11, t.pos);
        const st = statusOf.get(t.node) || "unknown";
        const down = st === "dead" || st === "stopped" || st === "unknown";
        return (
          <line
            key={i}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={nodeTone(t.node, ids)}
            strokeWidth={down ? 1.4 : 2.2}
            strokeOpacity={down ? 0.28 : 0.9}
            strokeDasharray={down ? "2 2" : undefined}
            strokeLinecap="round"
          />
        );
      })}
      {walk ? (
        <g className="ath-ring-walk">
          <path d={arcPath(cx, cy, r + 22, placement.pos, walk.end)} className="ath-ring-walk-arc" />
          {(() => {
            const [kx, ky] = polar(cx, cy, r + 22, placement.pos);
            return <circle cx={kx} cy={ky} r="7" className="ath-ring-key" />;
          })()}
          {walk.pref.map((t, i) => {
            const [x, y] = polar(cx, cy, r, t.pos);
            // Owners usually sit a few degrees apart (64 vnodes each), so
            // labels fan outward along the radius with leader lines.
            const [lx, ly] = polar(cx, cy, r + 46 + i * 21, t.pos);
            const [ex, ey] = polar(cx, cy, r + 36 + i * 21, t.pos);
            return (
              <g key={t.node}>
                <line x1={x} y1={y} x2={ex} y2={ey} className="ath-ring-leader" />
                <circle cx={x} cy={y} r="7" fill={nodeTone(t.node, ids)} className="ath-ring-owner" />
                <text x={lx} y={ly + 4} textAnchor={lx < cx - 8 ? "end" : lx > cx + 8 ? "start" : "middle"} className="ath-ring-owner-label">
                  {i + 1} · {t.node}
                </text>
              </g>
            );
          })}
        </g>
      ) : null}
      <text x={cx} y={cy - 6} textAnchor="middle" className="ath-ring-center">
        v{ring.version}
      </text>
      <text x={cx} y={cy + 20} textAnchor="middle" className="ath-ring-center-sub">
        {ring.tokens.length} vnodes · {ids.length === 1 ? "1 node" : `${ids.length} nodes`}
      </text>
      <text x={cx} y={cy + 38} textAnchor="middle" className="ath-ring-center-sub">
        {ring.digest}
      </text>
    </svg>
  );
}

/** Countdown dial: yellow arc for time elapsed, ticks for time remaining. */
export function Dial({ fraction, label, sub, busy }) {
  const f = Math.min(1, Math.max(0, fraction || 0));
  const ticks = 64;
  const cx = 100;
  const cy = 100;
  return (
    <div className={`ath-dial${busy ? " is-busy" : ""}`}>
      <svg viewBox="0 0 200 200" aria-hidden="true">
        {Array.from({ length: ticks }, (_, i) => {
          const turn = i / ticks;
          if (turn < f) return null;
          const long = i % 4 === 0;
          const [x1, y1] = polar(cx, cy, long ? 74 : 77, turn);
          const [x2, y2] = polar(cx, cy, 84, turn);
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className="ath-dial-tick" />;
        })}
        {f > 0.002 ? <path d={arcPath(cx, cy, 80, 0, f >= 0.999 ? 0.9989 : f)} className="ath-dial-arc" /> : null}
      </svg>
      <div className="ath-dial-center">
        <span className="ath-dial-value num">{label}</span>
        <span className="ath-dial-sub">{sub}</span>
      </div>
    </div>
  );
}

/**
 * Thin rounded bars with a dot below, like the reference's weekly chart. The
 * highlighted bar is the node you are coordinating through ("today").
 */
export function NodeBars({ nodes, focus }) {
  const max = Math.max(1, ...nodes.map((n) => n.value));
  return (
    <div className="ath-bars" role="list">
      <div className="ath-bars-rule" aria-hidden="true" />
      {nodes.map((n) => {
        // Top out at 76% so the value flag above the tallest bar stays inside.
        const h = n.value === 0 ? 5 : 10 + (n.value / max) * 66;
        const isFocus = n.id === focus;
        const meta = statusMeta(n.status);
        const down = n.status === "dead" || n.status === "stopped" || n.status === "unknown";
        return (
          <div className="ath-bar-col" role="listitem" key={n.id} title={`${n.id}: ${n.value} replicas, ${meta.label.toLowerCase()}`}>
            <div className="ath-bar-track">
              {isFocus ? (
                <span className="ath-bar-flag num" style={{ bottom: `calc(${h}% + 0.55rem)` }}>
                  {n.value} here
                </span>
              ) : null}
              <span className={`ath-bar${isFocus ? " is-top" : ""}${down ? " is-down" : ""}`} style={{ height: `${h}%` }} />
            </div>
            <span className={`ath-bar-dot${isFocus ? " is-top" : ""}${down ? " is-down" : ""}`} aria-hidden="true" />
            <span className="ath-bar-label">{nodeShort(n.id)}</span>
            <span className="sr-only">
              {n.id} holds {n.value} replicas and is {meta.label}
              {isFocus ? " (coordinator)" : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Activity timeline: one column per node, time running downward, one chip
 * per notable event. Chips are placed greedily so they never overlap.
 */
export function Timeline({ events, nodes, windowMs, now }) {
  const cols = nodes.map((n) => n.id);
  const from = now - windowMs;
  const HEIGHT = 15; // rem of plotting area
  const CHIP_H = 3.1; // rem
  const rows = 4;

  const chips = useMemo(() => {
    const visible = groupEvents(events.filter((e) => e.t >= from && notable(e)));
    const latest = visible.slice(-14);
    const placed = [];
    const colW = 100 / Math.max(1, cols.length);
    const chipW = Math.min(100, colW * 1.9);
    const GAP = 0.35;
    const maxTop = HEIGHT - CHIP_H;
    const hits = (left, top) =>
      placed.filter((p) => left < p.left + p.w && p.left < left + chipW && top < p.top + CHIP_H + GAP && p.top < top + CHIP_H + GAP);
    for (const e of latest) {
      const col = Math.max(0, cols.indexOf(eventColumn(e)));
      let left = col * colW + colW * 0.08;
      if (left + chipW > 100) left = 100 - chipW;
      const want = Math.min(maxTop, ((e.t - from) / windowMs) * maxTop);
      // Search outward from the event's time for a free slot, nearest first.
      let top = null;
      for (let step = 0; step <= 2 * (HEIGHT / 0.5) && top === null; step++) {
        const offset = Math.ceil(step / 2) * 0.5 * (step % 2 ? -1 : 1);
        const t = want + offset;
        if (t < 0 || t > maxTop) continue;
        if (hits(left, t).length === 0) top = t;
      }
      if (top === null) {
        // Full: the newest event wins the slot nearest its time.
        top = want;
        for (const h of hits(left, top)) placed.splice(placed.indexOf(h), 1);
      }
      placed.push({ e, left, top, w: chipW });
    }
    return placed;
  }, [events, from, windowMs, cols]);

  const counts = new Map(nodes.map((n) => [n.id, n.objects]));
  const times = Array.from({ length: rows }, (_, i) => from + (windowMs * i) / (rows - 1));

  return (
    <div className="ath-timeline">
      <div className="ath-timeline-head" style={{ gridTemplateColumns: `4.5rem repeat(${cols.length}, 1fr)` }}>
        <span />
        {cols.map((id) => (
          <span key={id} className="ath-timeline-col">
            <span className="ath-timeline-col-name">{id}</span>
            <span className="ath-timeline-col-count num">{counts.get(id) ?? "–"}</span>
          </span>
        ))}
      </div>
      <div className="ath-timeline-body" style={{ gridTemplateColumns: `4.5rem 1fr`, height: `${HEIGHT}rem` }}>
        <div className="ath-timeline-times">
          {times.map((t, i) => (
            <span key={i} className="num" style={{ top: `${(i / (rows - 1)) * (HEIGHT - CHIP_H) + 0.9}rem` }}>
              {clock(t).slice(0, 5)}
              <small>{clock(t).slice(5)}</small>
            </span>
          ))}
        </div>
        <div className="ath-timeline-plot">
          {cols.map((id, i) => (
            <span key={id} className="ath-timeline-rule" style={{ left: `${((i + 0.5) / cols.length) * 100}%` }} />
          ))}
          {chips.length === 0 ? <p className="ath-timeline-empty">Quiet. No repairs, hints, or failures in this window.</p> : null}
          {chips.map(({ e, left, top, w }) => {
            const { title, detail } = chipLabel(e);
            const dark = e.level === "error" || e.kind === "repair" || e.kind === "fault";
            return (
              <div
                key={e.id}
                className={`ath-chip-event${dark ? " is-dark" : ""}${e.level === "warn" ? " is-warn" : ""}`}
                style={{ left: `${left}%`, top: `${top}rem`, width: `${w}%` }}
                title={`${clock(e.at)} · ${e.message}`}
              >
                <span className="ath-chip-text">
                  <strong>{title}</strong>
                  <span>{detail}</span>
                </span>
                <span className="ath-chip-avatars" aria-label={`reported by ${e.observers.join(", ")}`}>
                  {e.observers.slice(0, 3).map((o) => (
                    <span key={o} className="ath-avatar" style={{ background: nodeTone(o, cols), color: inkOn(nodeTone(o, cols)) }}>
                      {nodeShort(o)}
                    </span>
                  ))}
                  {e.observers.length > 3 ? <span className="ath-avatar is-more">+{e.observers.length - 3}</span> : null}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
