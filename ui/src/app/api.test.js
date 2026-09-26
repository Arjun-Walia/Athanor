import { describe, expect, it } from "vitest";
import { isLoopback, keyPath, trimBase } from "./api.js";

describe("api helpers", () => {
  it("normalises bases and recognises loopback origins", () => {
    expect(trimBase("http://localhost:8081///")).toBe("http://localhost:8081");
    expect(trimBase(undefined)).toBe("");
    expect(isLoopback("http://localhost:8081")).toBe(true);
    expect(isLoopback("http://127.0.0.1:8082")).toBe(true);
    expect(isLoopback("http://app.localhost:3000")).toBe(true);
    expect(isLoopback("https://www.athanor.cfd")).toBe(false);
    expect(isLoopback("not a url")).toBe(false);
  });

  it("encodes each key segment but keeps the slashes", () => {
    expect(keyPath("reports/q3 final.pdf")).toBe("reports/q3%20final.pdf");
    expect(keyPath("a/b#c")).toBe("a/b%23c");
  });
});
