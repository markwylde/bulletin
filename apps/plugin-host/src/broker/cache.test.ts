import { describe, expect, test } from "bun:test";
import { createLogger } from "@bulletin/config";
import { CacheInvalidator } from "./cache.ts";

const logger = createLogger({ service: "cache-test", level: "error", sink: () => {} });

function create(ratePerSecond = 50, coalesceMs = 2) {
  const bumps: string[][] = [];
  const invalidator = new CacheInvalidator({
    bump: async (tags) => {
      bumps.push([...tags]);
    },
    logger,
    ratePerSecond,
    coalesceMs,
  });

  return { invalidator, bumps };
}

describe("plugin cache invalidation", () => {
  test("namespaces plugin tags and bumps them once", async () => {
    const { invalidator, bumps } = create();

    await expect(
      invalidator.invalidate("tips", ["leaderboard", "plugin:tips:top"]),
    ).resolves.toEqual(["plugin:tips:leaderboard", "plugin:tips:top"]);
    expect(bumps).toEqual([["plugin:tips:leaderboard", "plugin:tips:top"]]);
  });

  test("a foreign core tag is confined to the plugin namespace", async () => {
    const { invalidator, bumps } = create();

    await invalidator.invalidate("tips", ["forum:3", "perm"]);
    expect(bumps).toEqual([["plugin:tips:forum:3", "plugin:tips:perm"]]);
    expect(bumps[0]).not.toContain("forum:3");
  });

  test("coalesces repeated tags from a burst into one bump", async () => {
    const { invalidator, bumps } = create();

    await Promise.all([
      invalidator.invalidate("tips", ["leaderboard"]),
      invalidator.invalidate("tips", ["leaderboard", "totals"]),
      invalidator.invalidate("tips", ["totals"]),
    ]);

    expect(bumps).toHaveLength(1);
    expect(bumps[0]?.sort()).toEqual(["plugin:tips:leaderboard", "plugin:tips:totals"]);
  });

  test("rate-limits excess calls by coalescing rather than failing", async () => {
    const { invalidator, bumps } = create(2, 1);
    const calls = [];

    for (let index = 0; index < 10; index += 1) {
      calls.push(invalidator.invalidate("tips", [`tag${String(index)}`]));
    }

    await Promise.all(calls);
    expect(invalidator.coalesced).toBeGreaterThan(0);
    expect(bumps.length).toBeLessThan(10);
    expect(bumps.flat()).toHaveLength(10);
  });

  test("drops invalid and oversized tags without bumping", async () => {
    const { invalidator, bumps } = create();

    await expect(invalidator.invalidate("tips", ["", "  ", "x".repeat(200)])).resolves.toEqual([]);
    expect(bumps).toEqual([]);
  });
});
