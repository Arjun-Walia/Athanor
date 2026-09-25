import { useMemo, useState } from "react";
import { Icon } from "../icons.jsx";
import { Card, CardHead, CornerLink, Disclosure, Menu, MenuItem, MenuLabel, StatusBadge, nodeTone, inkOn } from "../components.jsx";
import { Dial, NodeBars, Timeline } from "../viz.jsx";
import { DEMO_STEPS, demoProgress } from "../story.js";
import { ago, bytes, clock, mmss, plural } from "../format.js";

function headline(ov) {
  const nodes = ov.nodes ?? [];
  const down = nodes.filter((n) => n.status === "dead" || n.status === "stopped");
  const suspect = nodes.filter((n) => n.status === "suspect");
  const m = ov.metrics;
  if (down.length === 1) return `${down[0].id} is down. Reads still answer.`;
  if (down.length > 1) return `${down.length} nodes are down. Checking quorum.`;
  if (m.tampered > 0) return "A flipped byte is waiting to be caught.";
  if (m.under_replicated > 0) return `${plural(m.under_replicated, "object")} healing.`;
  if (suspect.length) return `${suspect[0].id} is missing probes.`;
  if (!m.objects) return "The furnace is lit. Nothing stored yet.";
  return `${nodes.length} nodes. Every replica verified.`;
}

/** Replica slots on preferred nodes, classified for the segmented bar. */
function slotBreakdown(objects) {
  const out = { verified: 0, hinted: 0, healing: 0, flipped: 0, total: 0 };
  for (const o of objects) {
    const hintFor = new Set(o.replicas.filter((r) => r.status === "hint").map((r) => r.hint_for));
    for (const r of o.replicas) {
      if (!r.preferred) continue;
      out.total++;
      if (r.status === "ok") out.verified++;
      else if (r.status === "tampered") out.flipped++;
      else if (hintFor.has(r.node)) out.hinted++;
      else out.healing++;
    }
  }
  return out;
}

