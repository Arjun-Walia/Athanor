// Formatting helpers shared by every dashboard view.

export function bytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function ago(iso, now = Date.now()) {
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(t) || t <= 0) return "never";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

export function clock(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function mmss(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// Versions are 64-bit hybrid logical clocks sent as strings: the high bits
// are milliseconds, the low 16 a counter. Show the tail, which is what
// changes between writes, and keep the full value for titles.
export function shortVersion(v) {
  if (!v) return "—";
  const s = String(v);
  return `…${s.slice(-6)}`;
}

export function versionTime(v) {
  try {
    return new Date(Number(BigInt(v) >> 16n));
  } catch {
    return null;
  }
}

export function shortSum(hex) {
  return hex ? `${hex.slice(0, 8)}…` : "—";
}

export function ms(n) {
  if (!Number.isFinite(n)) return "—";
  if (n < 1) return `${(n * 1000).toFixed(0)} µs`;
  if (n < 100) return `${n.toFixed(1)} ms`;
  return `${Math.round(n)} ms`;
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export function nodeShort(id) {
  const m = /^node(\d+)$/.exec(id || "");
  return m ? `n${m[1]}` : id;
}
