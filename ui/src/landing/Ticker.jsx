import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "./hooks.js";
import {
  IconBookmark,
  IconEye,
  IconLayers,
  IconPause,
  IconPlay,
  IconPulse,
  IconRing,
  IconScan,
  IconShuffle,
  IconSync,
} from "./icons.jsx";

// Example lines in the shape of the event log. Illustrative, not a feed.
const ROW_A = [
  { tag: "scrub", Icon: IconScan, text: "checksum mismatch on node3 → repaired from node1", tone: "warn" },
  { tag: "put", Icon: IconLayers, text: "report.pdf v2 · 2 of 3 acks → 201 Created" },
  { tag: "swim", Icon: IconPulse, text: "node2 suspect · probe missed", tone: "warn" },
  { tag: "swim", Icon: IconPulse, text: "node2 dead · writes route around it", tone: "bad" },
  { tag: "hint", Icon: IconBookmark, text: "parked on node4 for node2" },
  { tag: "get", Icon: IconEye, text: "report.pdf · R=2 · node1 ✓ node3 ✓ → 200" },
];
const ROW_B = [
  { tag: "read-repair", Icon: IconSync, text: "node5 behind (v3 < v4) → pushed v4", tone: "warn" },
  { tag: "hint", Icon: IconBookmark, text: "replayed node4 → node2 · hint dropped" },
  { tag: "rebalance", Icon: IconShuffle, text: "migrate photos/cat.png node2 → node5 · rate-limited" },
  { tag: "ring", Icon: IconRing, text: "stale ring version ignored" },
  { tag: "scrub", Icon: IconScan, text: "pass complete on node1 · no mismatches" },
  { tag: "swim", Icon: IconPulse, text: "node2 alive · rejoined the ring" },
];

const COPIES = 3;
const BASE_SPEED = 32; // px per second when the page is still
const SCROLL_GAIN = 0.32; // how much scroll velocity leaks into the tape

function wrap(x, width) {
  if (width <= 0) return x;
  let m = x % width;
  if (m > 0) m -= width;
  return m;
}

function Line({ line }) {
  const { tag, Icon, text, tone } = line;
  return (
    <li className={`ln-tick${tone ? ` is-${tone}` : ""}`}>
      <span className="ln-tick-icon">
        <Icon size="0.95rem" />
      </span>
      <span className="ln-tick-tag">{tag}</span>
      <span className="ln-tick-sep" aria-hidden="true">
        ·
      </span>
      <span className="ln-tick-text">{text}</span>
    </li>
  );
}

function Tape({ lines, rowRef, label }) {
  return (
    <div className="ln-tape" ref={rowRef}>
      {Array.from({ length: COPIES }, (_, copy) => (
        <ul
          key={copy}
          className="ln-tape-set"
          aria-label={copy === 0 ? label : undefined}
          aria-hidden={copy === 0 ? undefined : "true"}
          data-copy={copy}
        >
          {lines.map((line) => (
            <Line key={line.text} line={line} />
          ))}
        </ul>
      ))}
    </div>
  );
}

export default function Ticker() {
  const reduced = useReducedMotion();
  const [paused, setPaused] = useState(false);
  const sectionRef = useRef(null);
  const rowA = useRef(null);
  const rowB = useRef(null);
  const offsets = useRef([0, 0]);

  useEffect(() => {
    const section = sectionRef.current;
    const rows = [rowA.current, rowB.current];
    if (reduced || paused || !section || rows.some((r) => !r)) return undefined;

    let widths = [0, 0];
    const measure = () => {
      widths = rows.map((row) => row.firstElementChild?.offsetWidth ?? 0);
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    rows.forEach((row) => row.firstElementChild && ro?.observe(row.firstElementChild));

    let raf = 0;
    let last = 0;
    let lastY = window.scrollY;
    let velocity = 0; // smoothed scroll velocity, px/s
    let visible = false;

    const tick = (now) => {
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
      last = now;
      const y = window.scrollY;
      const target = (y - lastY) / dt;
      lastY = y;
      velocity += (target - velocity) * (1 - Math.exp(-dt / 0.22));

      // Scrolling down speeds the tape up; scrolling up can reverse it.
      const push = Math.max(-900, Math.min(900, velocity * SCROLL_GAIN));
      const speed = BASE_SPEED + push;
      const o = offsets.current;
      o[0] = wrap(o[0] - speed * dt, widths[0]);
      o[1] = wrap(o[1] + speed * dt, widths[1]);
      rows[0].style.transform = `translate3d(${o[0].toFixed(2)}px,0,0)`;
      rows[1].style.transform = `translate3d(${o[1].toFixed(2)}px,0,0)`;
      raf = visible ? window.requestAnimationFrame(tick) : 0;
    };

    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible && !raf) {
        last = 0;
        lastY = window.scrollY;
        velocity = 0;
        raf = window.requestAnimationFrame(tick);
      }
    });
    io.observe(section);

    return () => {
      io.disconnect();
      ro?.disconnect();
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [reduced, paused]);

  return (
    <section className="ln-ticker" ref={sectionRef} aria-labelledby="ln-ticker-title">
      <div className="ln-ticker-head">
        <h2 id="ln-ticker-title" className="ln-ticker-title">
          What the event log says on a bad day
        </h2>
        <p className="ln-ticker-note">Example lines in the log&rsquo;s format · illustration, not a feed</p>
        {reduced ? null : (
          <button
            type="button"
            className="icon-btn ln-ticker-toggle"
            onClick={() => setPaused((p) => !p)}
            aria-pressed={paused}
            aria-label={paused ? "Resume the scrolling log" : "Pause the scrolling log"}
          >
            {paused ? <IconPlay size="1.1rem" /> : <IconPause size="1.1rem" />}
          </button>
        )}
      </div>
      <div className="ln-tapes">
        <Tape lines={ROW_A} rowRef={rowA} label="Example failure and repair lines" />
        <Tape lines={ROW_B} rowRef={rowB} label="Example background maintenance lines" />
      </div>
    </section>
  );
}
