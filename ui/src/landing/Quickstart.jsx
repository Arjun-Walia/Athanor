import { useEffect, useId, useState } from "react";
import { useReveal } from "./hooks.js";
import {
  IconArrowUpRight,
  IconBox,
  IconCheck,
  IconCopy,
  IconFile,
  IconPlay,
  IconPower,
  IconServer,
  IconSliders,
  IconTerminal,
  IconZap,
} from "./icons.jsx";

function Command({ cmd }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const t = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
    } catch {
      // Clipboard blocked (insecure origin or permissions): the command is
      // still plain, selectable text.
    }
  };

  return (
    <div className="ln-cmd">
      <span className="ln-cmd-prompt" aria-hidden="true">
        $
      </span>
      <code className="ln-cmd-text">{cmd}</code>
      <button
        type="button"
        className={`icon-btn ln-cmd-copy${copied ? " is-done" : ""}`}
        onClick={copy}
        aria-label={`Copy command: ${cmd}`}
      >
        {copied ? <IconCheck size="1.05rem" /> : <IconCopy size="1.05rem" />}
      </button>
      <span className="sr-only" role="status">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </div>
  );
}

const DEMO = [
  { title: "Open the dashboard", note: "Five nodes, all alive. The ring is drawn from membership.", Icon: IconServer },
  { title: "Upload report.pdf", note: "Its row shows replica dots on three nodes.", Icon: IconFile },
  { title: "Kill node2", note: "Its card turns red and says dead. The download still works: R = 2.", Icon: IconPower },
  { title: "Corrupt node3’s copy", note: "The next get or scrub logs a mismatch, then a repair from a good replica.", Icon: IconZap },
  { title: "Start node2", note: "Hint replay or rebalance runs, and its dot comes back.", Icon: IconPlay },
  { title: "Drag W from 2 to 3", note: "On the Durability page. The next upload waits for three acks.", Icon: IconSliders },
];

function DemoChecklist() {
  const [done, setDone] = useState(() => DEMO.map(() => false));
  const count = done.filter(Boolean).length;
  const baseId = useId();

  return (
    <div className="ln-demo">
      <div className="ln-demo-head">
        <div>
          <h3 className="ln-demo-title">The 90-second demo</h3>
          <p className="ln-demo-sub">The judging script from PLAN.md. The dashboard ticks it off from live events; this copy is yours.</p>
        </div>
        <p className="ln-demo-count num" aria-live="polite">
          {count}
          <span>/{DEMO.length}</span>
          <span className="sr-only"> steps ticked</span>
        </p>
      </div>
      <ul className="ln-demo-list">
        {DEMO.map(({ title, note, Icon }, i) => {
          const id = `${baseId}-${i}`;
          return (
            <li key={title} className={`ln-demo-item${done[i] ? " is-done" : ""}`}>
              <input
                id={id}
                type="checkbox"
                className="ln-demo-input"
                checked={done[i]}
                onChange={() => setDone((prev) => prev.map((v, j) => (j === i ? !v : v)))}
              />
              <label htmlFor={id} className="ln-demo-label">
                <span className="ln-demo-bubble">
                  <Icon size="1.15rem" />
                </span>
                <span className="ln-demo-text">
                  <b>{title}</b>
                  <small>{note}</small>
                </span>
                <span className="ln-demo-check" aria-hidden="true">
                  <IconCheck size="0.9rem" />
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <p className="ln-demo-foot">Ticks stay in this tab. Nothing is sent anywhere.</p>
    </div>
  );
}

export default function Quickstart() {
  const headRef = useReveal();
  const bodyRef = useReveal("0px 0px -8% 0px");

  return (
    <section className="ln-section ln-start" id="start" aria-labelledby="ln-start-title">
      <header className="ln-section-head ln-reveal" ref={headRef}>
        <p className="ln-eyebrow">
          <span className="ln-eyebrow-num">05</span> Quickstart
        </p>
        <h2 id="ln-start-title" className="ln-h2">
          Light it on your own machine.
        </h2>
        <p className="ln-intro">
          Docker is enough to run it. Without Docker, Go 1.25+ and one script start five local processes that
          serve the same dashboard.
        </p>
      </header>

      <div className="ln-start-grid" ref={bodyRef}>
        <div className="ln-start-steps">
          <article className="ln-startcard surface-card ln-reveal" style={{ "--i": 0 }}>
            <div className="ln-startcard-head">
              <span className="ln-startcard-icon">
                <IconBox size="1.2rem" />
              </span>
              <div>
                <p className="ln-startcard-kicker">Five nodes</p>
                <h3 className="ln-startcard-title">Run the cluster in Docker</h3>
              </div>
            </div>
            <Command cmd="docker compose -f deploy/docker-compose.yml up --build" />
            <p className="ln-startcard-then">
              Then open{" "}
              <a href="http://localhost:8081/app" className="ln-link">
                <code>http://localhost:8081/app</code>
              </a>
              . Host ports 8081 to 8085 are node1 to node5.
            </p>
          </article>

          <article className="ln-startcard surface-card ln-reveal" style={{ "--i": 1 }}>
            <div className="ln-startcard-head">
              <span className="ln-startcard-icon">
                <IconTerminal size="1.2rem" />
              </span>
              <div>
                <p className="ln-startcard-kicker">No Docker</p>
                <h3 className="ln-startcard-title">Five local processes</h3>
              </div>
            </div>
            <Command cmd="make ui-embed && scripts/local-cluster.sh" />
            <p className="ln-startcard-then">
              Same ports, same dashboard at{" "}
              <a href="http://localhost:8081/app" className="ln-link">
                <code>http://localhost:8081/app</code>
              </a>
              . For UI work, <code>cd ui &amp;&amp; npm run dev</code> serves it at port 5173.
            </p>
          </article>

          <a className="ln-btn ln-btn-dark ln-btn-lg ln-reveal ln-start-cta" style={{ "--i": 2 }} href="/app">
            Open the dashboard <IconArrowUpRight size="1.1rem" />
          </a>
        </div>

        <div className="ln-reveal ln-demo-wrap" style={{ "--i": 1 }}>
          <DemoChecklist />
        </div>
      </div>
    </section>
  );
}
