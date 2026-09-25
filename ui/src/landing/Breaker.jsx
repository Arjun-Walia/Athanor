import { useEffect, useReducer, useRef } from "react";
import { useReveal } from "./hooks.js";
import { IconArrowUpRight, IconBookmark, IconCheck, IconPlay, IconPower, IconRotate, IconWrench, IconX, IconZap } from "./icons.jsx";
import { DASHBOARD_PATH } from "./site.js";

/*
 * A small model of the cluster you can break with buttons. It runs the
 * same rules as the engine (three owners, hints for a dead owner, checksum
 * repair from a healthy copy) but it is an illustration in the browser, and
 * says so. The dashboard does the real thing.
 */

const OWNERS = [0, 1, 2]; // node1..3 own report.pdf; node4 is next in line
const HINT_HOLDER = 3;

export const INITIAL = {
  nodes: [
    { alive: true, copy: "ok" },
    { alive: true, copy: "ok" },
    { alive: true, copy: "ok" },
    { alive: true, copy: null },
    { alive: true, copy: null },
  ],
  hint: false, // node4 holds a hint for node2
  log: [{ id: 0, level: "ok", text: "report.pdf on node1, node2, node3 · all checksums match" }],
  seq: 1,
};

function log(state, level, text) {
  return { ...state, seq: state.seq + 1, log: [...state.log.slice(-4), { id: state.seq, level, text }] };
}

export function reduce(state, action) {
  const nodes = state.nodes.map((n) => ({ ...n }));
  switch (action.type) {
    case "kill": {
      if (!nodes[1].alive) return state;
      nodes[1].alive = false;
      return log({ ...state, nodes }, "bad", "node2 missed its probes · suspect, then dead");
    }
    case "write": {
      if (nodes[1].alive) {
        return log(state, "ok", "put report.pdf v2 · acked by node1, node2 · 201");
      }
      nodes[HINT_HOLDER].copy = "hint";
      return log({ ...state, nodes, hint: true }, "warn", "put v2 · node2 is dead → hint parked on node4 · 201 after node1, node3");
    }
    case "flip": {
      if (nodes[2].copy !== "ok") return state;
      nodes[2].copy = "flipped";
      return log({ ...state, nodes }, "warn", "a byte of node3's copy changed on disk · nothing has noticed yet");
    }
    case "read": {
      const bad = nodes[2].copy === "flipped";
      if (!bad) return log(state, "ok", "get report.pdf · two verified copies · 200");
      nodes[2].copy = "ok";
      return log({ ...state, nodes }, "ok", "get · node3 failed its checksum → served from node1 · Repair(key) rewrote node3");
    }
    case "scrub": {
      if (nodes[2].copy !== "flipped") return log(state, "ok", "scrub · every replica re-hashed · 0 mismatches");
      nodes[2].copy = "ok";
      return log({ ...state, nodes }, "ok", "scrub · checksum mismatch on node3 → healed from node1");
    }
    case "restart": {
      if (nodes[1].alive) return state;
      nodes[1].alive = true;
      let next = { ...state, nodes };
      next = log(next, "ok", "node2 is alive again · rejoined through its seeds");
      if (state.hint) {
        nodes[HINT_HOLDER].copy = null;
        next = log({ ...next, nodes, hint: false }, "ok", "hint replay · node4 → node2 · hint dropped");
      }
      return next;
    }
    case "reset":
      return INITIAL;
    default:
      return state;
  }
}

const COPY = {
  ok: { Icon: IconCheck, word: "verified" },
  flipped: { Icon: IconZap, word: "flipped" },
  hint: { Icon: IconBookmark, word: "hint" },
};

