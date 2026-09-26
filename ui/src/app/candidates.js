// Which nodes the dashboard should try, and which gossiped addresses are
// worth trying from where the page runs. Pure functions: the environment
// (origin, dev mode, saved choice, desktop default) is passed in, so the
// rules are unit-testable and the hook that uses them stays small.
import { DEFAULT_BASE, PUBLIC_BASE, isLoopback, trimBase } from "./api.js";

export const STORAGE_KEY = "athanor.base";

export function dedupe(urls) {
  return [...new Set(urls.map(trimBase).filter(Boolean))];
}

/**
 * Candidates in order: the origin that served the page when it is a node
 * (a production build), then whatever the user connected to last, then the
 * desktop app's configured fallback, then the local default, then the
 * public cluster (only when the page is not itself served by a public
 * node).
 */
export function candidatesFor({ origin, dev = false, saved = null, desktopBase = null }) {
  const out = [];
  const servedByNode = !dev && typeof origin === "string" && origin.startsWith("http");
  if (servedByNode) out.push(origin);
  if (saved) out.push(saved);
  if (desktopBase) out.push(desktopBase);
  out.push(DEFAULT_BASE);
  if (!servedByNode || isLoopback(origin)) out.push(PUBLIC_BASE);
  return dedupe(out);
}

/** candidatesFor, read from the browser environment. */
export function initialCandidates() {
  let saved = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    // storage blocked
  }
  const desktop = typeof window !== "undefined" ? window.athanorDesktop : null;
  return candidatesFor({
    origin: window.location.origin,
    dev: import.meta.env.DEV,
    saved,
    desktopBase: desktop?.defaultBase ? trimBase(desktop.defaultBase) : null,
  });
}

/**
 * A node's gossiped public URL is only useful from where this page runs. A
 * page served from the internet cannot reach "http://localhost:8082", and
 * an https page cannot fetch plain http from another host (mixed content).
 */
export function usableFromHere(url, here) {
  if (!url) return false;
  if (!here || !here.startsWith("http")) return true; // desktop shell, file://: try anything
  if (isLoopback(url) && !isLoopback(here)) return false;
  if (here.startsWith("https:") && url.startsWith("http:") && !isLoopback(url)) return false;
  return true;
}
