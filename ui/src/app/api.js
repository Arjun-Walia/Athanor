// Thin client for one node's HTTP API. Any node can coordinate any call.

export const DEFAULT_BASE = "http://localhost:8081";

export function trimBase(base) {
  return base.replace(/\/+$/, "");
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
  try {
    const res = await fetch(`${trimBase(base)}${path}`, { method, body, headers, signal: ctrl.signal });
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
  overview: (base, signal) => request(base, "/v1/admin/overview", { signal }),
  events: (base, signal) => request(base, "/v1/admin/events?limit=400", { signal }),
  ring: (base, key, signal) =>
    request(base, `/v1/admin/ring${key ? `?key=${encodeURIComponent(key)}` : ""}`, { signal }),
  setQuorum: (base, quorum) => request(base, "/v1/admin/config", { method: "PUT", ...json(quorum) }),
  scrub: (base) => request(base, "/v1/admin/scrub", { method: "POST", timeout: 60000 }),
  repair: (base, key) => request(base, `/v1/admin/repair/${keyPath(key)}`, { method: "POST", timeout: 20000 }),
  corrupt: (base, key, node) => request(base, "/v1/admin/corrupt", { method: "POST", ...json({ key, node }) }),
  nodeAction: (base, id, action) =>
    request(base, `/v1/admin/nodes/${encodeURIComponent(id)}/${action}`, { method: "POST", timeout: 12000 }),
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
