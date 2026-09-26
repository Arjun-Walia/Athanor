import { describe, expect, it } from "vitest";
import { INITIAL, reduce } from "./Breaker.jsx";

// The browser model follows the engine's rules: three owners, a hint for a
// dead owner, checksum repair from a healthy copy, hint replay on return.
const run = (...actions) => actions.reduce((s, type) => reduce(s, { type }), INITIAL);

describe("break-it model", () => {
  it("starts with three verified copies", () => {
    expect(INITIAL.nodes.filter((n) => n.copy === "ok")).toHaveLength(3);
  });

  it("parks a hint on node4 when node2 is dead and the client writes", () => {
    const s = run("kill", "write");
    expect(s.nodes[1].alive).toBe(false);
    expect(s.nodes[3].copy).toBe("hint");
    expect(s.hint).toBe(true);
    expect(s.log.at(-1).level).toBe("warn");
  });

  it("does not park a hint while every owner is alive", () => {
    expect(run("write").hint).toBe(false);
  });

  it("heals a flipped byte on read and on scrub", () => {
    expect(run("flip", "read").nodes[2].copy).toBe("ok");
    expect(run("flip", "scrub").nodes[2].copy).toBe("ok");
    expect(run("flip", "scrub").log.at(-1).text).toMatch(/healed from node1/);
  });

  it("replays the hint when node2 returns and drops it", () => {
    const s = run("kill", "write", "restart");
    expect(s.nodes[1].alive).toBe(true);
    expect(s.nodes[3].copy).toBeNull();
    expect(s.hint).toBe(false);
    expect(s.log.at(-1).text).toMatch(/hint replay/);
  });

  it("ignores actions that make no sense in the current state", () => {
    expect(run("restart")).toBe(INITIAL);
    expect(run("kill", "kill")).toEqual(run("kill"));
    expect(run("flip", "flip")).toEqual(run("flip"));
  });

  it("keeps the log short", () => {
    const s = run("write", "write", "write", "write", "write", "write", "write");
    expect(s.log.length).toBeLessThanOrEqual(5);
  });

  it("resets", () => {
    expect(run("kill", "flip", "reset")).toBe(INITIAL);
  });
});
