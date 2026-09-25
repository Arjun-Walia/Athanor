import { useCallback, useEffect, useRef, useState } from "react";
import { api, DEFAULT_BASE, trimBase } from "./api.js";

const OVERVIEW_EVERY = 1500;
const EVENTS_EVERY = 2000;
const MAX_EVENTS = 800;
const STORAGE_KEY = "athanor.base";

function initialCandidates() {
  const out = [];
  const saved = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
  if (saved) out.push(saved);
  // When a node serves this page (a production build), its origin is a node.
  const { origin } = window.location;
  if (!import.meta.env.DEV && origin.startsWith("http")) out.push(origin);
  out.push(DEFAULT_BASE);
  return [...new Set(out.map(trimBase))];
}

async function firstRunning(candidates, skip) {
  for (const cand of candidates) {
    if (cand === skip) continue;
    try {
      const h = await api.health(cand);
      if (h.state === "running") return { base: cand, node: h.node_id };
    } catch {
      // try the next one
    }
  }
  return null;
}

/**
 * Polls one coordinator node for the overview and the merged event log.
 * If that node stops or disappears, it fails over to another running node
 * it has learned about from gossip (each node publishes its public URL).
 */
export function useCluster() {
  const [base, setBase] = useState(null);
  const [overview, setOverview] = useState(null);
  const [ring, setRing] = useState(null);
  const [events, setEvents] = useState([]);
  const [status, setStatus] = useState("connecting");
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [nonce, setNonce] = useState(0);

  const baseRef = useRef(null);
  const knownRef = useRef(initialCandidates());
  const eventMap = useRef(new Map());
  const ringVersion = useRef(null);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const connect = useCallback((url) => {
    const next = trimBase(url);
    baseRef.current = next;
    setBase(next);
    localStorage.setItem(STORAGE_KEY, next);
    ringVersion.current = null;
    setNonce((n) => n + 1);
  }, []);

  const dismissNotice = useCallback(() => setNotice(null), []);

  // Overview loop, with failover.
  useEffect(() => {
    let cancelled = false;
    let timer;
    const ctrl = new AbortController();

    async function tick() {
      if (!baseRef.current) {
        const found = await firstRunning(knownRef.current);
        if (cancelled) return;
        if (found) {
          baseRef.current = found.base;
          setBase(found.base);
        }
      }
      const current = baseRef.current;
      if (current) {
        try {
          const ov = await api.overview(current, ctrl.signal);
          if (cancelled) return;
          for (const n of ov.nodes ?? []) {
            if (n.public_url && !knownRef.current.includes(trimBase(n.public_url))) {
              knownRef.current.push(trimBase(n.public_url));
            }
          }
          setOverview(ov);
          setStatus("ok");
          setError(null);
          if (ringVersion.current !== ov.ring_version) {
            ringVersion.current = ov.ring_version;
            api.ring(current).then((r) => !cancelled && setRing(r)).catch(() => {});
          }
        } catch (e) {
          if (cancelled || e.name === "AbortError") return;
          const next = await firstRunning(knownRef.current, current);
          if (cancelled) return;
          if (next) {
            const stopped = e.body?.stopped;
            setNotice({
              tone: "warn",
              text: stopped
                ? `${e.body.node} is stopped, so the dashboard now coordinates through ${next.node}.`
                : `Lost ${current}; the dashboard now coordinates through ${next.node}.`,
            });
            baseRef.current = next.base;
            setBase(next.base);
            ringVersion.current = null;
          } else {
            setStatus("offline");
            setError(e.message);
          }
        }
      } else {
        setStatus("offline");
        setError("No node answered.");
      }
      if (!cancelled) timer = setTimeout(tick, OVERVIEW_EVERY);
    }

    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [nonce]);

  // Event loop: merge every node's log into one timeline, keyed so a
  // replayed page never duplicates a line.
  useEffect(() => {
    let cancelled = false;
    let timer;
    const ctrl = new AbortController();

    async function tick() {
      const current = baseRef.current;
      if (current) {
        try {
          const body = await api.events(current, ctrl.signal);
          if (cancelled) return;
          let changed = false;
          for (const ev of body.events ?? []) {
            const id = `${ev.node}:${ev.seq}:${ev.at}`;
            if (!eventMap.current.has(id)) {
              eventMap.current.set(id, { ...ev, id, t: Date.parse(ev.at) });
              changed = true;
            }
          }
          if (changed) {
            let all = [...eventMap.current.values()].sort((a, b) => a.t - b.t || a.node.localeCompare(b.node) || a.seq - b.seq);
            if (all.length > MAX_EVENTS) {
              all = all.slice(all.length - MAX_EVENTS);
              eventMap.current = new Map(all.map((e) => [e.id, e]));
            }
            setEvents(all);
          }
        } catch {
          // the overview loop reports connectivity
        }
      }
      if (!cancelled) timer = setTimeout(tick, EVENTS_EVERY);
    }

    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [nonce]);

  return { base, overview, ring, events, status, error, notice, dismissNotice, refresh, connect, known: knownRef.current };
}

/** A clock that re-renders every `every` ms. */
export function useNow(every = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(id);
  }, [every]);
  return now;
}
