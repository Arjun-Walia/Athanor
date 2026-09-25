// Scroll, pointer and reveal hooks for the landing page.
//
// Nothing here depends on an animation library. Scroll work is funnelled
// through one requestAnimationFrame per frame, split into a read phase and a
// write phase so that no subscriber forces layout after another has written
// a style. Subscribers mostly write CSS custom properties; CSS turns those
// into transforms and opacity.

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

export const clamp = (value, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, value));

/* ------------------------------------------------------------------ */
/* Media queries                                                       */
/* ------------------------------------------------------------------ */

const queryStores = new Map();

function queryStore(query) {
  let store = queryStores.get(query);
  if (!store) {
    const supported = typeof window !== "undefined" && typeof window.matchMedia === "function";
    store = {
      subscribe(onChange) {
        if (!supported) return () => {};
        const list = window.matchMedia(query);
        list.addEventListener("change", onChange);
        return () => list.removeEventListener("change", onChange);
      },
      get: () => (supported ? window.matchMedia(query).matches : false),
    };
    queryStores.set(query, store);
  }
  return store;
}

export function useMediaQuery(query) {
  const store = queryStore(query);
  return useSyncExternalStore(store.subscribe, store.get, () => false);
}

export const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

export function useReducedMotion() {
  return useMediaQuery(REDUCED_MOTION);
}

/** Keeps the latest value in a ref so frame callbacks never read a stale prop. */
export function useLatest(value) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/* ------------------------------------------------------------------ */
/* One shared scroll frame                                             */
/* ------------------------------------------------------------------ */

const subscribers = new Set();
let frameId = 0;
let lastY = null;
let attached = false;
let bodyObserver = null;

function runFrame() {
  frameId = 0;
  const y = window.scrollY;
  const frame = {
    y,
    dy: lastY == null ? 0 : y - lastY,
    vw: window.innerWidth,
    vh: window.innerHeight,
  };
  lastY = y;

  // Read phase: every subscriber measures what it needs and returns a
  // writer. Write phase: all writers run after all reads are done.
  const writes = [];
  subscribers.forEach((ref) => {
    const write = ref.current?.(frame);
    if (typeof write === "function") writes.push(write);
  });
  for (const write of writes) write();
}

export function requestScrollFrame() {
  if (typeof window === "undefined" || frameId) return;
  frameId = window.requestAnimationFrame(runFrame);
}

function attach() {
  if (attached) return;
  attached = true;
  window.addEventListener("scroll", requestScrollFrame, { passive: true });
  window.addEventListener("resize", requestScrollFrame);
  // Late layout changes (web fonts, images) move sections without a scroll.
  if (typeof ResizeObserver !== "undefined") {
    bodyObserver = new ResizeObserver(requestScrollFrame);
    bodyObserver.observe(document.body);
  }
  document.fonts?.ready.then(requestScrollFrame).catch(() => {});
}

function detach() {
  if (!attached || subscribers.size > 0) return;
  attached = false;
  window.removeEventListener("scroll", requestScrollFrame);
  window.removeEventListener("resize", requestScrollFrame);
  bodyObserver?.disconnect();
  bodyObserver = null;
  if (frameId) window.cancelAnimationFrame(frameId);
  frameId = 0;
  lastY = null;
}

/**
 * Runs `callback(frame)` at most once per animation frame while the page
 * scrolls or resizes. The callback should only read layout; if it needs to
 * write, it returns a function and that function runs in the write phase.
 */
export function useScrollFrame(callback) {
  const ref = useRef(callback);
  useLayoutEffect(() => {
    ref.current = callback;
  });
  useEffect(() => {
    subscribers.add(ref);
    attach();
    requestScrollFrame();
    return () => {
      subscribers.delete(ref);
      detach();
    };
  }, []);
}

/* ------------------------------------------------------------------ */
/* Reveal on first sight                                               */
/* ------------------------------------------------------------------ */

/**
 * Sets `data-in` on the element the first time it scrolls into view. CSS
 * does the rest. A data attribute (not a class) so React re-renders never
 * wipe it.
 */
export function useReveal(rootMargin = "0px 0px -12% 0px") {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (typeof IntersectionObserver === "undefined") {
      el.setAttribute("data-in", "");
      return undefined;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.setAttribute("data-in", "");
            io.unobserve(entry.target);
          }
        }
      },
      { rootMargin, threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [rootMargin]);
  return ref;
}

/* ------------------------------------------------------------------ */
/* Which section is under the reading line                             */
/* ------------------------------------------------------------------ */

/** `ids` must be a stable array (a module constant). */
export function useActiveSection(ids) {
  const [active, setActive] = useState(null);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return undefined;
    const elements = ids.map((id) => document.getElementById(id)).filter(Boolean);
    const hits = new Map();
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) hits.set(entry.target.id, entry.isIntersecting);
        setActive(ids.find((id) => hits.get(id)) ?? null);
      },
      // A thin line a little above the middle of the viewport.
      { rootMargin: "-42% 0px -57% 0px", threshold: 0 },
    );
    elements.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [ids]);
  return active;
}

/* ------------------------------------------------------------------ */
/* Pointer tilt                                                        */
/* ------------------------------------------------------------------ */

/**
 * Writes smoothed pointer position as `--mx` / `--my` (each -1..1) on the
 * element while it is on screen. Only for fine pointers that can hover, and
 * never when reduced motion is requested. The loop stops once it settles.
 */
export function usePointerParallax(ref, enabled) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return undefined;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return undefined;

    let targetX = 0;
    let targetY = 0;
    let x = 0;
    let y = 0;
    let raf = 0;
    let last = 0;
    let onScreen = true;

    const step = (now) => {
      const dt = last ? Math.min(64, now - last) : 16;
      last = now;
      const k = 1 - Math.pow(1 - 0.075, dt / 16.67);
      x += (targetX - x) * k;
      y += (targetY - y) * k;
      el.style.setProperty("--mx", x.toFixed(4));
      el.style.setProperty("--my", y.toFixed(4));
      if (Math.abs(targetX - x) > 0.0008 || Math.abs(targetY - y) > 0.0008) {
        raf = window.requestAnimationFrame(step);
      } else {
        raf = 0;
        last = 0;
      }
    };
    const kick = () => {
      if (!raf) raf = window.requestAnimationFrame(step);
    };
    const onMove = (event) => {
      if (!onScreen) return;
      targetX = clamp((event.clientX / window.innerWidth) * 2 - 1, -1, 1);
      targetY = clamp((event.clientY / window.innerHeight) * 2 - 1, -1, 1);
      kick();
    };
    const onLeave = () => {
      targetX = 0;
      targetY = 0;
      kick();
    };

    const io =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(([entry]) => {
            onScreen = entry.isIntersecting;
          })
        : null;
    io?.observe(el);

    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      io?.disconnect();
      if (raf) window.cancelAnimationFrame(raf);
      el.style.removeProperty("--mx");
      el.style.removeProperty("--my");
    };
  }, [ref, enabled]);
}
