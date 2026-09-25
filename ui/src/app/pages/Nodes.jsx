import { useEffect, useState } from "react";
import { Icon } from "../icons.jsx";
import { Card, CardHead, Menu, MenuItem, MenuLabel, StatusBadge, inkOn, nodeTone } from "../components.jsx";
import { HashRing } from "../viz.jsx";
import { api } from "../api.js";
import { ago, bytes } from "../format.js";

function KeyLookup({ base, onPlacement, placement }) {
  const [key, setKey] = useState("report.pdf");
  const [error, setError] = useState(null);

  const lookup = async (k) => {
    if (!k.trim()) {
      onPlacement(null);
      return;
    }
    try {
      const r = await api.ring(base, k.trim());
      setError(null);
      onPlacement(r.placement || null);
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <form
      className="ath-lookup"
      onSubmit={(e) => {
        e.preventDefault();
        lookup(key);
      }}
    >
      <label className="ath-field">
        <span>Where does a key live?</span>
        <span className="ath-input-row">
          <Icon.Search size={16} />
          <input value={key} onChange={(e) => setKey(e.target.value)} spellCheck="false" placeholder="any/object/key" />
          <button type="submit" className="ath-pill-action is-dark">
            Place
          </button>
        </span>
      </label>
      {error ? <p className="ath-error">{error}</p> : null}
      {placement ? (
        <div className="ath-placement">
          <p>
            <span className="mono">{placement.key}</span> hashes to{" "}
            <span className="num">{(placement.pos * 360).toFixed(1)}°</span>. Walking clockwise:
          </p>
          <ol>
            {placement.preference.map((id, i) => (
              <li key={id}>
                <span className="chip dark num">{i + 1}</span> {id}
              </li>
            ))}
          </ol>
          {placement.fallbacks?.length ? (
            <p className="ath-muted">Hint fallbacks if an owner is down: {placement.fallbacks.join(" → ")}</p>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

function NodeCard({ n, all, ov, actions, now }) {
  const tone = nodeTone(n.id, all.map((x) => x.id));
  const down = n.status === "dead" || n.status === "stopped" || n.status === "unknown";
  const others = all.filter((x) => x.id !== n.id);
  const agrees = !n.ring_digest || n.ring_digest === ov.ring_digest;
  return (
    <Card as="article" className={`ath-nodecard${down ? " is-down" : ""}`}>
      <header className="ath-nodecard-head">
        <span className="ath-node-tile is-lg" style={{ "--tone": tone, "--ink": inkOn(tone) }} aria-hidden="true">
          <Icon.Server size={24} />
        </span>
        <div>
          <h3 className="ath-nodecard-name">
            {n.id} {n.self ? <span className="chip outline">coordinator</span> : null}
          </h3>
          <StatusBadge status={n.status} partitioned={n.partitioned} />
        </div>
        <Menu label={`More actions for ${n.id}`}>
          <MenuLabel>Cut the network between…</MenuLabel>
          {others.map((o) => (
            <MenuItem key={o.id} icon="Scissors" onSelect={() => actions.partition(n.id, o.id)}>
              {n.id} ↔ {o.id}
            </MenuItem>
          ))}
          {n.public_url ? (
            <>
              <MenuLabel>Direct</MenuLabel>
              <a className="ath-menu-item" role="menuitem" href={n.public_url} target="_blank" rel="noreferrer">
                <Icon.Link size={16} />
                <span>{n.public_url}</span>
              </a>
            </>
          ) : null}
        </Menu>
      </header>
      <dl className="ath-nodecard-stats">
        <div>
          <dt>Objects</dt>
          <dd className="num">{n.counted ? n.objects : "–"}</dd>
        </div>
        <div>
          <dt>On disk</dt>
          <dd className="num">{n.counted ? bytes(n.bytes) : "–"}</dd>
        </div>
        <div>
          <dt>Hints held</dt>
          <dd className="num">{n.counted ? n.hints : "–"}</dd>
        </div>
      </dl>
      <dl className="ath-nodecard-addr">
        <div>
          <dt>gRPC</dt>
          <dd className="mono">{n.grpc_addr || "—"}</dd>
        </div>
        <div>
          <dt>Gossip</dt>
          <dd className="mono">{n.gossip_addr || "—"}</dd>
        </div>
        <div>
          <dt>Ring</dt>
          <dd>
            {n.in_ring ? `v${n.self ? ov.ring_version : n.ring_version}` : "removed"}{" "}
            {agrees ? <Icon.Check size={13} title="Same member set as the coordinator" /> : <Icon.Alert size={13} title="Different member set" />}
          </dd>
        </div>
        <div>
          <dt>Since</dt>
          <dd>{ago(n.since, now)}</dd>
        </div>
      </dl>
      <footer className="ath-nodecard-foot">
        {down ? (
          <button type="button" className="ath-pill-action is-dark" onClick={() => actions.startNode(n.id)}>
            <Icon.Play size={15} /> Start {n.id}
          </button>
        ) : (
          <button type="button" className="ath-pill-action is-danger" onClick={() => actions.stopNode(n.id)}>
            <Icon.Power size={15} /> Stop {n.id}
          </button>
        )}
        {n.counted && n.tampered ? (
          <span className="chip red">
            <Icon.Zap size={13} /> {n.tampered} flipped
          </span>
        ) : null}
      </footer>
    </Card>
  );
}

export default function Nodes({ ov, ring, base, actions, now }) {
  const [placement, setPlacement] = useState(null);
  const nodes = ov.nodes ?? [];
  const ids = ring?.nodes ?? [];
  const parts = ov.partitions ?? [];

  // Re-place the key when the ring changes so the trace stays truthful.
  useEffect(() => {
    if (!placement) return undefined;
    let live = true;
    api
      .ring(base, placement.key)
      .then((r) => live && setPlacement(r.placement || null))
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ring?.version, ring?.digest, ov.config.quorum.n]);

  return (
    <div className="ath-page ath-nodes">
      <div className="ath-hero">
        <h1 className="ath-headline">Ring</h1>
        <p className="ath-lede">
          {ids.length === 1 ? "1 node" : `${ids.length} nodes`}
          {ring ? ` · ${Math.round(ring.tokens.length / Math.max(1, ids.length))} vnodes` : ""}
        </p>
      </div>
      <div className="ath-nodes-layout">
        <Card className="ath-ringcard">
          <CardHead title="Consistent-hash ring">
            <span className="chip">v{ov.ring_version}</span>
          </CardHead>
          <HashRing ring={ring} nodes={nodes} placement={placement} />
          <ul className="ath-legend">
            {ids.map((id) => {
              const n = nodes.find((x) => x.id === id);
              const tone = nodeTone(id, ids);
              return (
                <li key={id}>
                  <span className="ath-swatch" style={{ background: tone }} aria-hidden="true" />
                  {id}
                  {n ? <StatusBadge status={n.status} compact /> : null}
                </li>
              );
            })}
          </ul>
          <KeyLookup base={base} placement={placement} onPlacement={setPlacement} />
        </Card>
        <div className="ath-nodegrid">
          {parts.length ? (
            <Card className="ath-partition-note">
              <Icon.Scissors size={18} />
              <p>
                <strong>{ov.coordinator}</strong> is cut off from {parts.join(", ")}.
              </p>
              <button type="button" className="ath-pill-action is-dark" onClick={actions.heal}>
                <Icon.Link size={15} /> Heal
              </button>
            </Card>
          ) : null}
          {nodes.map((n) => (
            <NodeCard key={n.id} n={n} all={nodes} ov={ov} actions={actions} now={now} />
          ))}
        </div>
      </div>
    </div>
  );
}
