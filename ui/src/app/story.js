// Derived views over the merged event log: the demo checklist, grouped
// observations, and short labels for timeline chips. Everything here is read
// from real events; nothing is simulated.

const has = (e, text) => e.message.includes(text);

/**
 * The 90-second judging script from PLAN.md. A step is done when the event
 * log shows it happened (after the optional reset time).
 */
export const DEMO_STEPS = [
  {
    id: "alive",
    title: "Five nodes alive",
    hint: "Start the five-node topology",
    icon: "Nodes",
    match: (e) => e.kind === "membership" && has(e, "settled on ring") && /with ([5-9]|\d{2,}) members/.test(e.message),
    live: (state) => (state.aliveNow >= 5 ? `${state.aliveNow} alive right now` : null),
  },
  {
    id: "upload",
    title: "Upload an object",
    hint: "Objects → Upload a file",
    icon: "Upload",
    match: (e) => e.kind === "write" && e.fields?.op === "put" && e.level !== "error",
  },
  {
    id: "kill",
    title: "Kill a node",
    hint: "Nodes → Stop any node",
    icon: "Power",
    match: (e) => e.kind === "fault" && has(e, "stopped: gossip and peer RPC are off"),
  },
  {
    id: "degraded",
    title: "Read while degraded",
    hint: "Download while a replica is down",
    icon: "Eye",
    match: (e) => e.kind === "read" && has(e, "served degraded"),
  },
  {
    id: "corrupt",
    title: "Corrupt a replica",
    hint: "Objects → Corrupt a copy",
    icon: "Zap",
    match: (e) => e.kind === "fault" && has(e, "flipped a byte"),
  },
  {
    id: "heal",
    title: "Watch it heal",
    hint: "Scrub now, or read the object",
    icon: "Heal",
    match: (e) => e.kind === "repair" && e.level === "ok" && has(e, "checksum mismatch"),
  },
  {
    id: "restart",
    title: "Restart the node",
    hint: "Nodes → Start it again",
    icon: "Play",
    match: (e, prior) => e.kind === "fault" && e.level === "ok" && has(e, "is up:") && prior.kill && e.t > prior.kill.t,
  },
  {
    id: "hints",
    title: "Hints replayed",
    hint: "Write while it is down, then restart",
    icon: "Refresh",
    match: (e) => e.kind === "hint" && e.level === "ok" && has(e, "delivered"),
  },
];

export function demoProgress(events, since = 0, state = {}) {
  const done = {};
  for (const e of events) {
    if (e.t < since) continue;
    for (const step of DEMO_STEPS) {
      if (!done[step.id] && step.match(e, done)) done[step.id] = e;
    }
  }
  for (const step of DEMO_STEPS) {
    const live = !done[step.id] && step.live?.(state);
    if (live) done[step.id] = { live };
  }
  return DEMO_STEPS.map((s) => ({ ...s, event: done[s.id] || null }));
}

/**
 * Membership observations arrive once per observer ("node3 suspect" from
 * four nodes). Fold identical observations within a few seconds into one
 * line with the list of observers.
 */
export function groupEvents(events, windowMs = 6000) {
  const out = [];
  const open = new Map();
  for (const e of events) {
    const subject = e.fields?.subject;
    const change = e.fields?.change;
    if (e.kind === "membership" && subject && change && subject !== "ring") {
      const key = `${subject}:${change}`;
      const g = open.get(key);
      if (g && e.t - g.t <= windowMs) {
        if (!g.observers.includes(e.node)) g.observers.push(e.node);
        g.last = e.t;
        continue;
      }
      const item = { ...e, observers: [e.node], subject, change };
      open.set(key, item);
      out.push(item);
      continue;
    }
    out.push({ ...e, observers: [e.node] });
  }
  return out;
}

const CHANGE_TITLES = {
  joined: "joined",
  alive: "is back",
  suspect: "suspect",
  dead: "declared dead",
  reaped: "left the ring",
};

/** Short title + detail for a timeline chip. */
export function chipLabel(e) {
  if (e.kind === "membership" && e.subject) {
    return { title: `${e.subject} ${CHANGE_TITLES[e.change] || e.change}`, detail: `seen by ${e.observers.join(", ")}` };
  }
  switch (e.kind) {
    case "repair":
      return { title: e.level === "error" ? "Data loss" : e.level === "warn" ? "Read-repair" : "Repaired", detail: e.key || e.message };
    case "hint":
      return { title: e.level === "ok" ? "Hint replayed" : "Hint parked", detail: e.key || e.message };
    case "fault":
      if (e.message.includes("flipped a byte")) return { title: "Byte flipped", detail: `${e.key} on ${e.node}` };
      if (e.message.includes("stopped")) return { title: `${e.node} stopped`, detail: "gossip + RPC off" };
      if (e.message.includes("is up")) return { title: `${e.node} started`, detail: "rejoining" };
      if (e.message.includes("partition") || e.message.includes("cut")) return { title: "Partition", detail: e.message };
      return { title: "Fault", detail: e.message };
    case "scrub":
      return { title: e.level === "ok" ? "Scrub pass" : "Checksum mismatch", detail: e.key || e.message };
    case "rebalance":
      return { title: "Rebalance", detail: e.key || e.message };
    case "config":
      return { title: "Policy changed", detail: e.message };
    case "read":
      return { title: "Degraded read", detail: e.key };
    case "write":
      return { title: e.level === "error" ? "Write failed" : "Write", detail: e.key };
    default:
      return { title: e.kind, detail: e.message };
  }
}

/** Which node column an event belongs to on the activity timeline. */
export function eventColumn(e) {
  if (e.kind === "membership" && e.subject && e.subject !== "ring") return e.subject;
  if (e.fields?.target) return e.fields.target;
  return e.node;
}

/** Events worth a chip on the overview timeline (not every write). */
export function notable(e) {
  if (e.fields?.change === "boot") return false;
  if (e.kind === "write") return e.level === "error";
  if (e.kind === "membership") return !!e.subject && e.subject !== "ring";
  if (e.kind === "scrub") return e.level !== "ok";
  return true;
}
