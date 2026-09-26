import { useCallback, useEffect, useRef, useState } from "react";
import { api, trimBase } from "./api.js";
import { STORAGE_KEY, initialCandidates, usableFromHere } from "./candidates.js";
import { useEventFeed } from "./useEventFeed.js";

const OVERVIEW_EVERY = 1500;
// A tab nobody is looking at still keeps the picture, just more slowly.
const HIDDEN_EVERY = 15_000;
const NOTICE_TTL = 6000;

// Back off while every node is unreachable so a closed laptop does not
// hammer a dead address, but come back quickly once something answers.
const OFFLINE_BACKOFF = [2000, 4000, 8000, 15000];

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

/** True while the tab is visible; polling slows down when it is not. */
export function usePageVisible() {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  useEffect(() => {
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
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
  const [status, setStatus] = useState("connecting");
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [nonce, setNonce] = useState(0);
  const visible = usePageVisible();

  const baseRef = useRef(null);
  // Candidate list: state for the connection menu, a ref for the loops.
  const [known, setKnown] = useState(initialCandidates);
  const knownRef = useRef(known);
  useEffect(() => {
    knownRef.current = known;
  }, [known]);
  const addKnown = useCallback((url, first = false) => {
    if (knownRef.current.includes(url)) return;
    knownRef.current = first ? [url, ...knownRef.current] : [...knownRef.current, url];
    setKnown(knownRef.current);
  }, []);
  const ringVersion = useRef(null);
  const misses = useRef(0);
  const visibleRef = useRef(visible);
  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const connect = useCallback(
    (url) => {
      const next = trimBase(url);
      baseRef.current = next;
      setBase(next);
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // storage blocked: the choice lasts for this page load
      }
      addKnown(next, true);
      ringVersion.current = null;
      misses.current = 0;
      setNonce((n) => n + 1);
    },
    [addKnown],
  );

  const dismissNotice = useCallback(() => setNotice(null), []);

  // Overview loop, with failover and offline backoff.
  useEffect(() => {
    let cancelled = false;
    let timer;
    const ctrl = new AbortController();

    const failover = async (current, e) => {
      const next = await firstRunning(knownRef.current, current);
      if (cancelled) return false;
      if (!next) return false;
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
      return true;
    };

    const offline = (message) => {
      setStatus("offline");
      setError(message);
      const delay = OFFLINE_BACKOFF[Math.min(misses.current, OFFLINE_BACKOFF.length - 1)];
      misses.current += 1;
      return delay;
    };

    async function tick() {
      let delay = visibleRef.current ? OVERVIEW_EVERY : HIDDEN_EVERY;
      if (!baseRef.current) {
        const found = await firstRunning(knownRef.current);
        if (cancelled) return;
        if (found) {
          baseRef.current = found.base;
          setBase(found.base);
        }
      }
      const current = baseRef.current;
      if (!current) {
        delay = offline("No node answered.");
      } else {
        try {
          const ov = await api.overview(current, ctrl.signal);
          if (cancelled) return;
          for (const n of ov.nodes ?? []) {
            const url = trimBase(n.public_url);
            if (url && usableFromHere(url, window.location.origin)) addKnown(url);
          }
          setOverview(ov);
          setStatus("ok");
          setError(null);
          misses.current = 0;
          if (ringVersion.current !== ov.ring_version) {
            ringVersion.current = ov.ring_version;
            api
              .ring(current)
              .then((r) => !cancelled && setRing(r))
              .catch(() => {});
          }
        } catch (e) {
          if (cancelled || e.name === "AbortError") return;
          if (!(await failover(current, e))) delay = offline(e.message);
        }
      }
      if (!cancelled) timer = setTimeout(tick, delay);
    }

    tick();
    const wake = () => {
      misses.current = 0;
      clearTimeout(timer);
      tick();
    };
    const onVisibility = () => {
      if (!document.hidden) wake();
    };
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", onVisibility);
      ctrl.abort();
    };
  }, [nonce, addKnown]);

  // A notice is a one-off message for the toast tray; it clears itself.
  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(null), NOTICE_TTL);
    return () => clearTimeout(t);
  }, [notice]);

  const { events, feed } = useEventFeed(baseRef, nonce, !visible);

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
