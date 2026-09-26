import { describe, expect, it } from "vitest";
import { chipLabel, demoProgress, eventColumn, groupEvents, notable } from "./story.js";

const ev = (over) => ({ seq: 1, node: "node1", kind: "write", level: "ok", key: "k", message: "", fields: {}, t: 1000, ...over });

describe("demo checklist", () => {
  it("ticks steps off from real events, in order", () => {
    const events = [
      ev({ kind: "membership", message: "node1 settled on ring v6 with 5 members [node1 node2 node3 node4 node5]", t: 1 }),
      ev({ kind: "write", fields: { op: "put" }, t: 2 }),
      ev({ kind: "fault", message: "node2 stopped: gossip and peer RPC are off, data stays on disk", t: 3 }),
      ev({ kind: "fault", level: "ok", message: "node2 is up: gossip x, peer RPC y", t: 4 }),
    ];
    const steps = demoProgress(events);
    const done = Object.fromEntries(steps.map((s) => [s.id, Boolean(s.event)]));
    expect(done.alive).toBe(true);
    expect(done.upload).toBe(true);
    expect(done.kill).toBe(true);
    expect(done.restart).toBe(true);
    expect(done.heal).toBe(false);
  });

  it("ignores events before a reset and does not count a restart before a kill", () => {
    const events = [ev({ kind: "fault", level: "ok", message: "node2 is up: gossip x", t: 4 }), ev({ kind: "write", fields: { op: "put" }, t: 5 })];
    const steps = demoProgress(events, 4.5);
    expect(steps.find((s) => s.id === "restart").event).toBeNull();
    expect(steps.find((s) => s.id === "upload").event).not.toBeNull();
  });

  it("reports live state when the log has nothing yet", () => {
    const steps = demoProgress([], 0, { aliveNow: 5 });
    expect(steps.find((s) => s.id === "alive").event.live).toBe("5 alive right now");
  });
});

describe("event grouping", () => {
  it("folds the same membership observation from several nodes into one line", () => {
    const seen = (node, t) => ev({ node, kind: "membership", level: "warn", message: `node3 suspect`, fields: { subject: "node3", change: "suspect" }, t });
    const grouped = groupEvents([seen("node1", 1000), seen("node2", 1500), seen("node4", 2000), ev({ kind: "write", t: 3000 })]);
    expect(grouped).toHaveLength(2);
    expect(grouped[0].observers).toEqual(["node1", "node2", "node4"]);
    expect(chipLabel(grouped[0])).toEqual({ title: "node3 suspect", detail: "seen by node1, node2, node4" });
    expect(eventColumn(grouped[0])).toBe("node3");
  });

  it("keeps observations apart when they are far apart in time", () => {
    const seen = (t) => ev({ kind: "membership", fields: { subject: "node3", change: "dead" }, t });
    expect(groupEvents([seen(0), seen(60_000)])).toHaveLength(2);
  });

  it("labels chips by kind and only surfaces what matters", () => {
    expect(chipLabel(ev({ kind: "repair", level: "error" })).title).toBe("Data loss");
    expect(chipLabel(ev({ kind: "fault", message: "operator flipped a byte in k on node2" })).title).toBe("Byte flipped");
    expect(chipLabel(ev({ kind: "fault", message: "node1 recovered from a panic in /x" })).title).toBe("Recovered");
    expect(notable(ev({ kind: "write", level: "ok" }))).toBe(false);
    expect(notable(ev({ kind: "write", level: "error" }))).toBe(true);
    expect(notable(ev({ kind: "membership", fields: { change: "boot" } }))).toBe(false);
    expect(notable(ev({ kind: "scrub", level: "ok" }))).toBe(false);
    expect(notable(ev({ kind: "scrub", level: "warn" }))).toBe(true);
  });
});
