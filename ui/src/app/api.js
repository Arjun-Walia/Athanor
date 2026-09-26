// Thin client for one node's HTTP API. Any node can coordinate any call.
//
// The dashboard may be served by a node (production), by Vite (development),
// or by the desktop shell (no origin at all). Which node to talk to is
// decided in useCluster.js; this file only knows how to talk to one.

export const DEFAULT_BASE = "http://localhost:8081";

// The public cluster. The desktop app and a dev build fall back to it when
// no local node answers, so an installed app works out of the box.
export const PUBLIC_BASE = "https://www.athanor.cfd";

// The admin token, when a cluster requires one for writes and admin
// actions. Kept for the tab only (sessionStorage), never in the URL.
const TOKEN_KEY = "athanor.token";

export function getToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function setToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage blocked: the token lives for this page load only
  }
}

export function trimBase(base) {
  return String(base || "").replace(/\/+$/, "");
}

/** True for localhost, 127.0.0.1, [::1] and *.localhost origins. */
export function isLoopback(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1" || hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

// Keys may contain slashes; encode each segment, keep the separators.
export function keyPath(key) {
  return key.split("/").map(encodeURIComponent).join("/");
}

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request(base, path, { method = "GET", body, headers, signal, timeout = 6000, raw = false } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException("timed out", "TimeoutError")), timeout);
  const onAbort = () => ctrl.abort(signal.reason);
  signal?.addEventListener("abort", onAbort);
  const token = method !== "GET" ? getToken() : "";
  const allHeaders = token ? { ...(headers || {}), Authorization: `Bearer ${token}` } : headers;
  try {
    const res = await fetch(`${trimBase(base)}${path}`, { method, body, headers: allHeaders, signal: ctrl.signal });
    if (raw) {
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new ApiError(data.error || `${res.status} ${res.statusText}`, res.status, data);
      }
      return res;
    }
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text };
    }
    if (!res.ok) throw new ApiError(data.error || `${res.status} ${res.statusText}`, res.status, data);
    return data;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

const json = (value) => ({ body: JSON.stringify(value), headers: { "Content-Type": "application/json" } });

export const api = {
  health: (base, signal) => request(base, "/v1/admin/health", { signal, timeout: 2500 }),
  ready: (base, signal) => request(base, "/v1/admin/ready", { signal, timeout: 2500 }),
  overview: (base, signal) => request(base, "/v1/admin/overview", { signal }),
  events: (base, signal) => request(base, "/v1/admin/events?limit=400", { signal }),
  ring: (base, key, signal) => request(base, `/v1/admin/ring${key ? `?key=${encodeURIComponent(key)}` : ""}`, { signal }),
  setQuorum: (base, quorum) => request(base, "/v1/admin/config", { method: "PUT", ...json(quorum) }),
  scrub: (base) => request(base, "/v1/admin/scrub", { method: "POST", timeout: 60000 }),
  repair: (base, key) => request(base, `/v1/admin/repair/${keyPath(key)}`, { method: "POST", timeout: 20000 }),
  corrupt: (base, key, node) => request(base, "/v1/admin/corrupt", { method: "POST", ...json({ key, node }) }),
  nodeAction: (base, id, action) => request(base, `/v1/admin/nodes/${encodeURIComponent(id)}/${action}`, { method: "POST", timeout: 12000 }),
  partition: (base, a, b) => request(base, "/v1/admin/partitions", { method: "POST", ...json({ a, b }) }),
  heal: (base) => request(base, "/v1/admin/partitions", { method: "DELETE" }),
  put: (base, key, blob) =>
    request(base, `/v1/objects/${keyPath(key)}`, {
      method: "PUT",
      body: blob,
      headers: blob.type ? { "Content-Type": blob.type } : undefined,
      timeout: 120000,
    }),
  del: (base, key) => request(base, `/v1/objects/${keyPath(key)}`, { method: "DELETE" }),
  async get(base, key) {
    const started = performance.now();
    const res = await request(base, `/v1/objects/${keyPath(key)}`, { raw: true, timeout: 60000 });
    const blob = await res.blob();
    const h = (name) => res.headers.get(name) || "";
    return {
      blob,
      tookMs: performance.now() - started,
      version: h("X-Athanor-Version"),
      checksum: h("X-Athanor-Checksum"),
      coordinator: h("X-Athanor-Coordinator"),
      answeredBy: h("X-Athanor-Node"),
      degraded: h("X-Athanor-Degraded") === "true",
      replicas: h("X-Athanor-Replicas")
        .split(",")
        .filter(Boolean)
        .map((pair) => {
          const [node, status] = pair.split("=");
          return { node, status };
        }),
    };
  },
};
