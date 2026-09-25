import { useLayoutEffect, useRef, useState } from "react";
import { clamp, requestScrollFrame, useLatest, useMediaQuery, useScrollFrame } from "./hooks.js";
import { IconCheck, IconX } from "./icons.jsx";

// Build order from PLAN.md, section 8. "share" is the planned share of the
// build time, as written in the plan. "proof" names where each exit test is
// exercised in this repository.
const PHASES = [
  {
    id: "A",
    name: "Single node",
    share: 20,
    items: ["Put / Get / Delete", "SHA-256 checksum and bbolt index", "HTTP API", "Unit tests on the store"],
    exit: "curl a file in and out of one process.",
    proof: "internal/store and internal/api tests",
  },
  {
    id: "B",
    name: "Multi-node quorum",
    share: 25,
    items: ["memberlist join", "Ring and preference list", "gRPC Replicate / GetReplica", "N/W/R reads and writes", "Five nodes in docker compose"],
    exit: "Put on node1, get from node3, bytes on three disks.",
    proof: "five-node cluster test in internal/node",
  },
  {
    id: "C",
    name: "Faults",
    share: 25,
    items: ["Mark dead, sloppy write and hint", "Read-repair", "Scrubber", "Replay hints when a node returns", "Kill and start controls"],
    exit: "Stop a container and still get; corrupt a file and watch it heal.",
    proof: "stop, hint, corrupt and heal cluster tests",
  },
  {
    id: "D",
    name: "Rebalance",
    share: 10,
    items: ["Join a sixth node or restart a dead one", "Rate-limited moves", "Log lines: migrate key from n2 → n5"],
    exit: "The new node receives keys; the old one drops extras.",
    proof: "rebalance test in internal/repair",
  },
  {
    id: "E",
    name: "Dashboard",
    share: 15,
    items: ["Cluster: node cards, ring, N/W/R", "Objects: replica dots, checksum badge", "Events: append-only repair log", "Kill, start and corrupt buttons"],
    exit: "The 90-second demo script runs end to end.",
    proof: "the dashboard at /app ticks it off live",
  },
  {
    id: "F",
    name: "Polish",
    share: 5,
    items: ["3/2/2 default plus a live slider", "Metrics card: 3.0× overhead, last repair, under-replicated", "README and demo script"],
    exit: "Electron only if the demo already works.",
    proof: "slider, metrics, README built; Electron skipped",
  },
];

const OUT_OF_SCOPE = [
  "Raft or any central metadata cluster",
  "Merkle-tree anti-entropy",
  "Reed-Solomon erasure coding",
  "Full S3 compatibility",
  "Chaos that runs on its own timer",
];

const HORIZONTAL = "(min-width: 60rem) and (prefers-reduced-motion: no-preference)";

