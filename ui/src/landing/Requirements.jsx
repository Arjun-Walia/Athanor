import { useReveal } from "./hooks.js";
import {
  IconArrowRight,
  IconBookmark,
  IconCheck,
  IconEye,
  IconLayers,
  IconPulse,
  IconQuestion,
  IconRadio,
  IconScan,
  IconShield,
  IconShuffle,
  IconSync,
  IconUnlink,
  IconWrench,
  IconX,
  IconZap,
} from "./icons.jsx";

// From the requirement → technique table in PLAN.md. The small diagrams are
// worked examples of each rule, not cluster data.
const CARDS = [
  {
    need: "Replication",
    Icon: IconLayers,
    how: "Write to N. Return after W.",
    pkg: "internal/replica",
    demo: (
      <div className="ln-mini-row">
        <span className="chip dark">
          <IconCheck size="0.8rem" /> node1
        </span>
        <span className="chip dark">
          <IconCheck size="0.8rem" /> node2
        </span>
        <span className="chip outline">node3 · pending</span>
        <span className="ln-mini-arrow">
          <IconArrowRight size="0.9rem" />
        </span>
        <span className="chip yellow">201</span>
      </div>
    ),
  },
  {
    need: "Retrieval",
    Icon: IconEye,
    how: "Newest copy whose checksum matches.",
    pkg: "internal/replica",
    demo: (
      <div className="ln-mini-row">
        <span className="chip red">
          <IconX size="0.8rem" /> v7 · bad sum
        </span>
        <span className="chip yellow">
          <IconCheck size="0.8rem" /> v7 · chosen
        </span>
        <span className="chip outline">v6 · older</span>
      </div>
    ),
  },
  {
    need: "Node failures",
    Icon: IconPulse,
    how: "Missed probes. Suspect, then dead.",
    pkg: "internal/membership",
    demo: (
      <div className="ln-mini-seg">
        <span className="is-alive">
          <IconCheck size="0.8rem" /> alive
        </span>
        <span className="is-suspect hatched">
          <IconQuestion size="0.8rem" /> suspect
        </span>
        <span className="is-dead">
          <IconX size="0.8rem" /> dead
        </span>
      </div>
    ),
  },
  {
    need: "Partial partitions",
    Icon: IconUnlink,
    how: "Down owner? The next node holds a hint.",
    pkg: "internal/replica · internal/store",
    demo: (
      <div className="ln-mini-row">
        <span className="chip red">
          <IconX size="0.8rem" /> node2
        </span>
        <span className="ln-mini-arrow">
          <IconArrowRight size="0.9rem" />
        </span>
        <span className="chip yellow">
          <IconBookmark size="0.8rem" /> node4 · hinted_for node2
        </span>
      </div>
    ),
  },
  {
    need: "Corruption",
    Icon: IconZap,
    how: "SHA-256 on every read and scrub.",
    pkg: "internal/store",
    demo: (
      <div className="ln-mini-sum">
        <code>stored&nbsp;&nbsp;&nbsp;&nbsp; 9c41…07ad</code>
        <code>
          recomputed 9c41…<mark>07ae</mark>
        </code>
        <span className="chip red">
          <IconX size="0.8rem" /> mismatch
        </span>
      </div>
    ),
  },
  {
    need: "Replica inconsistency",
    Icon: IconSync,
    how: "Disagreeing copies get the winner.",
    pkg: "internal/repair",
    demo: (
      <div className="ln-mini-row">
        <span className="chip outline">node5 · v3</span>
        <span className="ln-mini-arrow">
          <IconArrowRight size="0.9rem" />
        </span>
        <span className="chip dark">
          <IconCheck size="0.8rem" /> node5 · v4
        </span>
      </div>
    ),
  },
  {
    need: "Rebalancing",
    Icon: IconShuffle,
    how: "Keys move when the ring changes.",
    pkg: "internal/repair",
    demo: (
      <div className="ln-mini-bucket">
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} className={i < 4 ? "is-on" : "hatched"} aria-hidden="true" />
        ))}
        <small>token bucket · moves wait their turn</small>
      </div>
    ),
  },
  {
    need: "Integrity",
    Icon: IconShield,
    how: "A timer rehashes the local index.",
    pkg: "internal/repair",
    demo: (
      <div className="ln-mini-row">
        <span className="chip outline">
          <IconScan size="0.8rem" /> walk index
        </span>
        <span className="ln-mini-arrow">
          <IconArrowRight size="0.9rem" />
        </span>
        <span className="chip outline">rehash</span>
        <span className="ln-mini-arrow">
          <IconArrowRight size="0.9rem" />
        </span>
        <span className="chip outline">compare</span>
      </div>
    ),
  },
  {
    need: "Metadata consistency",
    Icon: IconRadio,
    how: "Gossip carries the ring. Stale versions lose.",
    pkg: "internal/membership · internal/ring",
    demo: (
      <div className="ln-mini-row">
        <span className="chip dark">
          <IconCheck size="0.8rem" /> ring v8 · accept
        </span>
        <span className="chip outline">
          <IconX size="0.8rem" /> ring v7 · ignore
        </span>
      </div>
    ),
  },
];

