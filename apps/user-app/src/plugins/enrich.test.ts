import { describe, expect, test } from "bun:test";
import { enrichView } from "./enrich.ts";

const BASE = {
  hook: "home.view",
  route: "home",
  view: {},
  viewer: { memberId: null },
  url: "http://plugin-host:3004",
  token: "secret",
};

describe("view-model enrichers", () => {
  test("merges declared fields and dependency tags", async () => {
    let body: unknown;
    const result = await enrichView({
      ...BASE,
      fetch: async (_url, init) => {
        body = JSON.parse(String(init.body));
        return Response.json({
          fields: { tipTotal: 12 },
          tags: ["plugin:tips:leaderboard"],
          failures: [],
        });
      },
    });

    expect(body).toMatchObject({ hook: "home.view", route: "home", viewer: { memberId: null } });
    expect(result).toEqual({
      fields: { tipTotal: 12 },
      tags: ["plugin:tips:leaderboard"],
      failures: [],
    });
  });

  test("returns an empty enrichment when the host is unreachable or denies", async () => {
    await expect(
      enrichView({
        ...BASE,
        fetch: async () => {
          throw new Error("down");
        },
      }),
    ).resolves.toEqual({ fields: {}, tags: [], failures: [] });

    await expect(
      enrichView({ ...BASE, fetch: async () => new Response("no", { status: 500 }) }),
    ).resolves.toEqual({ fields: {}, tags: [], failures: [] });
  });

  test("filters malformed fields and tags from the host response", async () => {
    const result = await enrichView({
      ...BASE,
      fetch: async () => Response.json({ fields: [], tags: [1, "ok"], failures: [2, "slow"] }),
    });

    expect(result).toEqual({ fields: {}, tags: ["ok"], failures: ["slow"] });
  });
});
