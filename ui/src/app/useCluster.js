import { useCallback, useEffect, useRef, useState } from "react";
import { api, DEFAULT_BASE, PUBLIC_BASE, isLoopback, trimBase } from "./api.js";

const OVERVIEW_EVERY = 1500;
const EVENTS_EVERY = 2000;
const MAX_EVENTS = 800;
const STORAGE_KEY = "athanor.base";
// After the event stream drops, poll for this long before trying it again.
const STREAM_RETRY = 30_000;

// Back off while every node is unreachable so a closed laptop does not
// hammer a dead address, but come back quickly once something answers.
const OFFLINE_BACKOFF = [2000, 4000, 8000, 15000];

function desktopDefault() {
  const d = typeof window !== "undefined" ? window.athanorDesktop : null;
  return d?.defaultBase ? trimBase(d.defaultBase) : null;
}

/**
 * Which nodes to try, in order. The origin that served the page comes
 * first when it is a node (a production build), then whatever the user
 * connected to last, then the local defaults, then the public cluster.
 */
function initialCandidates() {
  const out = [];
  const { origin } = window.location;
  const servedByNode = !import.meta.env.DEV && origin.startsWith("http");
  if (servedByNode) out.push(origin);
  const saved = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
  if (saved) out.push(saved);
  const fromDesktop = desktopDefault();
  if (fromDesktop) out.push(fromDesktop);
  out.push(DEFAULT_BASE);
  if (!servedByNode || isLoopback(origin)) out.push(PUBLIC_BASE);
  return dedupe(out);
}

function dedupe(urls) {
  return [...new Set(urls.map(trimBase).filter(Boolean))];
}

/**
 * A node's gossiped public URL is only useful from where this page runs. A
 * page served from the internet cannot reach "http://localhost:8082", and
 * would otherwise fail over into a wall of timeouts.
 */
