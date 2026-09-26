import { describe, expect, it } from "vitest";
import { candidatesFor, dedupe, usableFromHere } from "./candidates.js";
import { DEFAULT_BASE, PUBLIC_BASE } from "./api.js";

describe("connection candidates", () => {
  it("tries the serving node first in production, then the saved choice, then the defaults", () => {
    const list = candidatesFor({ origin: "https://www.athanor.cfd", saved: "http://10.0.0.5:8081" });
    expect(list).toEqual(["https://www.athanor.cfd", "http://10.0.0.5:8081", DEFAULT_BASE]);
  });

  it("falls back to the public cluster in development and on localhost pages", () => {
    expect(candidatesFor({ origin: "http://localhost:5173", dev: true })).toEqual([DEFAULT_BASE, PUBLIC_BASE]);
    expect(candidatesFor({ origin: "http://localhost:8081" })).toEqual(["http://localhost:8081", PUBLIC_BASE]);
  });

  it("puts the desktop app's fallback before the local default", () => {
    const list = candidatesFor({ origin: "http://127.0.0.1:53123", desktopBase: "https://cluster.example" });
    expect(list.indexOf("https://cluster.example")).toBeLessThan(list.indexOf(DEFAULT_BASE));
  });

  it("de-duplicates and trims trailing slashes", () => {
    expect(dedupe(["http://a/", "http://a", "", "http://b//"])).toEqual(["http://a", "http://b"]);
  });
});

describe("usableFromHere", () => {
  it("refuses loopback addresses from a page served on the internet", () => {
    expect(usableFromHere("http://localhost:8082", "https://www.athanor.cfd")).toBe(false);
    expect(usableFromHere("https://www.athanor.cfd", "https://www.athanor.cfd")).toBe(true);
  });

  it("refuses mixed content but allows anything from the desktop shell", () => {
    expect(usableFromHere("http://10.0.0.5:8081", "https://www.athanor.cfd")).toBe(false);
    expect(usableFromHere("http://10.0.0.5:8081", "http://localhost:8081")).toBe(true);
    expect(usableFromHere("http://localhost:8082", "file://")).toBe(true);
    expect(usableFromHere("", "https://x")).toBe(false);
  });
});
