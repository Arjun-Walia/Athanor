import { useId, useState } from "react";
import { useReveal } from "./hooks.js";
import { IconAlert, IconCheck, IconEye, IconPen } from "./icons.jsx";

/*
 * N, W and R, with the honest number underneath: every byte is stored N
 * times. The dial shows the worst case, where the read set is as far from
 * the write set as it can be; W + R > N is what guarantees they still meet.
 */

const MAX_N = 5;
const PRESETS = [
  { name: "Default", n: 3, w: 2, r: 2 },
  { name: "Fast reads", n: 3, w: 3, r: 1 },
  { name: "Fast writes", n: 3, w: 1, r: 3 },
  { name: "Loose", n: 3, w: 1, r: 1 },
];

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

function Dial({ n, w, r }) {
  const span = 360 / n;
  const gap = n === 1 ? 0.6 : 3;
  const ok = w + r > n;
  return (
    <svg className="ln-dial" viewBox="0 0 300 300" aria-hidden="true" focusable="false">
      {Array.from({ length: n }, (_, i) => {
        const a0 = i * span + gap;
        const a1 = (i + 1) * span - gap;
        const inWrite = i < w;
        const inRead = i >= n - r;
        const [lx, ly] = dpt(134, (a0 + a1) / 2);
        return (
          <g key={`${n}-${i}`}>
            <path d={arc(112, a0, a1)} className={`ln-dial-w${inWrite ? " is-on" : ""}`} />
            <path d={arc(88, a0, a1)} className={`ln-dial-r${inRead ? " is-on" : ""}`} />
            <text x={lx} y={ly} dy="0.35em" className="ln-dial-label">
              n{i + 1}
            </text>
          </g>
        );
      })}
      <text x={DC} y={DC - 6} className="ln-dial-sum num">
        {w + r}
      </text>
      <text x={DC} y={DC + 20} className="ln-dial-sub">
        W + R
      </text>
      <text x={DC} y={DC + 40} className={`ln-dial-cmp${ok ? " is-ok" : " is-bad"}`}>
        {ok ? ">" : "≤"} N = {n}
      </text>
    </svg>
  );
}

function Slider({ label, hint, value, min, max, onChange, tone }) {
  const id = useId();
  const fill = max === min ? 1 : (value - min) / (max - min);
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
      <input id={id} type="range" min={min} max={max} step={1} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ "--f": fill }} />
    </div>
  );
}

export default function Playground() {
  const [q, setQ] = useState({ n: 3, w: 2, r: 2 });
  const { n, w, r } = q;
  const headRef = useReveal();
  const bodyRef = useReveal("0px 0px -8% 0px");
  const ok = w + r > n;

  const setN = (v) => setQ((p) => ({ n: v, w: Math.min(p.w, v), r: Math.min(p.r, v) }));

  return (
    <section className="ln-quorum" id="quorum" aria-labelledby="ln-quorum-title">
      <header className="ln-section-head ln-reveal" ref={headRef}>
        <p className="ln-eyebrow">Quorum</p>
        <h2 id="ln-quorum-title" className="ln-h2">
          Three dials. One rule.
        </h2>
        <p className="ln-intro">
          Keep W + R above N and every read overlaps the last acknowledged write. Everything else is a trade.
        </p>
      </header>

      <div className="ln-play ln-reveal" ref={bodyRef}>
        <div className="ln-play-controls">
          <div className="ln-presets" role="group" aria-label="Presets">
            {PRESETS.map((p) => {
              const on = p.n === n && p.w === w && p.r === r;
              return (
                <button key={p.name} type="button" className={`ln-preset${on ? " is-on" : ""}`} aria-pressed={on} onClick={() => setQ({ n: p.n, w: p.w, r: p.r })}>
                  {p.name} <span className="num">{p.n}/{p.w}/{p.r}</span>
                </button>
              );
            })}
          </div>
          <Slider label="N" hint="copies of each object" value={n} min={1} max={MAX_N} onChange={setN} tone="neutral" />
          <Slider label="W" hint="acks before the client hears 201" value={w} min={1} max={n} onChange={(v) => setQ((p) => ({ ...p, w: v }))} tone="yellow" />
          <Slider label="R" hint="replicas asked on every read" value={r} min={1} max={n} onChange={(v) => setQ((p) => ({ ...p, r: v }))} tone="dark" />
          <p className={`ln-verdict${ok ? " is-ok" : " is-bad"}`} role="status" aria-live="polite">
            {ok ? <IconCheck size="1.1rem" /> : <IconAlert size="1.1rem" />}
            {ok ? <span>Reads meet writes. Overlap of {w + r - n}.</span> : <span>No overlap. A read can miss the newest write.</span>}
          </p>
        </div>

        <div className="ln-play-viz">
          <div className="ln-play-legend">
            <span className="ln-chip is-yellow">
              <IconPen size="0.8rem" /> write set · {w}
            </span>
            <span className="ln-chip is-dark">
              <IconEye size="0.8rem" /> read set · {r}
            </span>
          </div>
          <Dial n={n} w={w} r={r} />
        </div>

        <div className="ln-over">
          <p className="ln-over-big num">
            {n}.0<span>×</span>
          </p>
          <p className="ln-over-lede">
            Every byte is stored {n} {n === 1 ? "time" : "times"}. {n === 1 ? "One lost disk loses the object." : `It survives losing ${n - 1} of its copies.`}
          </p>
          <dl className="ln-over-facts">
            <div>
              <dt>Writes go through with</dt>
              <dd>
                <b className="num">{n - w}</b> owner{n - w === 1 ? "" : "s"} down
              </dd>
            </div>
            <div>
              <dt>Reads go through with</dt>
              <dd>
                <b className="num">{n - r}</b> owner{n - r === 1 ? "" : "s"} down
              </dd>
            </div>
            <div>
              <dt>Erasure coding would cost</dt>
              <dd>
                <b className="num">1.5</b>× · not built
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}
