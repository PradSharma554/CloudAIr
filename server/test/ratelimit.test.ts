import { describe, expect, it } from "vitest";
import { DEFAULT_BURST, DEFAULT_RPM, MemoryLimiter, RuleSource } from "../src/ratelimit.js";

describe("MemoryLimiter", () => {
  it("allows a burst then blocks with a retry-after", () => {
    const l = new MemoryLimiter();
    let allowed = 0;
    for (let i = 0; i < 20; i++) {
      if (l.allow("site|GPTBot", 60, 5).ok) allowed++;
    }
    expect(allowed).toBeGreaterThanOrEqual(5);
    expect(allowed).toBeLessThanOrEqual(7);
    const blocked = l.allow("site|GPTBot", 60, 5);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    // A different key has its own bucket.
    expect(l.allow("site|ClaudeBot", 60, 5).ok).toBe(true);
  });

  it("applies rule changes to existing buckets", () => {
    const l = new MemoryLimiter();
    // Bucket created at generous defaults…
    expect(l.allow("s|GPTBot", 60, 10).ok).toBe(true);
    // …then the site owner tightens the rule; the existing bucket must obey.
    let allowed = 0;
    for (let i = 0; i < 10; i++) {
      if (l.allow("s|GPTBot", 2, 2).ok) allowed++;
    }
    expect(allowed).toBeLessThanOrEqual(2);
  });
});

describe("RuleSource", () => {
  it("applies precedence: agent → class → wildcard → default", async () => {
    const rules = new Map<string, [number, number]>([
      ["agent:GPTBot", [5, 1]],
      ["class:declared-agent", [30, 5]],
      ["site:*", [100, 20]],
    ]);
    const src = new RuleSource(async () => rules);
    expect((await src.resolve("s1", "GPTBot", "declared-agent"))[0]).toBe(5);
    expect((await src.resolve("s1", "ClaudeBot", "declared-agent"))[0]).toBe(30);
    expect((await src.resolve("s1", "", "unknown"))[0]).toBe(100);

    const empty = new RuleSource(async () => new Map());
    expect(await empty.resolve("s1", "", "unknown")).toEqual([DEFAULT_RPM, DEFAULT_BURST]);
  });
});
