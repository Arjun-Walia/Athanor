import { useEffect, useState } from "react";
import { IconCheck, IconPulse, IconWrench } from "./icons.jsx";
import { PUBLIC_URL } from "./site.js";

/*
 * A strip of real numbers from the cluster this page was served by (or the
 * public cluster during development). It is the one part of the landing
 * page that is not an illustration, and it says so. If nothing answers,
 * the strip is not rendered: no placeholder, no last-known values.
 */

const EVERY = 5000;

function base() {
  const { origin } = window.location;
  if (!import.meta.env.DEV && origin.startsWith("http") && !window.athanorDesktop) return origin;
  return PUBLIC_URL;
}

function ago(iso, now) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t < Date.parse("2001-01-01")) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

export default function Live() {
  const [ov, setOv] = useState(null);
  const [at, setAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    let timer;
    const ctrl = new AbortController();
    const tick = async () => {
      try {
        const res = await fetch(`${base()}/v1/admin/overview`, { signal: ctrl.signal });
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        if (cancelled) return;
        setOv(data);
        setAt(Date.now());
      } catch {
        if (!cancelled) setOv(null);
      }
      if (!cancelled) timer = setTimeout(tick, EVERY);
    };
    tick();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearInterval(clock);
      ctrl.abort();
    };
  }, []);

  if (!ov) return null;

  const nodes = ov.nodes ?? [];
  const alive = nodes.filter((n) => n.status === "alive" || n.status === "suspect").length;
  const m = ov.metrics ?? {};
  const slots = (ov.objects ?? []).reduce((acc, o) => acc + o.target, 0);
  const healthy = (ov.objects ?? []).reduce((acc, o) => acc + o.healthy, 0);
  const lastRepair = ov.repairs?.last_at ? ago(ov.repairs.last_at, now) : null;
  const host = base().replace(/^https?:\/\//, "");
  const stale = now - at > EVERY * 3;

  return (
    <section className="ln-live" aria-label="Live cluster figures">
      <div className="ln-live-inner">
        <p className="ln-live-tag">
          <span className={`ln-live-dot${stale ? " is-stale" : ""}`} aria-hidden="true" />
          Live from <span className="mono">{host}</span>
        </p>
        <ul className="ln-live-facts">
          <li>
            <IconPulse size="0.95rem" />
            <b className="num">{alive}</b> of {nodes.length} nodes alive
          </li>
          <li>
            <IconCheck size="0.95rem" />
            <b className="num">{m.objects ?? 0}</b> object{m.objects === 1 ? "" : "s"} ·{" "}
            <b className="num">{slots ? Math.round((healthy / slots) * 100) : 100}%</b> of replica slots verified
          </li>
          <li>
            <IconWrench size="0.95rem" />
            {lastRepair ? (
              <>
                last repair <b>{lastRepair}</b> on <span className="mono">{ov.repairs.last_key}</span>
              </>
            ) : (
              <>
                <b className="num">{ov.repairs?.repairs ?? 0}</b> repairs since boot
              </>
            )}
          </li>
        </ul>
      </div>
    </section>
  );
}