export default function Phases() {
  const horizontal = useMediaQuery(HORIZONTAL);
  const horizontalRef = useLatest(horizontal);
  const pinRef = useRef(null);
  const stickyRef = useRef(null);
  const trackRef = useRef(null);
  const geometry = useRef({ overflow: 0, centers: [], trackLeft: 0, width: 0 });
  const lastP = useRef(-1);
  const activeRef = useRef(-1);
  const [active, setActive] = useState(-1);

  // Measure how far the track overflows and make the pin tall enough to pan
  // through it: one pixel of vertical scroll moves the track one pixel.
  useLayoutEffect(() => {
    const pin = pinRef.current;
    const sticky = stickyRef.current;
    const track = trackRef.current;
    if (!pin || !sticky || !track) return undefined;
    if (!horizontal) {
      pin.style.removeProperty("--pin-h");
      sticky.style.removeProperty("--bo");
      sticky.style.removeProperty("--bp");
      lastP.current = -1;
      return undefined;
    }
    const measure = () => {
      const width = sticky.clientWidth;
      const overflow = Math.max(0, track.scrollWidth - width + track.offsetLeft * 2);
      const cards = track.querySelectorAll("[data-phase]");
      geometry.current = {
        overflow,
        width,
        trackLeft: track.offsetLeft,
        centers: Array.from(cards, (card) => card.offsetLeft + card.offsetWidth / 2),
      };
      pin.style.setProperty("--pin-h", `${Math.round(overflow + window.innerHeight)}px`);
      sticky.style.setProperty("--bo", String(Math.round(overflow)));
      requestScrollFrame();
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(track);
    ro?.observe(sticky);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [horizontal]);

  useScrollFrame((frame) => {
    if (!horizontalRef.current) return undefined;
    const pin = pinRef.current;
    const sticky = stickyRef.current;
    if (!pin || !sticky) return undefined;
    const rect = pin.getBoundingClientRect();
    if (rect.bottom < -frame.vh || rect.top > frame.vh * 2) return undefined;
    const p = clamp(-rect.top / Math.max(1, rect.height - frame.vh));
    const q = Math.round(p * 5000) / 5000;
    if (q === lastP.current) return undefined;
    lastP.current = q;

    const { overflow, centers, trackLeft, width } = geometry.current;
    const shift = q * overflow;
    // The focus point sweeps from the left edge to the right edge, so the
    // first phase is highlighted at the start and the last at the end.
    const focus = trackLeft + q * Math.max(0, width - 2 * trackLeft);
    let best = -1;
    let bestDist = Infinity;
    centers.forEach((c, i) => {
      const d = Math.abs(trackLeft + c - shift - focus);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });

    return () => {
      sticky.style.setProperty("--bp", String(q));
      if (best !== activeRef.current) {
        activeRef.current = best;
        setActive(best);
      }
    };
  });

  const shown = horizontal ? active : -1;

  return (
    <section className="ln-build" id="build" aria-labelledby="ln-build-title">
      <div className="ln-build-pin" ref={pinRef}>
        <div className="ln-build-sticky" ref={stickyRef}>
          <header className="ln-section-head ln-build-head">
            <div>
              <p className="ln-eyebrow">
                <span className="ln-eyebrow-num">04</span> Build order
              </p>
              <h2 id="ln-build-title" className="ln-h2">
                Engine first. UI last.
              </h2>
            </div>
            <p className="ln-intro">
              Six phases from PLAN.md, each with an exit test, built in order so nothing later could eat an earlier
              phase. All six have landed. Each card names where its exit test runs; Electron was skipped, as the
              plan allows.
            </p>
          </header>

          <div className="ln-minimap" aria-hidden="true">
            {PHASES.map((ph, i) => (
              <span key={ph.id} className={`ln-mm-seg${shown === i ? " is-active" : ""}`} style={{ "--share": ph.share }}>
                <span className="ln-mm-bar" />
                <span className="ln-mm-label">
                  <b>{ph.id}</b> {ph.share}%
                </span>
              </span>
            ))}
            <span className="ln-mm-progress" />
          </div>
          <p className="ln-mm-caption">Planned share of build time, from the plan</p>

          <ol className="ln-track" ref={trackRef}>
            {PHASES.map((ph, i) => (
              <li
                key={ph.id}
                className={`ln-phase surface-card${shown === i ? " is-active" : ""}`}
                data-phase={ph.id}
              >
                <div className="ln-phase-top">
                  <span className="ln-phase-letter" aria-hidden="true">
                    {ph.id}
                  </span>
                  <span className="chip outline num">~{ph.share}% of the build</span>
                </div>
                <h3 className="ln-phase-name">
                  <span className="sr-only">Phase {ph.id}: </span>
                  {ph.name}
                </h3>
                <ul className="ln-phase-items">
                  {ph.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                <div className="ln-phase-exit">
                  <span className="ln-phase-exit-label">Exit test</span>
                  <p>{ph.exit}</p>
                  <p className="ln-phase-proof">
                    <IconCheck size="0.85rem" /> {ph.proof}
                  </p>
                </div>
              </li>
            ))}
            <li className="ln-phase ln-phase-out">
              <div className="ln-phase-top">
                <span className="ln-phase-letter is-small" aria-hidden="true">
                  <IconX size="1em" />
                </span>
              </div>
              <h3 className="ln-phase-name">Named, and not built</h3>
              <ul className="ln-phase-items is-out">
                {OUT_OF_SCOPE.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <div className="ln-phase-exit">
                <span className="ln-phase-exit-label">If time runs out</span>
                <p>
                  Keep the store, the ring, quorum put and get, failure detection, one repair function and the
                  kill-node demo. Cut animation before the engine.
                </p>
              </div>
            </li>
          </ol>
        </div>
      </div>
    </section>
  );
}
