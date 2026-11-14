import { beforeEach, describe, expect, test } from "bun:test";
import { standardMetrics } from "@bulletin/config/metrics";
import { variantKey } from "./keys.ts";
import { createRenderCache } from "./render-cache.ts";
import { describeCacheKey, resetCacheVariantTracking } from "./render-metrics.ts";

const trusted = { version: () => "1", isTrusted: () => true };
const untrusted = { version: () => "1", isTrusted: () => false };

function key(params: Record<string, string>, visibilityKey: string): string {
  return variantKey({
    route: "/topic/[id]",
    params,
    visibilityKey,
    themeId: 1,
    themeVersion: 1,
    pluginsGeneration: 1,
    locale: "en",
    colourScheme: "light",
    renderFlagsHash: "f",
  });
}

describe("render cache metrics", () => {
  beforeEach(() => {
    resetCacheVariantTracking();
    standardMetrics.cacheRequests.reset();
    standardMetrics.cacheBypassSeconds.reset();
  });

  test("a page key yields its route and a parameter-free signature", () => {
    const one = describeCacheKey(key({ id: "1" }, "guest"));
    const two = describeCacheKey(key({ id: "2" }, "guest"));

    expect(one.route).toBe("/topic/[id]");
    expect(one.signature).toBe(two.signature);
    expect(describeCacheKey("poll:3").route).toBe("fragment");
  });

  test("counts hits, misses and variants per route", async () => {
    const cache = createRenderCache({ tags: trusted });
    const render = (pageKey: string) =>
      cache.getOrRender({
        tags: ["topic:1"],
        prepare: async () => ({ key: pageKey, data: undefined }),
        render: () => "<p>page</p>",
      });

    await render(key({ id: "1" }, "guest"));
    await render(key({ id: "1" }, "guest"));
    await render(key({ id: "2" }, "guest"));
    await render(key({ id: "2" }, "member"));

    expect(standardMetrics.cacheRequests.value({ route: "/topic/[id]", result: "miss" })).toBe(3);
    expect(standardMetrics.cacheRequests.value({ route: "/topic/[id]", result: "hit" })).toBe(1);
    // Two viewer variants (guest, member), however many topics were rendered.
    expect(standardMetrics.cacheVariants.value({ route: "/topic/[id]" })).toBe(2);
  });

  test("bypassed renders add bypass time", async () => {
    const cache = createRenderCache({ tags: untrusted });

    await cache.getOrRender({
      tags: ["topic:1"],
      prepare: async () => ({ key: key({ id: "1" }, "guest"), data: undefined }),
      render: async () => {
        await Bun.sleep(5);
        return "<p>page</p>";
      },
    });

    expect(standardMetrics.cacheRequests.value({ route: "/topic/[id]", result: "bypass" })).toBe(1);
    expect(standardMetrics.cacheBypassSeconds.value({ route: "/topic/[id]" })).toBeGreaterThan(0);
  });
});
