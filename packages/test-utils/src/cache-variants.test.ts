import { describe, expect, test } from "bun:test";
import { createRenderCache, type RenderCache } from "@bulletin/cache";
import { assertCacheVariants, CacheVariantError, type VariantRender } from "./cache-variants.ts";

function routeWithCache(): {
  readonly cache: RenderCache;
  readonly render: (key: string, html: string) => Promise<VariantRender>;
} {
  const cache = createRenderCache({
    tags: { version: () => "1", isTrusted: () => true },
  });

  return {
    cache,
    async render(key, html) {
      const result = await cache.getOrRender({ key, tags: [], render: () => html });
      return { variant: key, html: result.html, cache: result.status };
    },
  };
}

describe("cache variant harness", () => {
  test("passes distinct variants, cache hits and leak checks", async () => {
    const route = routeWithCache();
    const report = await assertCacheVariants({
      route: "/demo",
      cache: route.cache,
      cases: [
        {
          name: "guest",
          render: () => route.render("variant-guest", "<p>guest</p>"),
        },
        {
          name: "member",
          render: () => route.render("variant-member", "<p>member</p>"),
        },
      ],
      leaks: [{ markers: ["member"], absentFrom: ["guest"] }],
    });

    expect(report.variants).toEqual(
      new Map([
        ["guest", "variant-guest"],
        ["member", "variant-member"],
      ]),
    );
  });

  test("rejects two cases that share a variant key", async () => {
    const route = routeWithCache();

    await expect(
      assertCacheVariants({
        route: "/demo",
        cache: route.cache,
        cases: [
          { name: "a", render: () => route.render("same", "<p>a</p>") },
          { name: "b", render: () => route.render("same", "<p>b</p>") },
        ],
      }),
    ).rejects.toThrow("cases share a variant key");
  });

  test("rejects content leaking into a less privileged variant", async () => {
    const route = routeWithCache();

    await expect(
      assertCacheVariants({
        route: "/demo",
        cache: route.cache,
        cases: [
          { name: "moderator", render: () => route.render("mod", "<p>mod tools</p>") },
          { name: "member", render: () => route.render("member", "<p>mod tools</p>") },
        ],
        leaks: [{ markers: ["mod tools"], absentFrom: ["member"] }],
      }),
    ).rejects.toThrow('"mod tools" leaked into member');
  });

  test("rejects a leak that names an unknown case", async () => {
    const route = routeWithCache();

    await expect(
      assertCacheVariants({
        route: "/demo",
        cache: route.cache,
        cases: [{ name: "member", render: () => route.render("member", "<p>x</p>") }],
        leaks: [{ markers: ["x"], absentFrom: ["ghost"] }],
      }),
    ).rejects.toThrow('unknown case "ghost"');
  });

  test("rejects a second render that is not a cache hit", async () => {
    const route = routeWithCache();

    await expect(
      assertCacheVariants({
        route: "/demo",
        cache: route.cache,
        cases: [
          {
            name: "always-miss",
            render: async () => ({ variant: "x", html: "<p>x</p>", cache: "miss" }),
          },
        ],
      }),
    ).rejects.toThrow("expected a hit");
  });

  test("runs setup and teardown around each case", async () => {
    const route = routeWithCache();
    const steps: string[] = [];

    await assertCacheVariants({
      route: "/demo",
      cache: route.cache,
      cases: [
        {
          name: "case",
          setup: async () => {
            steps.push("setup");
          },
          teardown: async () => {
            steps.push("teardown");
          },
          render: () => route.render("variant", "<p>case</p>"),
        },
      ],
    });

    expect(steps).toEqual(["setup", "teardown"]);
  });

  test("fails when a case list is empty", async () => {
    await expect(assertCacheVariants({ route: "/demo", cases: [] })).rejects.toBeInstanceOf(
      CacheVariantError,
    );
  });
});