function Node({ i, n, owner }) {
  const dead = !n.alive;
  const copy = n.copy ? COPY[n.copy] : null;
  const state = dead ? "dead" : n.copy || (owner ? "missing" : "idle");
  return (
    <li className={`ln-bk-node is-${state}`} aria-label={`node${i + 1}: ${dead ? "dead" : copy ? copy.word : owner ? "missing its copy" : "not an owner"}`}>
      <span className="ln-bk-node-body">
        <span className="ln-bk-node-name">n{i + 1}</span>
        <span className="ln-bk-node-mark" aria-hidden="true">
          {dead ? <IconX size="0.85rem" /> : copy ? <copy.Icon size="0.85rem" /> : null}
        </span>
      </span>
      <span className="ln-bk-node-word">{dead ? "dead" : copy ? copy.word : owner ? "missing" : "spare"}</span>
    </li>
  );
}

export default function Breaker() {
  const [state, dispatch] = useReducer(reduce, INITIAL);
  const headRef = useReveal();
  const bodyRef = useReveal("0px 0px -8% 0px");
  const logRef = useRef(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.log]);

  const node2Dead = !state.nodes[1].alive;
  const flipped = state.nodes[2].copy === "flipped";
  const healthy = state.nodes.filter((n, i) => OWNERS.includes(i) && n.alive && n.copy === "ok").length;

  return (
    <section className="ln-break" id="break" aria-labelledby="ln-break-title">
      <header className="ln-section-head ln-reveal" ref={headRef}>
        <p className="ln-eyebrow is-light">Break it</p>
        <h2 id="ln-break-title" className="ln-h2">
          Press the buttons. Watch it recover.
        </h2>
        <p className="ln-intro">A model of the rules, in the browser. The real cluster is one click away.</p>
      </header>

      <div className="ln-bk ln-reveal" ref={bodyRef}>
        <div className="ln-bk-cluster">
          <div className="ln-bk-object">
            <span className="ln-bk-object-name">report.pdf</span>
            <span className={`ln-bk-object-state${healthy < 3 ? " is-warn" : ""}`}>
              {healthy}/3 verified{state.hint ? " · 1 hint" : ""}
            </span>
          </div>
          <ul className="ln-bk-nodes">
            {state.nodes.map((n, i) => (
              <Node key={i} i={i} n={n} owner={OWNERS.includes(i)} />
            ))}
          </ul>
          <ol className="ln-bk-log" ref={logRef} aria-live="polite" aria-label="What happened">
            {state.log.map((l) => (
              <li key={l.id} className={`is-${l.level}`}>
                {l.text}
              </li>
            ))}
          </ol>
        </div>

        <div className="ln-bk-controls">
          <p className="ln-bk-group">Fail</p>
          <button type="button" className="ln-bk-btn" onClick={() => dispatch({ type: "kill" })} disabled={node2Dead}>
            <IconPower size="1rem" /> Kill node2
          </button>
          <button type="button" className="ln-bk-btn" onClick={() => dispatch({ type: "flip" })} disabled={flipped}>
            <IconZap size="1rem" /> Flip a byte on node3
          </button>
          <p className="ln-bk-group">Use</p>
          <button type="button" className="ln-bk-btn" onClick={() => dispatch({ type: "write" })}>
            <IconPlay size="1rem" /> Write v2
          </button>
          <button type="button" className="ln-bk-btn" onClick={() => dispatch({ type: "read" })}>
            <IconCheck size="1rem" /> Read it back
          </button>
          <p className="ln-bk-group">Heal</p>
          <button type="button" className="ln-bk-btn is-accent" onClick={() => dispatch({ type: "scrub" })}>
            <IconWrench size="1rem" /> Scrub now
          </button>
          <button type="button" className="ln-bk-btn" onClick={() => dispatch({ type: "restart" })} disabled={!node2Dead}>
            <IconRotate size="1rem" /> Start node2
          </button>
          <button type="button" className="ln-bk-reset" onClick={() => dispatch({ type: "reset" })}>
            Reset
          </button>
          <a className="ln-btn ln-btn-yellow ln-bk-cta" href={DASHBOARD_PATH}>
            Do it for real <IconArrowUpRight size="1rem" />
          </a>
        </div>
      </div>
    </section>
  );
}
