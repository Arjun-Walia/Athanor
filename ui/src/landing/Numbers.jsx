import { useRef } from "react";
import { useCountUp, useInView } from "./hooks.js";

// The defaults, as numbers. They count up the first time they are seen.
const FIGURES = [
  { n: 3, unit: "copies", label: "of every object, on three different nodes" },
  { n: 2, unit: "acks", label: "before a write is confirmed to the client" },
  { n: 64, unit: "vnodes", label: "per node, so a join moves about one sixth of the keys" },
  { n: 256, unit: "bits", label: "of SHA-256 checked on every read and every scrub" },
];

function Figure({ n, unit, label, go, i }) {
  const value = useCountUp(n, go, 900 + i * 180);
  return (
    <li className="ln-figure" style={{ "--i": i }}>
      <p className="ln-figure-n">
        <span className="num">{value}</span>
        <span className="ln-figure-unit">{unit}</span>
      </p>
      <p className="ln-figure-label">{label}</p>
    </li>
  );
}

export default function Numbers() {
  const ref = useRef(null);
  const seen = useInView(ref);
  return (
    <section className="ln-numbers" ref={ref} data-in={seen ? "" : undefined} aria-label="Defaults">
      <ul className="ln-figures">
        {FIGURES.map((fig, i) => (
          <Figure key={fig.unit} {...fig} go={seen} i={i} />
        ))}
      </ul>
    </section>
  );
}
