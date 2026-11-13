import { describe, expect, test } from "bun:test";
import { createLogger } from "@bulletin/config";
import { CacheInvalidator, CacheRateLimitError } from "./cache.ts";

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

  test("enforces the sustained invalidation rate", async () => {
    const { invalidator, bumps } = create(2, 1);
    await invalidator.invalidate("tips", ["one"]);
    await invalidator.invalidate("tips", ["two"]);

    await expect(invalidator.invalidate("tips", ["three"])).rejects.toBeInstanceOf(
      CacheRateLimitError,
    );
    expect(bumps).toHaveLength(2);
  });

  test("rejects a failed bump and retries the pending tags next time", async () => {
    let fail = true;
    const bumps: string[][] = [];
    const invalidator = new CacheInvalidator({
      bump: async (tags) => {
        if (fail) {
          throw new Error("database down");
        }

        bumps.push([...tags]);
      },
      logger,
      coalesceMs: 1,
    });

    await expect(invalidator.invalidate("tips", ["leaderboard"])).rejects.toThrow("database down");
    fail = false;
    await invalidator.flush();
    expect(bumps).toEqual([["plugin:tips:leaderboard"]]);
  });

  test("drops invalid and oversized tags without bumping", async () => {
    const { invalidator, bumps } = create();

    await expect(invalidator.invalidate("tips", ["", "  ", "x".repeat(200)])).resolves.toEqual([]);
    expect(bumps).toEqual([]);
  });
});
