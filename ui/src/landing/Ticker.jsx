import { IconBookmark, IconEye, IconLayers, IconPulse, IconRing, IconScan, IconShuffle, IconSync } from "./icons.jsx";

// Example lines in the shape of the event log. Illustrative, not a feed.
// One tape, CSS-animated; it pauses on hover and stops under reduced motion.
const LINES = [
  { tag: "scrub", Icon: IconScan, text: "checksum mismatch on node3 → healed from node1", tone: "warn" },
  { tag: "put", Icon: IconLayers, text: "report.pdf v2 · 2 of 3 acks → 201 Created" },
  { tag: "swim", Icon: IconPulse, text: "node2 suspect · missed direct probes", tone: "warn" },
  { tag: "swim", Icon: IconPulse, text: "node2 dead · writes route around it", tone: "bad" },
  { tag: "hint", Icon: IconBookmark, text: "parked on node4 for node2" },
  { tag: "get", Icon: IconEye, text: "report.pdf · R=2 · node1 ✓ node3 ✓ → 200" },
  { tag: "read-repair", Icon: IconSync, text: "node5 behind (v3 < v4) → pushed v4", tone: "warn" },
  { tag: "hint", Icon: IconBookmark, text: "replayed node4 → node2 · hint dropped" },
  { tag: "rebalance", Icon: IconShuffle, text: "migrate photos/cat.png node2 → node5" },
  { tag: "ring", Icon: IconRing, text: "stale ring version ignored" },
];

function Line({ line }) {
  const { tag, Icon, text, tone } = line;
  return (
    <li className={`ln-tick${tone ? ` is-${tone}` : ""}`}>
      <span className="ln-tick-icon">
        <Icon size="0.9rem" />
      </span>
      <span className="ln-tick-tag">{tag}</span>
      <span className="ln-tick-text">{text}</span>
    </li>
  );
}

export default function Ticker() {
  return (
    <section className="ln-ticker" aria-labelledby="ln-ticker-title">
      <h2 id="ln-ticker-title" className="sr-only">
        What the event log says on a bad day
      </h2>
      <div className="ln-tape">
        {[0, 1].map((copy) => (
          <ul key={copy} className="ln-tape-set" aria-hidden={copy ? "true" : undefined} aria-label={copy ? undefined : "Example event log lines"}>
            {LINES.map((line) => (
              <Line key={line.text} line={line} />
            ))}
          </ul>
        ))}
      </div>
      <p className="ln-ticker-note">Example lines in the log&rsquo;s format. Not a feed.</p>
    </section>
  );
}