const CALLERS = [
  { name: "Read-repair", note: "a get sees disagreeing replicas", Icon: IconEye },
  { name: "Scrubber", note: "a timer finds a bad checksum", Icon: IconScan },
  { name: "Hint replay", note: "a dead node comes back", Icon: IconBookmark },
];

const NOT_BUILT = [
  ["Ring placement", "not a Raft metadata cluster"],
  ["Last-writer-wins versions", "not version vectors"],
  ["Checksums and a key scan", "not Merkle trees"],
  ["3× replication", "not erasure coding"],
];

export default function Requirements() {
  const headRef = useReveal();
  const gridRef = useReveal("0px 0px -6% 0px");
  const stripRef = useReveal();

  return (
    <section className="ln-section ln-design" id="design" aria-labelledby="ln-design-title">
      <header className="ln-section-head ln-reveal" ref={headRef}>
        <p className="ln-eyebrow">
          <span className="ln-eyebrow-num">02</span> Requirement → technique
        </p>
        <h2 id="ln-design-title" className="ln-h2">
          How storage breaks.
        </h2>
        <p className="ln-intro">One answer for each. The diagrams are examples, not live data.</p>
      </header>

      <div className="ln-req-grid" ref={gridRef}>
        {CARDS.map(({ need, Icon, how, pkg, demo }, i) => (
          <article key={need} className="ln-req ln-reveal surface-card" style={{ "--i": i }}>
            <div className="ln-req-top">
              <span className="ln-req-icon">
                <Icon size="1.2rem" />
              </span>
              <span className="ln-req-n num">{String(i + 1).padStart(2, "0")}</span>
            </div>
            <h3 className="ln-req-need">{need}</h3>
            <p className="ln-req-how">{how}</p>
            <div className="ln-req-demo">{demo}</div>
            <p className="ln-req-pkg">
              <code>{pkg}</code>
            </p>
          </article>
        ))}

        <article className="ln-req ln-req-dark ln-reveal" style={{ "--i": CARDS.length }}>
          <div className="ln-req-dark-copy">
            <div className="ln-req-top">
              <span className="ln-req-icon">
                <IconWrench size="1.2rem" />
              </span>
              <span className="ln-req-n num">10</span>
            </div>
            <h3 className="ln-req-need">Automatic repair</h3>
            <p className="ln-req-how">
              There is exactly one repair path. Three different triggers call the same <code>Repair(key)</code>: fetch
              the metadata, pick the highest version with an intact checksum, push it to every live preferred node that
              lacks it, drop stale and corrupt copies.
            </p>
            <p className="ln-req-pkg">
              <code>internal/repair</code>
            </p>
          </div>
          <ol className="ln-callers">
            {CALLERS.map(({ name, note, Icon }) => (
              <li key={name} className="ln-caller">
                <span className="ln-caller-bubble">
                  <Icon size="1.15rem" />
                </span>
                <span className="ln-caller-text">
                  <b>{name}</b>
                  <small>{note}</small>
                </span>
                <span className="ln-caller-to">
                  <IconArrowRight size="0.95rem" />
                  <span className="sr-only">calls</span>
                </span>
              </li>
            ))}
            <li className="ln-caller-sink">
              <code>Repair(key)</code>
            </li>
          </ol>
        </article>
      </div>

      <div className="ln-notbuilt ln-reveal" ref={stripRef}>
        <p className="ln-notbuilt-title">Chosen on purpose</p>
        <ul className="ln-notbuilt-list">
          {NOT_BUILT.map(([yes, no]) => (
            <li key={yes}>
              <b>{yes}</b>
              <span>{no}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
