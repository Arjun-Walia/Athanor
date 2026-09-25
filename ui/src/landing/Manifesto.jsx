import { useRef } from "react";
import { useProgress } from "./hooks.js";

// Three sentences, one per rule the system holds itself to. Each word goes
// from faint to ink as the reader scrolls through the block: --p runs 0..1
// over the section and every word compares its own --w against it in CSS.
const LINES = [
  "Every object is written to three nodes and acknowledged after two.",
  "Every read re-hashes the bytes before it trusts them.",
  "Every kind of damage goes through one repair path.",
];

const WORDS = LINES.flatMap((line, li) => line.split(" ").map((w, wi) => ({ w, li, wi })));
const TOTAL = WORDS.length;

export default function Manifesto() {
  const ref = useRef(null);
  useProgress(ref, { start: 0.85, end: 0.35 });

  return (
    <section className="ln-manifesto" ref={ref} aria-label="What Athanor promises">
      <p className="ln-manifesto-text">
        {LINES.map((line, li) => {
          const start = WORDS.findIndex((x) => x.li === li);
          return (
            <span key={li} className="ln-manifesto-line">
              {line.split(" ").map((w, wi) => (
                <span key={wi} className="ln-manifesto-word" style={{ "--w": (start + wi) / TOTAL }}>
                  {w}{" "}
                </span>
              ))}
            </span>
          );
        })}
      </p>
    </section>
  );
}
