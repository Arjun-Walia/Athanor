import { useState } from "react";
import { Icon } from "../icons.jsx";
import { Card, CardHead } from "../components.jsx";

function Slider({ name, value, min, max, onChange, help }) {
  return (
    <label className="ath-slider">
      <span className="ath-slider-head">
        <span className="ath-slider-name">{name}</span>
        <span className="ath-slider-value num">{value}</span>
      </span>
      <input type="range" min={min} max={max} step={1} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="ath-slider-help">{help}</span>
    </label>
  );
}

export default function Durability({ ov, actions }) {
  const current = ov.config.quorum;
  const ringSize = (ov.nodes ?? []).filter((n) => n.in_ring).length || 1;
  const maxN = Math.max(1, Math.min(7, ringSize));
  const [draft, setDraft] = useState(current);
  const [busy, setBusy] = useState(false);

  const n = Math.min(draft.n, maxN);
  const w = Math.min(draft.w, n);
  const r = Math.min(draft.r, n);
  const dirty = n !== current.n || w !== current.w || r !== current.r;
  const overlap = w + r - n;

  const apply = async () => {
    setBusy(true);
    await actions.setQuorum({ n, w, r });
    setBusy(false);
  };

  return (
    <div className="ath-page ath-durability-page">
      <div className="ath-hero">
        <h1 className="ath-headline">Durability</h1>
        <p className="ath-lede">{ov.config.version ? `v${ov.config.version} · ${ov.config.origin}` : "Startup default"}</p>
      </div>
      <div className="ath-dur-layout">
        <Card className="ath-dur-controls">
          <CardHead title="Replication">
            <span className="chip dark num">
              {current.n}/{current.w}/{current.r} live
            </span>
          </CardHead>
          <Slider
            name="N · replicas"
            value={n}
            min={1}
            max={maxN}
            onChange={(v) => setDraft((d) => ({ n: v, w: Math.min(d.w, v), r: Math.min(d.r, v) }))}
            help={`Each object is stored on ${n} node${n === 1 ? "" : "s"}. Bounded by the ${ringSize}-node ring.`}
          />
          <Slider
            name="W · write acks"
            value={w}
            min={1}
            max={n}
            onChange={(v) => setDraft((d) => ({ ...d, n, w: v }))}
            help={`A write returns 201 after ${w} replica${w === 1 ? "" : "s"} (or hints) hold it.`}
          />
          <Slider
            name="R · read replicas"
            value={r}
            min={1}
            max={n}
            onChange={(v) => setDraft((d) => ({ ...d, n, r: v }))}
            help={`A read waits for ${r} replica${r === 1 ? "" : "s"} and returns the newest verified one.`}
          />
          <button type="button" className="ath-pill-action is-dark is-wide" onClick={apply} disabled={!dirty || busy}>
            {busy ? "Gossiping…" : dirty ? `Apply ${n}/${w}/${r} to the cluster` : "No change"}
          </button>
        </Card>
        <Card className="ath-dur-explain">
          <CardHead title="Quorum" />
          <div className="ath-quorum-viz" aria-hidden="true">
            {Array.from({ length: n }, (_, i) => {
              const inW = i < w;
              const inR = i >= n - r;
              return (
                <span key={i} className={`ath-qnode${inW ? " is-w" : ""}${inR ? " is-r" : ""}`}>
                  <Icon.Server size={18} />
                  <small>{inW && inR ? "W+R" : inW ? "W" : inR ? "R" : ""}</small>
                </span>
              );
            })}
          </div>
          <ul className="ath-facts">
            <li className={overlap > 0 ? "is-ok" : "is-warn"}>
              {overlap > 0 ? <Icon.Check size={16} /> : <Icon.Alert size={16} />}
              <span>{overlap > 0 ? `Reads overlap the last write by ${overlap}.` : "Reads can miss the newest write."}</span>
            </li>
            <li>
              <Icon.Upload size={16} />
              <span>
                Writes survive {n - w} owner{n - w === 1 ? "" : "s"} down.
              </span>
            </li>
            <li>
              <Icon.Eye size={16} />
              <span>
                Reads survive {n - r} owner{n - r === 1 ? "" : "s"} down.
              </span>
            </li>
            <li>
              <Icon.Layers size={16} />
              <span>{n}× on disk.</span>
            </li>
            <li>
              <Icon.Shield size={16} />
              <span>The policy is gossiped to every node and written to each node&apos;s index, so a full restart keeps it.</span>
            </li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
