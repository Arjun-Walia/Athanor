import { useId, useState } from "react";
import { useReveal } from "./hooks.js";
import { IconAlert, IconCheck, IconEye, IconInfo, IconPen } from "./icons.jsx";

const MAX_N = 5;
const PRESETS = [
  { name: "Default", n: 3, w: 2, r: 2 },
  { name: "Fast reads", n: 3, w: 3, r: 1 },
  { name: "Fast writes", n: 3, w: 1, r: 3 },
  { name: "Loose", n: 3, w: 1, r: 1 },
];

const plural = (count, one, many) => (count === 1 ? one : many);

/* ---------- dial ---------- */

const DC = 150;
const f2 = (v) => Math.round(v * 100) / 100;
const dpt = (r, deg) => {
  const a = (deg * Math.PI) / 180;
  return [f2(DC + r * Math.sin(a)), f2(DC - r * Math.cos(a))];
};
function arc(r, a0, a1) {
  const [x0, y0] = dpt(r, a0);
  const [x1, y1] = dpt(r, a1);
  return `M${x0} ${y0} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
}
const DIAL_TICKS = Array.from({ length: 60 }, (_, i) => {
  const [x1, y1] = dpt(i % 5 === 0 ? 139 : 142, i * 6);
  const [x2, y2] = dpt(146, i * 6);
  return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />;
});

function Dial({ n, w, r }) {
  const span = 360 / n;
  const gap = n === 1 ? 0.6 : 2.6;
  const sum = w + r;
  const ok = sum > n;
  return (
    <svg className="ln-dial" viewBox="0 0 300 300" aria-hidden="true" focusable="false">
      <g className="ln-dial-ticks">{DIAL_TICKS}</g>
      {Array.from({ length: n }, (_, i) => {
        const a0 = i * span + gap;
        const a1 = (i + 1) * span - gap;
        const inWrite = i < w;
        const inRead = i >= n - r;
        const mid = (a0 + a1) / 2;
        const [lx, ly] = dpt(130, mid);
        const [ox, oy] = dpt(106, mid);
        return (
          <g key={`${n}-${i}`}>
            <path d={arc(118, a0, a1)} className={`ln-dial-w${inWrite ? " is-on" : ""}`} />
            <path d={arc(94, a0, a1)} className={`ln-dial-r${inRead ? " is-on" : ""}`} />
            {inWrite && inRead ? <circle cx={ox} cy={oy} r="5" className="ln-dial-both" /> : null}
            <text x={lx} y={ly} dy="0.35em" className="ln-dial-label">
              n{i + 1}
            </text>
          </g>
        );
      })}
      <text x={DC} y={DC - 8} className="ln-dial-sum">
        {sum}
      </text>
      <text x={DC} y={DC + 22} className="ln-dial-sub">
        W + R
      </text>
      <text x={DC} y={DC + 42} className={`ln-dial-cmp${ok ? " is-ok" : " is-bad"}`}>
        {ok ? ">" : "≤"} N = {n}
      </text>
    </svg>
  );
}

/* ---------- slider ---------- */

function Slider({ label, hint, value, min, max, onChange, tone }) {
  const id = useId();
  const fill = max === min ? 1 : (value - min) / (max - min);
  const marks = [];
  for (let v = min; v <= max; v += 1) marks.push(v);
  return (
    <div className={`ln-slider is-${tone}`}>
      <div className="ln-slider-head">
        <label htmlFor={id}>
          <b>{label}</b>
          <span>{hint}</span>
        </label>
        <output htmlFor={id} className="ln-slider-val num">
          {value}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ "--f": fill }}
      />
      <div className="ln-slider-scale" aria-hidden="true">
        {marks.map((v) => (
          <span key={v} className={v === value ? "is-on" : undefined}>
            {v}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ---------- section ---------- */

export default function Playground() {
  const [q, setQ] = useState({ n: 3, w: 2, r: 2 });
  const { n, w, r } = q;
  const headRef = useReveal();
  const bodyRef = useReveal("0px 0px -8% 0px");

  const setN = (value) => setQ((prev) => ({ n: value, w: Math.min(prev.w, value), r: Math.min(prev.r, value) }));
  const setW = (value) => setQ((prev) => ({ ...prev, w: value }));
  const setR = (value) => setQ((prev) => ({ ...prev, r: value }));

  const overlap = Math.max(0, w + r - n);
  const ok = w + r > n;

  return (
    <section className="ln-section ln-quorum" id="quorum" aria-labelledby="ln-quorum-title">
      <header className="ln-section-head ln-reveal" ref={headRef}>
        <p className="ln-eyebrow">
          <span className="ln-eyebrow-num">03</span> Quorum playground
        </p>
        <h2 id="ln-quorum-title" className="ln-h2">
          Pick your N, W and R. See what they buy.
        </h2>
        <p className="ln-intro">
          If W + R is greater than N, every set of R replicas shares at least one node with every set of W, so a read
          always meets the latest acknowledged write. This is arithmetic in your browser; it does not talk to a
          cluster.
        </p>
      </header>

      <div className="ln-play" ref={bodyRef}>
        <div className="ln-play-controls surface-card ln-reveal" style={{ "--i": 0 }}>
          <div className="pill-group ln-presets" role="group" aria-label="Presets">
            {PRESETS.map((p) => {
              const on = p.n === n && p.w === w && p.r === r;
              return (
                <button
                  key={p.name}
                  type="button"
                  className={`pill-btn${on ? " is-active" : ""}`}
                  aria-pressed={on}
                  onClick={() => setQ({ n: p.n, w: p.w, r: p.r })}
                >
                  {p.name}
                  <span className="ln-preset-nums num">
                    {p.n}/{p.w}/{p.r}
                  </span>
                </button>
              );
            })}
          </div>

          <Slider label="N" hint="copies of each object" value={n} min={1} max={MAX_N} onChange={setN} tone="neutral" />
          <Slider label="W" hint="acks before the client hears 201" value={w} min={1} max={n} onChange={setW} tone="yellow" />
          <Slider label="R" hint="replicas asked on every read" value={r} min={1} max={n} onChange={setR} tone="dark" />

          <div className={`ln-verdict${ok ? " is-ok" : " is-bad"}`} role="status" aria-live="polite">
            <span className="ln-verdict-icon">{ok ? <IconCheck size="1.2rem" /> : <IconAlert size="1.2rem" />}</span>
            <p>
              {ok ? (
                <>
                  <b>Reads meet writes.</b> W + R = {w + r} &gt; {n}: at least {overlap}{" "}
                  {plural(overlap, "replica is", "replicas are")} in both sets.
                </>
              ) : (
                <>
                  <b>No guaranteed overlap.</b> W + R = {w + r} ≤ {n}: a read can land only on replicas that missed the
                  latest write and return an older version until repair catches up.
                </>
              )}
            </p>
          </div>
        </div>

        <div className="ln-play-viz surface-card ln-reveal" style={{ "--i": 1 }}>
          <div className="ln-play-legend">
            <span className="chip yellow">
              <IconPen size="0.8rem" /> write set · W = {w}
            </span>
            <span className="chip dark">
              <IconEye size="0.8rem" /> read set · R = {r}
            </span>
          </div>
          <Dial n={n} w={w} r={r} />
          <ul className="ln-pnodes" aria-label="Replica roles, worst case">
            {Array.from({ length: MAX_N }, (_, i) => {
              const replica = i < n;
              const writes = replica && i < w;
              const reads = replica && i >= n - r;
              return (
                <li key={i} className={`ln-pnode${replica ? "" : " is-out"}`}>
                  <span className="ln-pnode-name">node{i + 1}</span>
                  <span className="ln-pnode-roles">
                    {writes ? (
                      <span className="chip yellow">
                        <IconPen size="0.75rem" /> write
                      </span>
                    ) : null}
                    {reads ? (
                      <span className="chip dark">
                        <IconEye size="0.75rem" /> read
                      </span>
                    ) : null}
                    {replica && !writes && !reads ? <span className="chip outline">not counted</span> : null}
                    {!replica ? <span className="chip outline hatched">not a replica</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="ln-play-fine">
            Worst case shown: the read set is placed as far from the write set as it can be. During failures a hinted
            copy can sit outside the preference list until it is replayed, so the overlap is firmest when the preferred
            nodes are up.
          </p>
        </div>

        <div className="ln-over ln-reveal" style={{ "--i": 2 }}>
          <p className="ln-over-eyebrow">Storage overhead</p>
          <p className="ln-over-big num">
            {n}.0<span>×</span>
          </p>
          <p className="ln-over-lede">
            Every byte is stored {n} {plural(n, "time", "times")}.{" "}
            {n === 1 ? "One lost disk loses the object." : `The object survives losing ${n - 1} of its copies.`}
          </p>

          <dl className="ln-over-facts">
            <div>
              <dt>Writes reach W with</dt>
              <dd>
                up to <b className="num">{n - w}</b> {plural(n - w, "replica", "replicas")} down
              </dd>
            </div>
            <div>
              <dt>Reads reach R with</dt>
              <dd>
                up to <b className="num">{n - r}</b> {plural(n - r, "replica", "replicas")} down
              </dd>
            </div>
            <div>
              <dt>At the 201</dt>
              <dd>
                <b className="num">{w}</b> {plural(w, "copy", "copies")} on disk, {n} once the rest land
              </dd>
            </div>
          </dl>

          <div className="ln-over-bars">
            <div className="ln-over-row">
              <span className="ln-over-label">Replication, N = {n}</span>
              <span className="ln-over-track">
                {Array.from({ length: MAX_N }, (_, i) => (
                  <span key={i} className={`ln-over-block${i < n ? " is-on" : ""}`} />
                ))}
              </span>
              <b className="num">{n}.0×</b>
            </div>
            <div className="ln-over-row is-off">
              <span className="ln-over-label">
                Erasure coding, RS(4,2) <span className="ln-over-tag">not built</span>
              </span>
              <span className="ln-over-track">
                <span className="ln-over-rs" />
              </span>
              <b className="num">1.5×</b>
            </div>
          </div>

          <p className="ln-over-note">
            <IconInfo size="0.95rem" />
            <span>
              RS(4,2) would cut an object into four data and two parity fragments and survive any two lost fragments at
              1.5×. Athanor does not do this: erasure coding is out of scope for the MVP, and the 3× default is stated
              as it is.
            </span>
          </p>
        </div>
      </div>
    </section>
  );
}
