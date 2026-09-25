import { useEffect, useState } from "react";
import { getJSON } from "../api.js";

const TOPOLOGY = ["node1", "node2", "node3", "node4", "node5"];

export default function Cluster({ base }) {
  const [state, setState] = useState({ status: "loading" });

  useEffect(() => {
    const ctrl = new AbortController();
    setState({ status: "loading" });
    Promise.all([
      getJSON(base, "/v1/admin/health", ctrl.signal),
      getJSON(base, "/v1/admin/cluster", ctrl.signal),
    ])
      .then(([health, cluster]) => setState({ status: "ok", health, cluster }))
      .catch((error) => {
        if (error.name === "AbortError") return;
        setState({ status: "offline", error: error.message });
      });
    return () => ctrl.abort();
  }, [base]);

  const quorum = state.health?.quorum ?? { n: 3, w: 2, r: 2 };

  return (
    <div className="page">
      <section className="panel">
        <header className="panel-head">
          <h2>This process</h2>
          <Status state={state} />
        </header>
        {state.status === "ok" ? (
          <dl className="facts">
            <div>
              <dt>Node</dt>
              <dd>{state.health.node_id}</dd>
            </div>
            <div>
              <dt>Mode</dt>
              <dd>{state.health.mode}</dd>
            </div>
            <div>
              <dt>Ring version</dt>
              <dd>{state.cluster.ring_version}</dd>
            </div>
            <div>
              <dt>Membership</dt>
              <dd>{state.cluster.implemented ? "live" : "not running"}</dd>
            </div>
          </dl>
        ) : (
          <p className="muted">
            {state.status === "loading"
              ? "Contacting the node."
              : `No answer from ${base}. Start vault-node or compose, then point this field at its HTTP port.`}
          </p>
        )}
      </section>

      <section className="panel">
        <header className="panel-head">
          <h2>Durability</h2>
          <p className="muted">Slider is Phase F. The default policy is fixed.</p>
        </header>
        <div className="quorum" aria-label="N W R">
          <Meter label="N" value={quorum.n} hint="replicas" />
          <Meter label="W" value={quorum.w} hint="write acks" />
          <Meter label="R" value={quorum.r} hint="read replicas" />
        </div>
      </section>

      <section className="split">
        <div className="panel">
          <header className="panel-head">
            <h2>Nodes</h2>
          </header>
          <ul className="cards">
            {(state.cluster?.nodes ?? []).map((node) => (
              <li key={node.id} className="card">
                <span className={`dot ${node.status}`} aria-hidden="true" />
                <span className="card-id">{node.id}</span>
                <span className="card-meta">{state.cluster.implemented ? node.status : "process up"}</span>
                <span className="card-meta">{node.http_addr}</span>
              </li>
            ))}
            {state.status === "ok" && state.cluster.nodes.length === 0 && (
              <li className="muted">No members reported.</li>
            )}
          </ul>
        </div>
        <div className="panel">
          <header className="panel-head">
            <h2>Compose topology</h2>
            <p className="muted">Static legend for deploy/docker-compose.yml. Not a live ring.</p>
          </header>
          <Ring />
        </div>
      </section>

      <section className="panel">
        <header className="panel-head">
          <h2>Chaos</h2>
          <p className="muted">Buttons call admin endpoints in Phase C. They do nothing now.</p>
        </header>
        <div className="actions">
          <button type="button" disabled>Kill node</button>
          <button type="button" disabled>Start node</button>
          <button type="button" disabled>Corrupt replica</button>
        </div>
      </section>
    </div>
  );
}

function Status({ state }) {
  if (state.status === "loading") return <span className="pill">checking</span>;
  if (state.status === "ok") return <span className="pill ok">process up</span>;
  return <span className="pill bad">offline</span>;
}

function Meter({ label, value, hint }) {
  return (
    <div className="meter">
      <span className="meter-label">{label}</span>
      <span className="meter-value">{value}</span>
      <span className="meter-hint">{hint}</span>
    </div>
  );
}

function Ring() {
  const radius = 72;
  const center = 96;
  return (
    <svg className="ring" viewBox="0 0 192 192" role="img" aria-label="Five compose nodes around a ring">
      <circle cx={center} cy={center} r={radius} />
      {TOPOLOGY.map((id, index) => {
        const angle = (Math.PI * 2 * index) / TOPOLOGY.length - Math.PI / 2;
        const x = center + radius * Math.cos(angle);
        const y = center + radius * Math.sin(angle);
        return (
          <g key={id}>
            <circle cx={x} cy={y} r="4" className="ring-node" />
            <text x={x} y={y + (y < center ? -10 : 16)} textAnchor="middle">
              {id}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