function HealthBar({ objects }) {
  const b = slotBreakdown(objects);
  const segs = [
    { key: "verified", label: "Verified", cls: "is-dark" },
    { key: "hinted", label: "Hinted", cls: "is-yellow" },
    { key: "healing", label: "Healing", cls: "is-hatched" },
    { key: "flipped", label: "Flipped", cls: "is-outline" },
  ];
  if (b.total === 0) {
    return (
      <div className="ath-health">
        <div className="ath-health-seg is-hatched is-empty" style={{ flexGrow: 1 }}>
          <span className="ath-health-label">Replica slots</span>
          <span className="ath-health-bar">No objects yet</span>
        </div>
      </div>
    );
  }
  return (
    <div className="ath-health" role="list" aria-label="Replica health across every preferred slot">
      {segs.map((s) => {
        const pct = Math.round((b[s.key] / b.total) * 100);
        if (b[s.key] === 0 && s.key !== "verified") {
          return (
            <div key={s.key} className={`ath-health-seg ${s.cls} is-zero`} role="listitem" style={{ flexGrow: 0.0001 }}>
              <span className="ath-health-label">{s.label}</span>
              <span className="ath-health-bar num">0%</span>
            </div>
          );
        }
        return (
          <div key={s.key} className={`ath-health-seg ${s.cls}`} role="listitem" style={{ flexGrow: Math.max(b[s.key], b.total * 0.08) }}>
            <span className="ath-health-label">{s.label}</span>
            <span className="ath-health-bar num">
              {pct}%<span className="sr-only"> ({b[s.key]} of {b.total} slots)</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function BigStat({ icon, value, label }) {
  const I = Icon[icon];
  return (
    <div className="ath-bigstat">
      <span className="ath-bigstat-row">
        <span className="ath-bigstat-icon">
          <I size={15} />
        </span>
        <span className="ath-bigstat-value num">{value}</span>
      </span>
      <span className="ath-bigstat-label">{label}</span>
    </div>
  );
}

function CoordinatorCard({ ov, self }) {
  const q = ov.config.quorum;
  return (
    <Card className="ath-coord">
      <div className="ath-coord-art" aria-hidden="true">
        <span className="ath-orb" />
        <span className="ath-orbit o1" />
        <span className="ath-orbit o2" />
        <span className="ath-orbit o3" />
      </div>
      <div className="ath-coord-top">
        <span className="chip dark">
          <Icon.Plug size={13} /> Coordinator
        </span>
        <span className={`chip ${ov.converged ? "" : "yellow"}`} title="Do all reachable nodes agree on ring membership?">
          {ov.converged ? <Icon.Check size={13} /> : <Icon.Alert size={13} />}
          {ov.converged ? "ring agreed" : "ring converging"}
        </span>
        <span className={`chip ${ov.ready ? "" : "red"}`} title="Can a write from this node reach W right now?">
          {ov.ready ? <Icon.Check size={13} /> : <Icon.X size={13} />}
          {ov.ready ? "ready" : "not ready"}
        </span>
      </div>
      <div className="ath-coord-foot">
        <div>
          <p className="ath-coord-name">{ov.coordinator}</p>
          <p className="ath-coord-role">
            gRPC {self?.grpc_addr || "—"} · ring v{ov.ring_version}
          </p>
        </div>
        <span className="ath-coord-pill num" title="N / W / R">
          {q.n} / {q.w} / {q.r}
        </span>
      </div>
    </Card>
  );
}

function ReplicasCard({ ov, go }) {
  const nodes = (ov.nodes ?? []).filter((n) => n.in_ring);
  const total = nodes.reduce((s, n) => s + (n.objects || 0), 0);
  return (
    <Card className="ath-replicas">
      <CardHead title="Replicas">
        <CornerLink label="Open nodes" onClick={() => go("nodes")} />
      </CardHead>
      <div className="ath-replicas-sum">
        <span className="ath-replicas-num num">{total}</span>
        <span className="ath-replicas-sub">
          copies on
          <br />
          {plural(nodes.length, "node")}
        </span>
      </div>
      <NodeBars focus={ov.coordinator} nodes={nodes.map((n) => ({ id: n.id, value: n.objects || 0, status: n.status }))} />
    </Card>
  );
}

function ScrubCard({ ov, now, onScrub, busy, go }) {
  const s = ov.scrub;
  const every = (s.every_seconds || 30) * 1000;
  const next = Date.parse(s.next_at);
  const valid = Number.isFinite(next) && next > 0 && next > Date.parse("2001-01-01");
  const remaining = valid ? Math.max(0, next - now) : every;
  const fraction = 1 - remaining / every;
  const last = Date.parse(s.last_at);
  const hasLast = Number.isFinite(last) && last > Date.parse("2001-01-01");
  return (
    <Card className="ath-scrub">
      <CardHead title="Scrubber">
        <CornerLink label="Scrub events" onClick={() => go("events", "scrub")} />
      </CardHead>
      <Dial fraction={fraction} busy={busy || s.running} label={busy ? "…" : mmss(remaining)} sub={`until ${ov.coordinator} re-hashes`} />
      <div className="ath-scrub-foot">
        <button type="button" className="icon-btn" onClick={onScrub} disabled={busy} aria-label="Scrub every node now" title="Scrub every node now">
          <Icon.Play size={18} />
        </button>
        <p className="ath-scrub-last">
          {hasLast ? (
            <>
              Last pass {ago(last, now)}
              <br />
              <span className="num">{s.checked}</span> verified · <span className="num">{s.mismatches}</span> bad
              {s.hints_checked ? (
                <>
                  {" · "}
                  <span className="num">{s.hints_checked}</span> hint{s.hints_checked === 1 ? "" : "s"}
                </>
              ) : null}
            </>
          ) : (
            <>
              First pass pending
              <br />
              every {Math.round(every / 1000)}s per node
            </>
          )}
        </p>
        <span className="icon-btn dark" aria-hidden="true" title="SHA-256 on every replica">
          <Icon.Shield size={18} />
        </span>
      </div>
    </Card>
  );
}

function DurabilityCard({ ov, events, go }) {
  const q = ov.config.quorum;
  const [resetAt, setResetAt] = useState(() => Number(localStorage.getItem("athanor.demoReset") || 0));
  const aliveNow = (ov.nodes ?? []).filter((n) => n.status === "alive").length;
  const steps = useMemo(() => demoProgress(events, resetAt, { aliveNow }), [events, resetAt, aliveNow]);
  const done = steps.filter((s) => s.event).length;
  const overlap = q.w + q.r > q.n;
  const total = q.n + q.w + q.r;
  const segs = [
    { k: "N", v: q.n, label: "replicas", cls: "is-yellow" },
    { k: "W", v: q.w, label: "write acks", cls: "is-dark" },
    { k: "R", v: q.r, label: "read", cls: "is-grey" },
  ];
  const reset = () => {
    const t = Date.now();
    localStorage.setItem("athanor.demoReset", String(t));
    setResetAt(t);
  };
  return (
    <Card className="ath-durability">
      <div className="ath-durability-head">
        <h2 className="ath-card-title">Durability</h2>
        <button type="button" className="ath-durability-big num" onClick={() => go("durability")} title="Change N / W / R">
          {q.n}/{q.w}/{q.r}
        </button>
      </div>
      <div className="ath-nwr">
        {segs.map((s) => (
          <div key={s.k} className="ath-nwr-seg" style={{ flexGrow: s.v / total }}>
            <span className="ath-nwr-label">
              <b>{s.k}</b> {s.v}
            </span>
            <span className={`ath-nwr-bar ${s.cls}`}>{s.label}</span>
          </div>
        ))}
      </div>
      <p className={`ath-overlap ${overlap ? "is-ok" : "is-warn"}`}>
        {overlap ? <Icon.Check size={14} /> : <Icon.Alert size={14} />}
        {overlap ? "W + R > N: a read overlaps the last acked write" : "W + R ≤ N: reads may miss the newest write"}
      </p>

      <div className="ath-stack" aria-hidden="true">
        <span />
        <span />
      </div>
      <div className="ath-demo">
        <div className="ath-demo-head">
          <h3>Demo run</h3>
          <span className="ath-demo-count num">
            {done}/{DEMO_STEPS.length}
          </span>
        </div>
        <ol className="ath-demo-list">
          {steps.map((s) => {
            const I = Icon[s.icon];
            return (
              <li key={s.id} className={s.event ? "is-done" : ""}>
                <span className="ath-demo-bubble">
                  <I size={17} />
                </span>
                <span className="ath-demo-text">
                  <span className="ath-demo-title">{s.title}</span>
                  <span className="ath-demo-sub">{s.event ? (s.event.live ? s.event.live : `${clock(s.event.at)} · ${s.event.node}`) : s.hint}</span>
                </span>
                <span className={`ath-demo-state${s.event ? " is-done" : ""}`}>
                  {s.event ? <Icon.Check size={13} strokeWidth={3} /> : null}
                  <span className="sr-only">{s.event ? "done" : "not yet"}</span>
                </span>
              </li>
            );
          })}
        </ol>
        <button type="button" className="ath-demo-reset" onClick={reset}>
          Start a fresh run
        </button>
      </div>
    </Card>
  );
}

function NodesAccordion({ ov, actions, go }) {
  const nodes = ov.nodes ?? [];
  const ids = nodes.map((n) => n.id);
  const m = ov.metrics;
  const parts = ov.partitions ?? [];
  return (
    <Card className="ath-accordion">
      <Disclosure title="Honest overhead" meta={m.objects ? `${m.overhead.toFixed(1)}×` : "—"}>
        <p className="ath-prose">
          {m.objects
            ? `${bytes(m.physical_bytes)} on disk for ${bytes(m.logical_bytes)}. ${m.overhead.toFixed(1)}× measured.`
            : `${m.policy_overhead}× by policy.`}
        </p>
      </Disclosure>
      <Disclosure title="Nodes" defaultOpen meta={`${nodes.filter((n) => n.status === "alive").length}/${nodes.length}`}>
        <ul className="ath-nodelist">
          {nodes.map((n) => {
            const tone = nodeTone(n.id, ids);
            const down = n.status === "dead" || n.status === "stopped";
            return (
              <li key={n.id}>
                <span className={`ath-node-tile${down ? " is-down" : ""}`} style={{ "--tone": tone, "--ink": inkOn(tone) }} aria-hidden="true">
                  <Icon.Server size={20} />
                </span>
                <span className="ath-nodelist-text">
                  <span className="ath-nodelist-name">
                    {n.id} {n.self ? <span className="chip outline">you</span> : null}
                  </span>
                  <StatusBadge status={n.status} partitioned={n.partitioned} compact />
                </span>
                <span className="ath-nodelist-count num" title="Objects on this node">
                  {n.counted ? n.objects : "–"}
                </span>
                <Menu label={`Actions for ${n.id}`}>
                  <MenuLabel>{n.id}</MenuLabel>
                  {down ? (
                    <MenuItem icon="Play" onSelect={() => actions.startNode(n.id)}>
                      Start node
                    </MenuItem>
                  ) : (
                    <MenuItem icon="Power" tone="danger" onSelect={() => actions.stopNode(n.id)}>
                      Stop node (crash)
                    </MenuItem>
                  )}
                  <MenuItem icon="Nodes" onSelect={() => go("nodes")}>
                    Open on ring
                  </MenuItem>
                </Menu>
              </li>
            );
          })}
        </ul>
      </Disclosure>
      <Disclosure title="Partitions" meta={parts.length ? `${parts.length} cut` : "none"}>
        {parts.length ? (
          <div className="ath-prose">
            <p>Cut off from {parts.join(", ")}.</p>
            <button type="button" className="ath-pill-action" onClick={actions.heal}>
              <Icon.Link size={15} /> Heal all partitions
            </button>
          </div>
        ) : (
          <p className="ath-prose">None. Cut one from Nodes.</p>
        )}
      </Disclosure>
      <Disclosure title="Rebalance" meta={ov.rebalance?.at && Date.parse(ov.rebalance.at) > 0 ? `${ov.rebalance.copied} moved` : "idle"}>
        <p className="ath-prose">
          {ov.rebalance?.at && Date.parse(ov.rebalance.at) > Date.parse("2001-01-01")
            ? `${ov.rebalance.copied} copied · ${ov.rebalance.dropped} dropped`
            : "When the ring changes, and every 30s."}
        </p>
      </Disclosure>
    </Card>
  );
}

const WINDOWS = [
  { ms: 60_000, label: "1 min" },
  { ms: 5 * 60_000, label: "5 min" },
  { ms: 15 * 60_000, label: "15 min" },
];

function ActivityCard({ ov, events, now }) {
  const [win, setWin] = useState(WINDOWS[1].ms);
  const i = WINDOWS.findIndex((w) => w.ms === win);
  const nodes = (ov.nodes ?? []).map((n) => ({ id: n.id, objects: n.counted ? n.objects : null }));
  return (
    <Card className="ath-activity">
      <div className="ath-activity-head">
        <button type="button" className="chip" disabled={i === WINDOWS.length - 1} onClick={() => setWin(WINDOWS[Math.min(WINDOWS.length - 1, i + 1)].ms)}>
          Wider
        </button>
        <h2 className="ath-card-title">Last {WINDOWS[i].label}</h2>
        <button type="button" className="chip" disabled={i === 0} onClick={() => setWin(WINDOWS[Math.max(0, i - 1)].ms)}>
          Closer
        </button>
      </div>
      <Timeline events={events} nodes={nodes} windowMs={win} now={now} />
    </Card>
  );
}

export default function Overview({ ov, events, now, actions, busy, go }) {
  const nodes = ov.nodes ?? [];
  const alive = nodes.filter((n) => n.status === "alive" || n.status === "suspect").length;
  const self = nodes.find((n) => n.self);
  return (
    <div className="ath-page ath-overview">
      <div className="ath-hero">
        <h1 className="ath-headline">{headline(ov)}</h1>
      </div>
      <div className="ath-statrow">
        <HealthBar objects={ov.objects ?? []} />
        <div className="ath-bigstats">
          <BigStat icon="Nodes" value={alive} label={`of ${nodes.length} alive`} />
          <BigStat icon="Box" value={ov.metrics.objects} label="Objects" />
          <BigStat icon="Layers" value={ov.metrics.objects ? `${ov.metrics.overhead.toFixed(1)}×` : `${ov.metrics.policy_overhead}×`} label="Stored per byte" />
        </div>
      </div>
      <div className="ath-grid">
        <CoordinatorCard ov={ov} self={self} />
        <ReplicasCard ov={ov} go={go} />
        <ScrubCard ov={ov} now={now} busy={busy.scrub} onScrub={actions.scrub} go={go} />
        <DurabilityCard ov={ov} events={events} go={go} />
        <NodesAccordion ov={ov} actions={actions} go={go} />
        <ActivityCard ov={ov} events={events} now={now} />
      </div>
    </div>
  );
}