function usableFromHere(url) {
  if (!url) return false;
  const here = window.location.origin;
  if (!here.startsWith("http")) return true; // desktop shell, file://: try anything
  if (isLoopback(url) && !isLoopback(here)) return false;
  if (here.startsWith("https:") && url.startsWith("http:") && !isLoopback(url)) return false; // mixed content
  return true;
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
 * Polls one coordinator node for the overview, and follows its merged event
 * log over server-sent events (falling back to polling when the stream is
 * unavailable). If that node stops or disappears, it fails over to another
 * running node it has learned about from gossip (each node publishes its
 * public URL).
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
  // "stream" while the SSE connection is open, "poll" otherwise.
  const [feed, setFeed] = useState("poll");

  const baseRef = useRef(null);
  // Candidate list: state for the connection menu, a ref for the loops.
  const [known, setKnown] = useState(initialCandidates);
  const knownRef = useRef(known);
  useEffect(() => {
    knownRef.current = known;
  }, [known]);
  const addKnown = useCallback((url) => {
    if (!knownRef.current.includes(url)) {
      knownRef.current = [...knownRef.current, url];
      setKnown(knownRef.current);
    }
  }, []);
  const eventMap = useRef(new Map());
  const ringVersion = useRef(null);
  const misses = useRef(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const connect = useCallback((url) => {
    const next = trimBase(url);
    baseRef.current = next;
    setBase(next);
    localStorage.setItem(STORAGE_KEY, next);
    if (!knownRef.current.includes(next)) {
      knownRef.current = [next, ...knownRef.current];
      setKnown(knownRef.current);
    }
    ringVersion.current = null;
    misses.current = 0;
    setNonce((n) => n + 1);
  }, []);

  const dismissNotice = useCallback(() => setNotice(null), []);

  // Merge a page of events into the timeline, keyed so a replayed page or
  // an overlapping stream never duplicates a line.
  const absorb = useCallback((list) => {
    let changed = false;
    for (const ev of list ?? []) {
      const id = `${ev.node}:${ev.seq}:${ev.at}`;
      if (!eventMap.current.has(id)) {
        eventMap.current.set(id, { ...ev, id, t: Date.parse(ev.at) });
        changed = true;
      }
    }
    if (!changed) return;
    let all = [...eventMap.current.values()].sort((a, b) => a.t - b.t || a.node.localeCompare(b.node) || a.seq - b.seq);
    if (all.length > MAX_EVENTS) {
      all = all.slice(all.length - MAX_EVENTS);
      eventMap.current = new Map(all.map((e) => [e.id, e]));
    }
    setEvents(all);
  }, []);

  // Overview loop, with failover and offline backoff.
  useEffect(() => {
    let cancelled = false;
    let timer;
    const ctrl = new AbortController();

    async function tick() {
      let delay = OVERVIEW_EVERY;
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
            const url = trimBase(n.public_url);
            if (url && usableFromHere(url)) addKnown(url);
          }
          setOverview(ov);
          setStatus("ok");
          setError(null);
          misses.current = 0;
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
            misses.current = 0;
            setNonce((n) => n + 1); // re-open the event feed on the new node
          } else {
            setStatus("offline");
            setError(e.message);
            delay = OFFLINE_BACKOFF[Math.min(misses.current, OFFLINE_BACKOFF.length - 1)];
            misses.current += 1;
          }
        }
      } else {
        setStatus("offline");
        setError("No node answered.");
        delay = OFFLINE_BACKOFF[Math.min(misses.current, OFFLINE_BACKOFF.length - 1)];
        misses.current += 1;
      }
      if (!cancelled) timer = setTimeout(tick, delay);
    }

    tick();
    const onOnline = () => {
      misses.current = 0;
      clearTimeout(timer);
      tick();
    };
    window.addEventListener("online", onOnline);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("online", onOnline);
      ctrl.abort();
    };
  }, [nonce, addKnown]);

  // A notice is a one-off message for the toast tray; it clears itself.
  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  // Event feed: server-sent events when the node offers them, polling
  // otherwise. The stream carries a snapshot first, then only new lines.
  useEffect(() => {
    let cancelled = false;
    let timer;
    let source = null;
    let streamOK = false;
    let lastStreamFailure = 0;
    const ctrl = new AbortController();

    function openStream(current) {
      if (typeof EventSource === "undefined") return;
      if (Date.now() - lastStreamFailure < STREAM_RETRY) return;
      source = new EventSource(`${current}/v1/admin/events/stream`);
      const onData = (e) => {
        try {
          absorb(JSON.parse(e.data));
        } catch {
          // a malformed frame is ignored; the next one is independent
        }
      };
      source.addEventListener("snapshot", onData);
      source.addEventListener("log", onData);
      source.onopen = () => {
        streamOK = true;
        if (!cancelled) setFeed("stream");
      };
      source.onerror = () => {
        // EventSource retries on its own for transient drops; only give up
        // (and poll) when the connection never opened or keeps failing.
        if (source && source.readyState === EventSource.CLOSED) {
          streamOK = false;
          lastStreamFailure = Date.now();
          source = null;
          if (!cancelled) setFeed("poll");
        } else if (!streamOK) {
          source?.close();
          source = null;
          lastStreamFailure = Date.now();
          if (!cancelled) setFeed("poll");
        }
      };
    }

    async function tick() {
      const current = baseRef.current;
      if (current) {
        if (!source) openStream(current);
        if (!streamOK) {
          try {
            const body = await api.events(current, ctrl.signal);
            if (cancelled) return;
            absorb(body.events);
          } catch {
            // the overview loop reports connectivity
          }
        }
      }
      if (!cancelled) timer = setTimeout(tick, EVENTS_EVERY);
    }

    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      source?.close();
      ctrl.abort();
    };
  }, [nonce, absorb]);

  return { base, overview, ring, events, status, error, notice, dismissNotice, refresh, connect, feed, known };
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
