import { describe, expect, it } from "vitest";
import { ago, bytes, mmss, nodeShort, pct, plural, shortSum, shortVersion, versionTime } from "./format.js";

describe("format", () => {
  it("renders byte sizes at a readable precision", () => {
    expect(bytes(0)).toBe("0 B");
    expect(bytes(512)).toBe("512 B");
    expect(bytes(1536)).toBe("1.5 KB");
    expect(bytes(120 * 1024 * 1024)).toBe("120 MB");
  });

  it("describes elapsed time in human steps", () => {
    const now = Date.parse("2026-09-26T10:00:00Z");
    expect(ago("2026-09-26T09:59:58Z", now)).toBe("just now");
    expect(ago("2026-09-26T09:59:20Z", now)).toBe("40s ago");
    expect(ago("2026-09-26T09:45:00Z", now)).toBe("15m ago");
    expect(ago("2026-09-26T06:00:00Z", now)).toBe("4h ago");
    expect(ago("not a date", now)).toBe("never");
  });

  it("formats countdowns and versions", () => {
    expect(mmss(65_000)).toBe("01:05");
    expect(mmss(-5)).toBe("00:00");
    expect(shortVersion("117333817849020416")).toBe("…020416");
    expect(shortVersion("")).toBe("—");
    // The high 48 bits of a version are milliseconds since the epoch.
    const v = (BigInt(Date.parse("2026-09-26T10:00:00Z")) << 16n) + 7n;
    expect(versionTime(v.toString()).toISOString()).toBe("2026-09-26T10:00:00.000Z");
    expect(versionTime("junk")).toBeNull();
  });

  it("has small helpers with sane edges", () => {
    expect(shortSum("ba10a8f759ee6e5c")).toBe("ba10a8f7…");
    expect(shortSum("")).toBe("—");
    expect(pct(0.5)).toBe("50%");
    expect(pct(NaN)).toBe("—");
    expect(plural(1, "object")).toBe("1 object");
    expect(plural(2, "copy", "copies")).toBe("2 copies");
    expect(nodeShort("node12")).toBe("n12");
    expect(nodeShort("gateway")).toBe("gateway");
  });
});
