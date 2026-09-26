import { useMemo, useState } from "react";
import { Icon } from "./icons.jsx";
import { Menu, MenuItem, MenuLabel } from "./components.jsx";
import { DEFAULT_BASE, getToken, setToken } from "./api.js";

/**
 * The plug menu: which node the dashboard coordinates through, how the log
 * arrives, the admin token, and the other nodes it could switch to.
 */
export function ConnectionMenu({ base, ov, status, feed, nodes, known, onConnect }) {
  // Behind a load balancer every node gossips the same public URL; list
  // each address once, with the nodes it fronts.
  const targets = useMemo(() => {
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
    <Menu label="Connection" icon="Plug" buttonClass="icon-btn" align="end">
      <MenuLabel>Coordinating through</MenuLabel>
      <div className="ath-conn-current">
        <span className={`ath-conn-dot is-${status}`} aria-hidden="true" />
        <span>
          <strong>{ov?.coordinator || "—"}</strong>
          {ov ? <span className={`chip ${ov.ready ? "outline" : "yellow"} ath-conn-ready`}>{ov.ready ? "ready" : "not ready"}</span> : null}
          <br />
          <span className="mono">{base || "searching…"}</span>
          <br />
          <span className="ath-conn-feed">{feed === "stream" ? "log streamed live (SSE)" : "log polled every 2s"}</span>
        </span>
      </div>
      <MenuLabel>Admin token</MenuLabel>
      <TokenField />
      <MenuLabel>Switch to</MenuLabel>
      {targets.map((t) => (
        <MenuItem key={t.url} icon="Server" onSelect={() => onConnect(t.url)} disabled={!t.up}>
          {t.ids.join(", ")} · {t.url}
        </MenuItem>
      ))}
      {nodes.length === 0
        ? known.map((k) => (
            <MenuItem key={k} icon="Server" onSelect={() => onConnect(k)}>
              {k}
            </MenuItem>
          ))
        : null}
    </Menu>
  );
}

/**
 * Where the admin token goes when a cluster requires one. It stays in this
 * tab's sessionStorage and is sent only on requests that change something.
 */
export function TokenField() {
  const [value, setValue] = useState(() => getToken());
  const [saved, setSaved] = useState(false);
  const id = "ath-token";
  return (
    <form
      className="ath-token"
      onSubmit={(e) => {
        e.preventDefault();
        setToken(value.trim());
        setSaved(true);
      }}
    >
      <label htmlFor={id} className="sr-only">
        Admin token
      </label>
      <span className="ath-input-row is-compact">
        <Icon.Shield size={15} />
        <input
          id={id}
          type="password"
          autoComplete="off"
          value={value}
          placeholder="only if the cluster asks"
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
          }}
        />
      </span>
      <button type="submit" className="ath-pill-action">
        {saved ? "Saved" : "Use"}
      </button>
    </form>
  );
}

/** What the dashboard shows before any node has answered. */
export function Connect({ status, error, base, onConnect }) {
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
