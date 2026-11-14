import { describe, expect, test } from "bun:test";
import { createRenderCache, createTagVersions } from "@bulletin/cache";
import { bumpFlagTag } from "@bulletin/db/flags";
import {
  baseSeedModule,
  flagsSeedModule,
  forumExtrasSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import { CODE_FLAG_DEFINITIONS, feedsFlag } from "@bulletin/flags";
import { createServerT } from "@bulletin/i18n";
import { assertCacheVariants } from "@bulletin/test-utils/cache-variants";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { renderHomeRoute } from "../../apps/user-app/src/home/route.ts";
import { feedsFlagRoute } from "../../apps/user-app/src/seo/guard.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "seo_flags" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        flagsSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        forumExtrasSeedModule,
        membersSeedModule,
        themesSeedModule,
      ]),
    });
    await run(database);
  });
}

async function setFeedsFlag(database: TestDatabase, enabled: boolean): Promise<void> {
  await database.sql`
    UPDATE core.feature_flags
    SET default_value = ${enabled}, updated_at = now()
    WHERE key = 'feeds'
  `;
  await bumpFlagTag(database.sql);
}

integrationDescribe("feeds feature flag", () => {
  test("is declared off in code and turned on by the seed", async () => {
    expect(feedsFlag).toMatchObject({
      key: "feeds",
      defaultValue: false,
      affectsRender: true,
      clientVisible: true,
    });
    expect(CODE_FLAG_DEFINITIONS).toContain(feedsFlag);

    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "seo_flags_seed" }, async ({ sql }) => {
      await runSeeds({
        sql,
        registry: new SeedRegistry([baseSeedModule, flagsSeedModule]),
      });
      const [row] = (await sql`
        SELECT default_value, affects_render
        FROM core.feature_flags
        WHERE key = 'feeds'
      `) as Array<{ default_value: boolean; affects_render: boolean }>;

      expect(row).toEqual({ default_value: true, affects_render: true });
    });
  });

  test("the feed route guard answers 404 while the flag is off", async () => {
    await withSeededDb(async (database) => {
      let called = 0;
      const request = new Request("http://board.test/feed.xml");

      await setFeedsFlag(database, false);
      const denied = await feedsFlagRoute(database.sql, request, () => {
        called += 1;
        return new Response("feed");
      });

      expect(denied.status).toBe(404);
      expect(called).toBe(0);

      await setFeedsFlag(database, true);
      const allowed = await feedsFlagRoute(database.sql, request, () => {
        called += 1;
        return new Response("feed");
      });

      expect(allowed.status).toBe(200);
      expect(called).toBe(1);
    });
  });

  test("the cached footer varies with the feeds flag and hides its links when off", async () => {
    await withSeededDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const render = () =>
          renderHomeRoute({
            sql: database.sql,
            locale: "en",
            translate,
            session: null,
            pluginsGeneration: 1,
            colourScheme: "system",
            cache,
            tagVersions: versions,
          });

        await setFeedsFlag(database, false);
        const off = await render();
        await setFeedsFlag(database, true);
        const on = await render();

        expect(off.html).not.toContain("data-feed-links");
        expect(on.html).toContain("data-feed-links");
        expect(on.html).toContain('href="/feed.xml"');
        expect(on.html).toContain('href="/feed.atom"');

        const report = await assertCacheVariants({
          route: "/",
          cache,
          cases: [
            {
              name: "off",
              setup: () => setFeedsFlag(database, false),
              async render() {
                const result = await render();

                return {
                  variant: result.variant,
                  html: result.html,
                  ...(result.cache === null ? {} : { cache: result.cache }),
                };
              },
            },
            {
              name: "on",
              setup: () => setFeedsFlag(database, true),
              async render() {
                const result = await render();

                return {
                  variant: result.variant,
                  html: result.html,
                  ...(result.cache === null ? {} : { cache: result.cache }),
                };
              },
            },
          ],
          leaks: [{ markers: ["data-feed-links"], absentFrom: ["off"] }],
        });

        expect(report.variants.get("off")).not.toBe(report.variants.get("on"));
      } finally {
        await versions.close();
      }
    });
  });
});
