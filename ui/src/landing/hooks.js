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

/**
 * Writes an element's progress through the viewport as `--p` (0 when its
 * top reaches the bottom of the screen, 1 when its bottom leaves the top),
 * quantised so unchanged frames write nothing.
 */
export function useProgress(ref, { start = 1, end = 0, name = "--p", steps = 1000 } = {}) {
  const last = useRef(-1);
  useScrollFrame((frame) => {
    const el = ref.current;
    if (!el) return undefined;
    const rect = el.getBoundingClientRect();
    // start/end are fractions of the viewport height where progress is 0/1.
    const from = frame.vh * start;
    const to = frame.vh * end - rect.height;
    const p = clamp((rect.top - from) / (to - from || 1));
    const q = Math.round(p * steps) / steps;
    if (q === last.current) return undefined;
    last.current = q;
    return () => el.style.setProperty(name, String(q));
  });
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

/** True once the element has been on screen. Never flips back. */
export function useInView(ref, rootMargin = "0px 0px -15% 0px") {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return undefined;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return undefined;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin, threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, rootMargin, seen]);
  return seen;
}

/** Counts from 0 to `to` over `ms` once `go` is true. Integer output. */
export function useCountUp(to, go, ms = 1200) {
  const reduced = useReducedMotion();
  const [value, setValue] = useState(reduced ? to : 0);
  useEffect(() => {
    if (!go) return undefined;
    if (reduced) {
      setValue(to);
      return undefined;
    }
    let raf = 0;
    const started = performance.now();
    const step = (now) => {
      const t = clamp((now - started) / ms);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(to * eased));
      if (t < 1) raf = window.requestAnimationFrame(step);
    };
    raf = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(raf);
  }, [to, go, ms, reduced]);
  return value;
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
/* Pointer                                                             */
/* ------------------------------------------------------------------ */

const FINE_POINTER = "(hover: hover) and (pointer: fine)";

/**
 * Writes smoothed pointer position as `--mx` / `--my` (each -1..1) on the
 * element while it is on screen. Only for fine pointers that can hover, and
 * never when reduced motion is requested. The loop stops once it settles.
 */
export function usePointerParallax(ref, enabled) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return undefined;
    if (!window.matchMedia(FINE_POINTER).matches) return undefined;

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

/**
 * Magnetic buttons: the element leans toward a nearby pointer and springs
 * back when it leaves. Writes `--tx` / `--ty` in px; CSS applies them.
 */
export function useMagnetic(ref, { radius = 90, strength = 0.35, enabled = true } = {}) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return undefined;
    if (!window.matchMedia(FINE_POINTER).matches) return undefined;
    if (window.matchMedia(REDUCED_MOTION).matches) return undefined;

    let raf = 0;
    let tx = 0;
    let ty = 0;
    let gx = 0;
    let gy = 0;

    const step = () => {
      tx += (gx - tx) * 0.18;
      ty += (gy - ty) * 0.18;
      el.style.setProperty("--tx", `${tx.toFixed(2)}px`);
      el.style.setProperty("--ty", `${ty.toFixed(2)}px`);
      raf = Math.abs(gx - tx) > 0.05 || Math.abs(gy - ty) > 0.05 ? window.requestAnimationFrame(step) : 0;
    };
    const kick = () => {
      if (!raf) raf = window.requestAnimationFrame(step);
    };
    const onMove = (e) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const d = Math.hypot(dx, dy);
      if (d > radius + Math.max(r.width, r.height) / 2) {
        gx = 0;
        gy = 0;
      } else {
        gx = dx * strength;
        gy = dy * strength;
      }
      kick();
    };
    const onLeave = () => {
      gx = 0;
      gy = 0;
      kick();
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      if (raf) window.cancelAnimationFrame(raf);
      el.style.removeProperty("--tx");
      el.style.removeProperty("--ty");
    };
  }, [ref, radius, strength, enabled]);
}
