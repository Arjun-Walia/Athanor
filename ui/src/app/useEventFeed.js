import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";

const EVENTS_EVERY = 2000;
const MAX_EVENTS = 800;
// After the event stream drops, poll for this long before trying it again.
const STREAM_RETRY = 30_000;

/**
 * The merged cluster log, live. It follows the node in `baseRef` over
 * server-sent events when the node offers them (a snapshot first, then
 * only new lines) and polls otherwise. `nonce` re-opens the feed, for
 * example after a failover; while `paused` is true polling stops (the
 * stream, which costs nothing while idle, stays open).
 *
 * Returns the events oldest-first and which feed is active.
 */
export function useEventFeed(baseRef, nonce, paused) {
  const [events, setEvents] = useState([]);
  const [feed, setFeed] = useState("poll");
  const eventMap = useRef(new Map());
  const pausedRef = useRef(paused);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

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
      if (current && !pausedRef.current) {
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
  }, [nonce, absorb, baseRef]);

  return { events, feed };
}
