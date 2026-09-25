import { useEffect, useState } from "react";
import { useReveal } from "./hooks.js";
import { IconArrowUpRight, IconCheck, IconCopy, IconDownload } from "./icons.jsx";
import { InstallButton } from "../shell.jsx";
import { DASHBOARD_PATH, PUBLIC_URL, RELEASES_URL } from "./site.js";

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
      // Clipboard blocked: the command is still plain, selectable text.
    }
  };
  return (
    <div className="ln-cmd">
      <span className="ln-cmd-prompt" aria-hidden="true">
        $
      </span>
      <code className="ln-cmd-text">{cmd}</code>
      <button type="button" className={`ln-cmd-copy${copied ? " is-done" : ""}`} onClick={copy} aria-label={`Copy command: ${cmd}`}>
        {copied ? <IconCheck size="1rem" /> : <IconCopy size="1rem" />}
      </button>
      <span className="sr-only" role="status">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </div>
  );
}

const WAYS = [
  {
    id: "docker",
    tab: "Docker",
    title: "Five nodes, five disks",
    cmd: "docker compose -f deploy/docker-compose.yml up --build",
    then: (
      <>
        Then open <code>localhost:8081/app</code>. Ports 8081 to 8085 are node1 to node5, and any of them can coordinate.
      </>
    ),
  },
  {
    id: "local",
    tab: "No Docker",
    title: "Five local processes",
    cmd: "make ui-embed && scripts/local-cluster.sh",
    then: (
      <>
        Same ports, same dashboard. <code>NODES=6</code> adds a sixth node so you can watch keys move onto it.
      </>
    ),
  },
  {
    id: "public",
    tab: "Hosted",
    title: "The public cluster",
    cmd: `curl -X PUT --data-binary @report.pdf ${PUBLIC_URL}/v1/objects/report.pdf`,
    then: (
      <>
        A five-node cluster runs at <code>{PUBLIC_URL.replace("https://", "")}</code>. Anyone can read, write, and press the buttons.
      </>
    ),
  },
];

export default function Quickstart() {
  const [way, setWay] = useState(WAYS[0].id);
  const headRef = useReveal();
  const bodyRef = useReveal("0px 0px -8% 0px");
  const current = WAYS.find((w) => w.id === way) || WAYS[0];

  return (
    <section className="ln-run" id="run" aria-labelledby="ln-run-title">
      <header className="ln-section-head ln-reveal" ref={headRef}>
        <p className="ln-eyebrow">Run it</p>
        <h2 id="ln-run-title" className="ln-h2">
          Light it.
        </h2>
        <p className="ln-intro">One command, whichever way you like to run things.</p>
      </header>

      <div className="ln-run-grid ln-reveal" ref={bodyRef}>
        <div className="ln-run-card">
          <div className="ln-tabs" role="tablist" aria-label="Ways to run Athanor">
            {WAYS.map((w) => (
              <button key={w.id} type="button" role="tab" className={`ln-tab${w.id === way ? " is-on" : ""}`} aria-selected={w.id === way} onClick={() => setWay(w.id)}>
                {w.tab}
              </button>
            ))}
          </div>
          <div className="ln-run-body" role="tabpanel" key={current.id}>
            <h3 className="ln-run-title">{current.title}</h3>
            <Command cmd={current.cmd} />
            <p className="ln-run-then">{current.then}</p>
          </div>
          <a className="ln-btn ln-btn-dark ln-btn-lg" href={DASHBOARD_PATH}>
            Open the dashboard <IconArrowUpRight size="1.05rem" />
          </a>
        </div>

        <div className="ln-run-desktop">
          <p className="ln-eyebrow">Desktop</p>
          <h3 className="ln-run-title">The same dashboard, as an app.</h3>
          <p className="ln-run-then">
            Frameless, full screen, and it finds your local cluster before falling back to the hosted one. Installers for macOS,
            Windows and Linux are built on every release.
          </p>
          <InstallButton className="ln-btn ln-btn-yellow ln-btn-lg">
            <IconDownload size="1.05rem" /> Download
          </InstallButton>
          <a className="ln-link ln-run-releases" href={RELEASES_URL}>
            All releases <IconArrowUpRight size="0.9rem" />
          </a>
        </div>
      </div>
    </section>
  );
}
