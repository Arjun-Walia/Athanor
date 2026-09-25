import { useReveal } from "./hooks.js";
import {
  IconBookmark,
  IconEye,
  IconLayers,
  IconPulse,
  IconRadio,
  IconScan,
  IconShield,
  IconShuffle,
  IconSync,
  IconUnlink,
  IconWrench,
  IconZap,
} from "./icons.jsx";

// The requirement → technique table from PLAN.md, section 4, one line each.
// Every row names the package that does it, so a reader can go and check.
const ROWS = [
  { need: "Replication", how: "Write to N owners, answer after W acks.", pkg: "replica", Icon: IconLayers },
  { need: "Retrieval", how: "Read R copies, return the newest one whose checksum matches.", pkg: "replica", Icon: IconEye },
  { need: "Concurrent writes", how: "Hybrid-clock versions, last writer wins, ties broken by origin.", pkg: "replica", Icon: IconSync },
  { need: "Node failures", how: "SWIM probes: suspect after missed probes, then dead by gossip.", pkg: "membership", Icon: IconPulse },
  { need: "Partial partitions", how: "Sloppy quorum: the next healthy node parks a hint for the one that is cut off.", pkg: "replica", Icon: IconUnlink },
  { need: "Corruption", how: "SHA-256 stored with every replica, re-checked on every read.", pkg: "store", Icon: IconZap },
  { need: "Integrity checks", how: "A scrubber re-hashes every local copy on a timer.", pkg: "repair", Icon: IconScan },
  { need: "Replica inconsistency", how: "Read-repair pushes the winner to any copy that disagrees.", pkg: "repair", Icon: IconShield },
  { need: "Rebalancing", how: "On a ring change, keys move to their new owners at a bounded rate.", pkg: "repair", Icon: IconShuffle },
  { need: "Metadata consistency", how: "Ring version and member set travel by gossip; stale versions lose.", pkg: "membership", Icon: IconRadio },
  { need: "Automatic repair", how: "One Repair(key) for read-repair, scrub, and hint replay.", pkg: "repair", Icon: IconWrench },
  { need: "Bounded cost", how: "3× storage, stated plainly. No erasure coding.", pkg: "api", Icon: IconBookmark },
];

export default function Handles() {
  const headRef = useReveal();
  const listRef = useReveal("0px 0px -6% 0px");
  return (
    <section className="ln-handles" id="handles" aria-labelledby="ln-handles-title">
      <header className="ln-section-head ln-reveal" ref={headRef}>
        <p className="ln-eyebrow">What it handles</p>
        <h2 id="ln-handles-title" className="ln-h2">
          Twelve ways storage breaks. One answer each.
        </h2>
        <p className="ln-intro">The requirement list from the design plan, and the package that answers it.</p>
      </header>
      <ol className="ln-handles-list" ref={listRef}>
        {ROWS.map(({ need, how, pkg, Icon }, i) => (
          <li key={need} className="ln-handle ln-reveal" style={{ "--i": i % 6 }}>
            <span className="ln-handle-icon">
              <Icon size="1rem" />
            </span>
            <span className="ln-handle-need">{need}</span>
            <span className="ln-handle-how">{how}</span>
            <code className="ln-handle-pkg">internal/{pkg}</code>
          </li>
        ))}
      </ol>
    </section>
  );
}
