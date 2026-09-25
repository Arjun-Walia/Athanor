import { useCallback, useEffect, useMemo, useState } from "react";
import "./dashboard.css";
import { Icon } from "./icons.jsx";
import { Menu, MenuItem, MenuLabel, Toasts } from "./components.jsx";
import { InstallButton } from "../shell.jsx";
import { api, DEFAULT_BASE } from "./api.js";
import { useCluster, useNow } from "./useCluster.js";
import Overview from "./pages/Overview.jsx";
import Nodes from "./pages/Nodes.jsx";
import Objects from "./pages/Objects.jsx";
import Events from "./pages/Events.jsx";
import Durability from "./pages/Durability.jsx";

const PAGES = [
  ["overview", "Dashboard"],
  ["nodes", "Nodes"],
  ["objects", "Objects"],
  ["events", "Events"],
];

function pageFromPath(pathname) {
  const seg = pathname.replace(/^\/app\/?/, "").split("/")[0];
  return ["nodes", "objects", "events", "durability"].includes(seg) ? seg : "overview";
}

function pathFor(page) {
  return page === "overview" ? "/app" : `/app/${page}`;
}

let toastSeq = 0;

export default function Dashboard() {
  const cluster = useCluster();
  const { base, overview: ov, ring, events, status, error, notice, dismissNotice, refresh, connect, known } = cluster;
  const now = useNow(1000);
  const [page, setPage] = useState(() => pageFromPath(window.location.pathname));
  const [eventKind, setEventKind] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [busy, setBusy] = useState({});
  const [seenAt, setSeenAt] = useState(() => Date.now());

  useEffect(() => {
    const onPop = () => setPage(pageFromPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    const titles = { overview: "Dashboard", nodes: "Nodes", objects: "Objects", events: "Events", durability: "Durability" };
    document.title = `${titles[page]} · Athanor`;
  }, [page]);

  const go = useCallback((next, arg) => {
    if (next === "events") {
      setEventKind(arg || null);
      setSeenAt(Date.now());
    }
    setPage(next);
    if (window.location.pathname !== pathFor(next)) window.history.pushState(null, "", pathFor(next));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const notify = useCallback((tone, text) => {
    const id = ++toastSeq;
    setToasts((t) => [...t.slice(-3), { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 9000 : 5500);
  }, []);

  useEffect(() => {
    if (notice) {
      notify(notice.tone, notice.text);
      dismissNotice();
    }
  }, [notice, notify, dismissNotice]);

  const actions = useMemo(() => {
    const run = async (fn, okText, failText, tone = "ok") => {
      try {
        const res = await fn();
        const text = typeof okText === "function" ? okText(res) : okText;
        if (text) notify(typeof tone === "function" ? tone(res) : tone, text);
        refresh();
        return res;
      } catch (e) {
        notify("error", `${failText}: ${e.message}`);
        refresh();
        return null;
      }
    };
    return {
      scrub: async () => {
        setBusy((b) => ({ ...b, scrub: true }));
        await run(
          () => api.scrub(base),
          (r) => {
            const res = r.results ?? [];
            const checked = res.reduce((s, x) => s + x.checked, 0);
            const bad = res.reduce((s, x) => s + x.mismatches, 0);
            const dropped = res.reduce((s, x) => s + (x.hints_dropped || 0), 0);
            const hints = dropped ? `, ${dropped} corrupt hint${dropped === 1 ? "" : "s"} dropped` : "";
            return `Scrubbed ${res.length} nodes: ${checked} replicas re-hashed, ${bad} mismatch${bad === 1 ? "" : "es"}${bad ? ", repaired from healthy copies" : ""}${hints}.`;
          },
          "Scrub failed",
          (r) => ((r.results ?? []).some((x) => x.mismatches) ? "warn" : "ok"),
        );
        setBusy((b) => ({ ...b, scrub: false }));
      },
      stopNode: (id) =>
        run(() => api.nodeAction(base, id, "stop"), `${id} stopped. Peers will notice through missed probes.`, `Could not stop ${id}`, "warn"),
      startNode: (id) => run(() => api.nodeAction(base, id, "start"), `${id} started and is rejoining through its seeds.`, `Could not start ${id}`),
      partition: (a, b) => run(() => api.partition(base, a, b), `Cut the network between ${a} and ${b}.`, "Partition failed", "warn"),
      heal: () => run(() => api.heal(base), "Every partition healed.", "Heal failed"),
      corrupt: (key, node) =>
        run(() => api.corrupt(base, key, node), `Flipped a byte of ${key} on ${node}. Scrub or read it to see the heal.`, "Corrupt failed", "warn"),
      repair: (key) =>
        run(
          () => api.repair(base, key),
          (r) => (r.pushed?.length ? `Repaired ${key}: pushed from ${r.source} to ${r.pushed.join(", ")}.` : `${key} is already healthy on every reachable owner.`),
          `Repair of ${key} failed`,
        ),
      del: (key) => run(() => api.del(base, key), `Deleted ${key}. A tombstone replicates like any write.`, `Delete of ${key} failed`),
      setQuorum: (q) => run(() => api.setQuorum(base, q), `Policy ${q.n}/${q.w}/${q.r} gossiped to the cluster.`, "Policy change rejected"),
      put: async (key, file) => {
        try {
          const body = await api.put(base, key, file);
          const hints = body.acks.filter((a) => a.hint_for);
          notify(hints.length ? "warn" : "ok", `Stored ${key}: acked by ${body.acks.map((a) => a.node).join(", ")}${hints.length ? " (with a hint)" : ""}.`);
          refresh();
          return { body };
        } catch (e) {
          notify("error", `Upload failed: ${e.message}`);
          return { error: e.message, body: e.body };
        }
      },
      read: async (key) => {
        try {
          const res = await api.get(base, key);
          return { ...res, key, url: URL.createObjectURL(res.blob) };
        } catch (e) {
          return { key, error: e.message };
        }
      },
    };
  }, [base, notify, refresh]);

  const alerts = useMemo(() => events.filter((e) => (e.level === "error" || e.level === "warn") && e.t > seenAt).length, [events, seenAt]);
  const nodes = ov?.nodes ?? [];
  // Behind a load balancer every node gossips the same public URL; list
  // each address once, with the nodes it fronts.
  const switchTargets = useMemo(() => {
    const byUrl = new Map();
    for (const n of nodes) {
      if (!n.public_url || n.public_url === base) continue;
      const cur = byUrl.get(n.public_url) || { url: n.public_url, ids: [], up: false };
      cur.ids.push(n.id);
      cur.up = cur.up || (n.status !== "dead" && n.status !== "stopped");
      byUrl.set(n.public_url, cur);
    }
    return [...byUrl.values()];
  }, [nodes, base]);

  return (
    <div className="ath-app">
      <div className="ath-frame">
        <header className="ath-top">
          <a className="brand-pill ath-brand" href="/" title="Athanor home">
            <Icon.Flame size={20} /> Athanor
          </a>
          <nav className="pill-group ath-nav" aria-label="Dashboard sections">
            {PAGES.map(([id, label]) => (
              <a
                key={id}
                href={pathFor(id)}
                className="pill-btn"
                aria-current={page === id ? "page" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  go(id);
                }}
              >
                {label}
              </a>
            ))}
          </nav>
          <div className="ath-top-tools">
            <InstallButton className="ath-setting">
              <Icon.Download size={18} /> Install
            </InstallButton>
            <a
              href={pathFor("durability")}
              className={`ath-setting${page === "durability" ? " is-active" : ""}`}
              aria-current={page === "durability" ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                go("durability");
              }}
            >
              <Icon.Gear size={18} /> Durability
            </a>
            <button type="button" className="icon-btn ath-bell" onClick={() => go("events")} aria-label={`Events, ${alerts} new warnings`} title="Events">
              <Icon.Bell size={19} />
              {alerts ? <span className="ath-bell-badge num">{alerts > 9 ? "9+" : alerts}</span> : null}
            </button>
            <Menu label="Connection" icon="Plug" buttonClass="icon-btn" align="end">
              <MenuLabel>Coordinating through</MenuLabel>
              <div className="ath-conn-current">
                <span className={`ath-conn-dot is-${status}`} aria-hidden="true" />
                <span>
                  <strong>{ov?.coordinator || "—"}</strong>
                  {ov ? <span className={`chip ${ov.ready ? "outline" : "yellow"} ath-conn-ready`}>{ov.ready ? "ready" : "not ready"}</span> : null}
                  <br />
                  <span className="mono">{base || "searching…"}</span>
                </span>
              </div>
              <MenuLabel>Switch to</MenuLabel>
              {switchTargets.map((t) => (
                <MenuItem key={t.url} icon="Server" onSelect={() => connect(t.url)} disabled={!t.up}>
                  {t.ids.join(", ")} · {t.url}
                </MenuItem>
              ))}
              {nodes.length === 0
                ? known.map((k) => (
                    <MenuItem key={k} icon="Server" onSelect={() => connect(k)}>
                      {k}
                    </MenuItem>
                  ))
                : null}
            </Menu>
          </div>
        </header>

        <main id="main">
          {ov ? (
            <>
              {status === "offline" ? (
                <div className="ath-banner" role="alert">
                  <Icon.Alert size={16} /> Lost contact with every node ({error}). Showing the last view; retrying with backoff.
                </div>
              ) : null}
              {status === "ok" && ov.ready === false ? (
                <div className="ath-banner is-warn" role="status">
                  <Icon.Info size={16} /> {ov.coordinator} is up but not ready: too few live members for W={ov.config.quorum.w}. Writes will be refused until peers return.
                </div>
              ) : null}
              {page === "overview" ? <Overview ov={ov} events={events} now={now} actions={actions} busy={busy} go={go} /> : null}
              {page === "nodes" ? <Nodes ov={ov} ring={ring} base={base} actions={actions} now={now} /> : null}
              {page === "objects" ? <Objects ov={ov} ring={ring} events={events} actions={actions} now={now} /> : null}
              {page === "events" ? <Events key={eventKind || "all"} events={events} nodes={nodes} initialKind={eventKind} /> : null}
              {page === "durability" ? <Durability key={ov.config.version} ov={ov} actions={actions} now={now} /> : null}
            </>
          ) : (
            <Connect status={status} error={error} base={base} onConnect={connect} />
          )}
        </main>
      </div>
      <Toasts items={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  );
}

function Connect({ status, error, base, onConnect }) {
  const [url, setUrl] = useState(base || DEFAULT_BASE);
  return (
    <div className="ath-connect">
      <div className="ath-connect-orb" aria-hidden="true">
        <span className="ath-orb" />
      </div>
      <h1 className="ath-headline">{status === "connecting" ? "Finding a node" : "No node"}</h1>
      {status !== "connecting" ? (
        <>
          <p className="ath-lede">{error ? `${error}. ` : ""}Any node can coordinate.</p>
          <pre className="ath-code">
            <code>{"docker compose -f deploy/docker-compose.yml up --build\n# or, without Docker:\nscripts/local-cluster.sh"}</code>
          </pre>
          <form
            className="ath-connect-form"
            onSubmit={(e) => {
              e.preventDefault();
              onConnect(url);
            }}
          >
            <label className="ath-input-row">
              <Icon.Plug size={16} />
              <input value={url} onChange={(e) => setUrl(e.target.value)} spellCheck="false" aria-label="Node URL" />
            </label>
            <button type="submit" className="ath-pill-action is-dark">
              Connect
            </button>
          </form>
        </>
      ) : null}
    </div>
  );
}
