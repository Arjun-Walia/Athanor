import { describe, expect, it } from "vitest";
import { failureText, scrubSummary } from "./useActions.js";

describe("action messages", () => {
  it("summarises a scrub across nodes, including dropped hints", () => {
    const text = scrubSummary({
      results: [
        { checked: 3, mismatches: 1, hints_dropped: 0 },
        { checked: 2, mismatches: 0, hints_dropped: 2 },
      ],
    });
    expect(text).toBe("Scrubbed 2 nodes: 5 replicas re-hashed, 1 mismatch, repaired from healthy copies, 2 corrupt hints dropped.");
    expect(scrubSummary({})).toBe("Scrubbed 0 nodes: 0 replicas re-hashed, 0 mismatches.");
  });

  it("points a 401 at the token field and otherwise repeats the error", () => {
    expect(failureText("Scrub failed", { status: 401, message: "unauthorized" })).toMatch(/admin token/);
    expect(failureText("Scrub failed", { status: 503, message: "quorum" })).toBe("Scrub failed: quorum");
    expect(failureText("Scrub failed", undefined)).toBe("Scrub failed: unknown error");
  });
});
