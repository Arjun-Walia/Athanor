import { useMemo, useRef, useState } from "react";
import { Icon } from "../icons.jsx";
import { Card, CardHead, Empty, Menu, MenuItem, MenuLabel, REPLICA, ReplicaDot } from "../components.jsx";
import { ago, bytes, clock, ms, shortSum, shortVersion, versionTime } from "../format.js";

function Uploader({ actions, quorum }) {
  const [file, setFile] = useState(null);
  const [key, setKey] = useState("");
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const input = useRef(null);

  const choose = (f) => {
    if (!f) return;
    setFile(f);
    setKey((k) => (k && file && k !== file.name ? k : f.name));
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!file || !key.trim()) return;
    setBusy(true);
    setResult(await actions.put(key.trim(), file));
    setBusy(false);
  };

  return (
    <Card className="ath-upload">
      <CardHead title="Upload">
        <span className="chip">
          waits for W={quorum.w} of N={quorum.n}
        </span>
      </CardHead>
      <form onSubmit={submit}>
        <label
          className={`ath-drop${drag ? " is-drag" : ""}${file ? " has-file" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            choose(e.dataTransfer.files?.[0]);
          }}
        >
          <input ref={input} type="file" className="sr-only" onChange={(e) => choose(e.target.files?.[0])} />
          <span className="ath-drop-icon">
            <Icon.Upload size={22} />
          </span>
          {file ? (
            <span>
              <strong>{file.name}</strong>
              <br />
              {bytes(file.size)} · {file.type || "binary"}
            </span>
          ) : (
            <span>
              <strong>Drop a file</strong> or click to choose one
            </span>
          )}
        </label>
        <label className="ath-field">
          <span>Key</span>
          <span className="ath-input-row">
            <Icon.Hash size={16} />
            <input value={key} onChange={(e) => setKey(e.target.value)} spellCheck="false" placeholder="reports/q3.pdf" />
          </span>
        </label>
        <button type="submit" className="ath-pill-action is-dark is-wide" disabled={!file || !key.trim() || busy}>
          {busy ? "Waiting for acks…" : "Store it"}
        </button>
      </form>
      {result ? <WriteReceipt result={result} /> : null}
    </Card>
  );
}

function WriteReceipt({ result }) {
  if (result.error) {
    return (
      <div className="ath-receipt is-error" role="alert">
        <p>
          <Icon.Alert size={15} /> {result.error}
        </p>
        {result.body?.acks?.length ? <p>Acked by {result.body.acks.map((a) => a.node).join(", ")} before giving up.</p> : null}
      </div>
    );
  }
  const r = result.body;
  return (
    <div className="ath-receipt">
      <p className="ath-receipt-title">
        <Icon.Check size={15} /> 201 in {ms(r.took_ms)} via {r.coordinator}
      </p>
      <ul>
        {r.acks.map((a) => (
          <li key={a.node}>
            <span className={`chip ${a.hint_for ? "yellow" : "dark"}`}>{a.node}</span>
            {a.hint_for ? <span>hint for {a.hint_for}</span> : <span>replica</span>}
            <span className="num">{ms(a.took_ms)}</span>
          </li>
        ))}
      </ul>
      <p className="ath-muted">
        Owners: {r.preference.join(" → ")}. The rest finish in the background.
      </p>
    </div>
  );
}

function ReadReceipt({ read, onClose }) {
  if (!read) return null;
  return (
    <div className={`ath-receipt${read.error ? " is-error" : ""}`} role="status">
      <button type="button" className="ath-receipt-x" onClick={onClose} aria-label="Close">
        <Icon.X size={14} />
      </button>
      {read.error ? (
        <p>
          <Icon.Alert size={15} /> Read of <span className="mono">{read.key}</span> failed: {read.error}
        </p>
      ) : (
        <>
          <p className="ath-receipt-title">
            <Icon.Eye size={15} /> Read <span className="mono">{read.key}</span> via {read.coordinator} in {ms(read.tookMs)}
            {read.degraded ? <span className="chip yellow">degraded</span> : null}
          </p>
          <ul>
            {read.replicas.map((r) => (
              <li key={r.node}>
                <span className={`chip ${r.status === "ok" ? "dark" : r.status === "hint" ? "yellow" : r.status === "corrupt" ? "red" : ""}`}>{r.node}</span>
                <span>{REPLICA[r.status]?.label || r.status}</span>
              </li>
            ))}
          </ul>
          <p className="ath-muted">
            Verified SHA-256 <span className="mono">{shortSum(read.checksum)}</span>.{" "}
            <a href={read.url} download={read.key.split("/").pop()}>
              Save the bytes
            </a>
          </p>
        </>
      )}
    </div>
  );
}

function Metric({ label, value, note, icon }) {
  const I = Icon[icon];
  return (
    <Card className="ath-metric">
      <span className="ath-metric-icon">
        <I size={16} />
      </span>
      <p className="ath-metric-label">{label}</p>
      <p className="ath-metric-value num">{value}</p>
      <p className="ath-metric-note">{note}</p>
    </Card>
  );
}

export default function Objects({ ov, ring, events, actions, now }) {
  const [read, setRead] = useState(null);
  const [filter, setFilter] = useState("");
  const objects = ov.objects ?? [];
  const ids = ring?.nodes ?? (ov.nodes ?? []).map((n) => n.id);
  const m = ov.metrics;
  const shown = filter ? objects.filter((o) => o.key.toLowerCase().includes(filter.toLowerCase())) : objects;

  const lastRepair = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.kind === "repair" && e.level === "ok" && e.fields?.micros) return e;
    }
    return null;
  }, [events]);

  const doRead = async (key) => {
    const res = await actions.read(key);
    setRead((old) => {
      if (old?.url) URL.revokeObjectURL(old.url);
      return res;
    });
  };

  return (
    <div className="ath-page ath-objects">
      <div className="ath-hero">
        <h1 className="ath-headline">Objects and where every copy lives</h1>
      </div>
      <div className="ath-metrics">
        <Metric
          icon="Layers"
          label="Storage overhead"
          value={m.objects ? `${m.overhead.toFixed(2)}×` : `${m.policy_overhead}×`}
          note={
            m.complete
              ? `${m.policy_overhead}× by policy. RS(4,2) would be ~1.5×; not built.`
              : "Partial: a node did not answer, so its bytes are not counted."
          }
        />
        <Metric
          icon="Heal"
          label="Last repair"
          value={lastRepair ? ms(Number(lastRepair.fields.micros) / 1000) : "—"}
          note={lastRepair ? `${lastRepair.key} · ${ago(lastRepair.t, now)}` : "Nothing has needed healing yet."}
        />
        <Metric
          icon="ShieldAlert"
          label="Under-replicated"
          value={m.under_replicated}
          note={m.complete ? "Fewer verified copies than N on owners." : "Some nodes did not answer; count is partial."}
        />
        <Metric icon="Clock" label="Hints parked" value={m.hints} note="Writes waiting for an owner to come back." />
      </div>
      <div className="ath-objects-layout">
        <Uploader actions={actions} quorum={ov.config.quorum} />
        <Card className="ath-table-card">
          <CardHead title={`Replica map · ${objects.length}`}>
            <label className="ath-input-row is-compact">
              <Icon.Search size={15} />
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter keys" aria-label="Filter keys" />
            </label>
          </CardHead>
          <ReadReceipt read={read} onClose={() => setRead(null)} />
          {objects.length === 0 ? (
            <Empty icon="Box" title="No objects yet">
              Upload a file. Its row shows a dot for each node that holds a copy.
            </Empty>
          ) : (
            <div className="ath-table-wrap">
              <table className="ath-table">
                <thead>
                  <tr>
                    <th scope="col">Object</th>
                    <th scope="col">Version</th>
                    <th scope="col">
                      Replicas <span className="ath-th-sub">{ids.map((id) => id.replace("node", "n")).join(" ")}</span>
                    </th>
                    <th scope="col">SHA-256</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((o) => {
                    const byNode = new Map(o.replicas.map((r) => [r.node, r]));
                    const holders = o.replicas.filter((r) => ["ok", "stale", "extra", "tampered"].includes(r.status));
                    const t = versionTime(o.version);
                    return (
                      <tr key={o.key} className={o.under_replicated ? "is-under" : ""}>
                        <th scope="row">
                          <span className="ath-obj">
                            <span className="ath-obj-icon">
                              <Icon.File size={16} />
                            </span>
                            <span>
                              <span className="ath-obj-key">{o.key}</span>
                              <span className="ath-obj-meta">
                                {bytes(o.size)} · {o.content_type?.split(";")[0] || "binary"}
                              </span>
                            </span>
                          </span>
                        </th>
                        <td>
                          <span className="mono" title={o.version}>
                            {shortVersion(o.version)}
                          </span>
                          <span className="ath-obj-meta">
                            {o.origin} · {t ? clock(t) : ""}
                          </span>
                        </td>
                        <td>
                          <span className="ath-dots">
                            {ids.map((id) => {
                              const r = byNode.get(id);
                              return r ? (
                                <ReplicaDot key={id} replica={r} />
                              ) : (
                                <span key={id} className="ath-rdot is-none" title={`${id}: not an owner`} aria-hidden="true" />
                              );
                            })}
                          </span>
                          <span className={`ath-obj-meta${o.under_replicated ? " is-warn" : ""}`}>
                            {o.healthy}/{o.target} verified{o.under_replicated ? " · healing" : ""}
                          </span>
                        </td>
                        <td>
                          <span className="ath-sum" title={o.checksum}>
                            <Icon.Shield size={14} />
                            <span className="mono">{shortSum(o.checksum)}</span>
                          </span>
                        </td>
                        <td className="ath-row-actions">
                          <button type="button" className="ath-icon-sm" onClick={() => doRead(o.key)} title="Read through the quorum" aria-label={`Read ${o.key}`}>
                            <Icon.Eye size={16} />
                          </button>
                          <Menu label={`Actions for ${o.key}`} buttonClass="ath-icon-sm">
                            <MenuLabel>Flip a byte on…</MenuLabel>
                            {holders.length === 0 ? <MenuItem disabled>No replica reachable</MenuItem> : null}
                            {holders.map((r) => (
                              <MenuItem key={r.node} icon="Zap" tone="danger" onSelect={() => actions.corrupt(o.key, r.node)}>
                                {r.node}
                              </MenuItem>
                            ))}
                            <MenuLabel>Heal</MenuLabel>
                            <MenuItem icon="Heal" onSelect={() => actions.repair(o.key)}>
                              Repair now
                            </MenuItem>
                            <MenuItem icon="Trash" tone="danger" onSelect={() => actions.del(o.key)}>
                              Delete (tombstone)
                            </MenuItem>
                          </Menu>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <ul className="ath-dotlegend" aria-label="Replica legend">
            {["ok", "hint", "stale", "missing", "tampered", "unreachable", "extra"].map((s) => (
              <li key={s}>
                <ReplicaDot replica={{ node: "", status: s }} size="sm" /> {REPLICA[s].short}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
