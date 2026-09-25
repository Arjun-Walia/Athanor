import { useMemo, useState } from "react";
import { Icon } from "../icons.jsx";
import { Card, Empty, inkOn, nodeTone } from "../components.jsx";
import { groupEvents } from "../story.js";
import { clock, nodeShort } from "../format.js";

const KINDS = [
  ["all", "All"],
  ["membership", "Membership"],
  ["write", "Writes"],
  ["read", "Reads"],
  ["hint", "Hints"],
  ["repair", "Repairs"],
  ["scrub", "Scrub"],
  ["rebalance", "Rebalance"],
  ["fault", "Faults"],
  ["config", "Policy"],
];

const LEVEL = {
  ok: { icon: "Check", label: "ok" },
  info: { icon: "Info", label: "info" },
  warn: { icon: "Alert", label: "warning" },
  error: { icon: "X", label: "error" },
};

export default function Events({ events, nodes, initialKind }) {
  const [kind, setKind] = useState(initialKind || "all");
  const [query, setQuery] = useState("");
  const ids = nodes.map((n) => n.id);

  const rows = useMemo(() => {
    const grouped = groupEvents(events);
    const q = query.trim().toLowerCase();
    return grouped
      .filter((e) => kind === "all" || e.kind === kind)
      .filter((e) => !q || e.message.toLowerCase().includes(q) || (e.key || "").toLowerCase().includes(q))
      .reverse();
  }, [events, kind, query]);

  return (
    <div className="ath-page ath-events">
      <div className="ath-hero">
        <h1 className="ath-headline">Events</h1>
      </div>
      <Card className="ath-log-card">
        <div className="ath-log-tools">
          <div className="pill-group ath-kind-pills" role="group" aria-label="Filter by kind">
            {KINDS.map(([id, label]) => (
              <button key={id} type="button" className={`pill-btn${kind === id ? " is-active" : ""}`} aria-pressed={kind === id} onClick={() => setKind(id)}>
                {label}
              </button>
            ))}
          </div>
          <label className="ath-input-row is-compact">
            <Icon.Search size={15} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search messages" aria-label="Search messages" />
          </label>
        </div>
        <p className="ath-log-count">
          {rows.length === events.length ? `${rows.length} events` : `${rows.length} of ${events.length} events`}
          {" · merged from every reachable node · in memory, 1,000 per node"}
        </p>
        {rows.length === 0 ? (
          <Empty icon="Activity" title="No events match">
            Kill a node, corrupt a replica, or upload a file, and the log fills in.
          </Empty>
        ) : (
          <ol className="ath-log">
            {rows.map((e) => {
              const lv = LEVEL[e.level] || LEVEL.info;
              const I = Icon[lv.icon];
              return (
                <li key={e.id} className={`is-${e.level}`}>
                  <span className="ath-log-time num">{clock(e.at)}</span>
                  <span className={`ath-log-level is-${e.level}`} title={lv.label}>
                    <I size={12} strokeWidth={2.6} />
                    <span className="sr-only">{lv.label}</span>
                  </span>
                  <span className="ath-log-kind">{e.kind}</span>
                  <span className="ath-log-msg">{e.message}</span>
                  <span className="ath-log-nodes" aria-label={`from ${e.observers.join(", ")}`}>
                    {e.observers.map((o) => (
                      <span key={o} className="ath-avatar" style={{ background: nodeTone(o, ids), color: inkOn(nodeTone(o, ids)) }} title={o}>
                        {nodeShort(o)}
                      </span>
                    ))}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </Card>
    </div>
  );
}
