import { useCallback, useEffect, useMemo, useState } from "react";
import "./dashboard.css";
import { Icon } from "./icons.jsx";
import { Toasts } from "./components.jsx";
import { InstallButton } from "../shell.jsx";
import { useCluster, useNow } from "./useCluster.js";
import { useActions } from "./useActions.js";
import { Connect, ConnectionMenu } from "./Connection.jsx";
import Overview from "./pages/Overview.jsx";
import Nodes from "./pages/Nodes.jsx";
import Objects from "./pages/Objects.jsx";
import Events from "./pages/Events.jsx";
import Durability from "./pages/Durability.jsx";

// Page id, label, and the icon the phone-width tab bar shows beside it.
const PAGES = [
  ["overview", "Dashboard", "Activity"],
  ["nodes", "Nodes", "Nodes"],
  ["objects", "Objects", "Box"],
  ["events", "Events", "Bell"],
];

const TITLES = { overview: "Dashboard", nodes: "Nodes", objects: "Objects", events: "Events", durability: "Durability" };

export function pageFromPath(pathname) {
  const seg = pathname.replace(/^\/app\/?/, "").split("/")[0];
  return ["nodes", "objects", "events", "durability"].includes(seg) ? seg : "overview";
}

export function pathFor(page) {
  return page === "overview" ? "/app" : `/app/${page}`;
}

const TOAST_TTL = { error: 9000, warn: 5500, ok: 5500 };
let toastSeq = 0;

/** The toast tray: at most four recent messages, each expiring on its own. */
function useToasts() {
  const [toasts, setToasts] = useState([]);
  const notify = useCallback((tone, text) => {
    const id = ++toastSeq;
    setToasts((t) => [...t.slice(-3), { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), TOAST_TTL[tone] ?? TOAST_TTL.ok);
  }, []);
  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  return { toasts, notify, dismiss };
}

/** The current page, kept in the address bar. */
function usePage() {
  const [page, setPage] = useState(() => pageFromPath(window.location.pathname));
  useEffect(() => {
    const onPop = () => setPage(pageFromPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    document.title = `${TITLES[page]} · Athanor`;
  }, [page]);
  const go = useCallback((next) => {
    setPage(next);
    if (window.location.pathname !== pathFor(next)) window.history.pushState(null, "", pathFor(next));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);
  return [page, go];
}

export default function Dashboard() {
  const { base, overview: ov, ring, events, status, error, notice, dismissNotice, refresh, connect, feed, known } = useCluster();
  const now = useNow(1000);
  const [page, goPage] = usePage();
  const [eventKind, setEventKind] = useState(null);
  const [busy, setBusy] = useState({});
  const [seenAt, setSeenAt] = useState(() => Date.now());
  const { toasts, notify, dismiss } = useToasts();
  const actions = useActions({ base, notify, refresh, setBusy });

  const go = useCallback(
    (next, arg) => {
      if (next === "events") {
        setEventKind(arg || null);
        setSeenAt(Date.now());
      }
      goPage(next);
    },
    [goPage],
  );

  const alerts = useMemo(() => events.filter((e) => (e.level === "error" || e.level === "warn") && e.t > seenAt).length, [events, seenAt]);
  const nodes = useMemo(() => ov?.nodes ?? [], [ov]);
  // Failover notices from the cluster hook join the toast tray.
  const tray = useMemo(() => (notice ? [...toasts, { id: "notice", tone: notice.tone, text: notice.text }] : toasts), [toasts, notice]);

  return (
    <div className="ath-app">
      <div className="ath-frame">
        <header className="ath-top">
          <a className="brand ath-brand" href="/" title="Athanor home">
            <Icon.Flame size={22} className="brand-glyph" />
            <span>Athanor</span>
          </a>
          <nav className="pill-group ath-nav" aria-label="Dashboard sections">
            {PAGES.map(([id, label, icon]) => {
              const I = Icon[icon];
              return (
                <a
                  key={id}
                  href={pathFor(id)}
                  className="pill-btn ath-nav-link"
                  aria-current={page === id ? "page" : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    go(id);
                  }}
                >
                  <I size={18} className="ath-nav-icon" />
                  <span>{label}</span>
                </a>
              );
            })}
          </nav>
          <div className="ath-top-tools">
            <InstallButton className="ath-setting">
              <Icon.Download size={18} /> <span className="ath-setting-label">Install</span>
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
              <Icon.Gear size={18} /> <span className="ath-setting-label">Durability</span>
            </a>
            <button type="button" className="icon-btn ath-bell" onClick={() => go("events")} aria-label={`Events, ${alerts} new warnings`} title="Events">
              <Icon.Bell size={19} />
              {alerts ? <span className="ath-bell-badge num">{alerts > 9 ? "9+" : alerts}</span> : null}
            </button>
            <ConnectionMenu base={base} ov={ov} status={status} feed={feed} nodes={nodes} known={known} onConnect={connect} />
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
                  <Icon.Info size={16} /> {ov.coordinator} is up but not ready: too few live members for W={ov.config.quorum.w}. Writes will be refused until
                  peers return.
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
      <Toasts items={tray} onDismiss={(id) => (id === "notice" ? dismissNotice() : dismiss(id))} />
    </div>
  );
}
