import { describe, expect, test } from "bun:test";
import { bumpCacheTags, createRenderCache, createTagVersions } from "@bulletin/cache";
import { baseSeedModule, runSeeds, SeedRegistry, themesSeedModule } from "@bulletin/db/seed";
import { createServerT } from "@bulletin/i18n";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { loadBoardSettings, saveBoardSettings } from "../../apps/staff-api/src/board-settings.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { renderHomeRoute } from "../../apps/user-app/src/home/route.ts";
import { loadActiveTheme } from "../../apps/user-app/src/theme/render.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translateEn = createServerT("en", { shipped: USER_CATALOGS });
const translateEs = createServerT("es", { shipped: USER_CATALOGS });

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "home_cache" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([baseSeedModule, themesSeedModule]),
    });
    await run(database);
  });
}

integrationDescribe("home route cache (ADR 0006)", () => {
  test("hits per variant and misses when the board tag is invalidated", async () => {
    await withSeededDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const theme = await loadActiveTheme(database.sql);
        const input = {
          sql: database.sql,
          boardName: "Bulletin",
          boardDescription: "A friendly place",
          locale: "en" as const,
          translate: translateEn,
          pluginsGeneration: 1,
          colourScheme: "system" as const,
          theme,
          cache,
          tagVersions: versions,
        };

        const first = await renderHomeRoute(input);
        const warm = await renderHomeRoute(input);

        expect(first.cache).toBe("miss");
        expect(warm.cache).toBe("hit");
        expect(warm.variant).toBe(first.variant);
        expect(warm.etag).toBe(first.etag);
        expect(first.etag).toBeString();
        expect(first.tags).toEqual(["board"]);
        expect(first.html).toContain("data-theme-header");
        expect(first.html).toContain("data-theme-footer");
        expect(first.html).toContain("data-online");

        // Locale is a variant dimension, so a Spanish guest never sees the English fragment.
        const spanish = await renderHomeRoute({
          ...input,
          locale: "es",
          translate: translateEs,
        });

        expect(spanish.cache).toBe("miss");
        expect(spanish.variant).not.toBe(first.variant);

        // A board settings change bumps `board` and invalidates both fragments.
        await bumpCacheTags(database.sql, ["board"]);
        await versions.refresh();

        const invalidated = await renderHomeRoute(input);

        expect(invalidated.cache).toBe("miss");
        expect(invalidated.variant).toBe(first.variant);
        expect(invalidated.etag).not.toBe(first.etag);
      } finally {
        await versions.close();
      }
    });
  });

  test("a real board settings save invalidates a warmed home page and its ETag", async () => {
    await withSeededDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const theme = await loadActiveTheme(database.sql);
        const base = {
          sql: database.sql,
          boardName: "Bulletin",
          boardDescription: "A friendly place",
          locale: "en" as const,
          translate: translateEn,
          pluginsGeneration: 1,
          colourScheme: "system" as const,
          theme,
          cache,
          tagVersions: versions,
        };
        const first = await renderHomeRoute(base);
        const warm = await renderHomeRoute(base);

        expect(first.cache).toBe("miss");
        expect(warm.cache).toBe("hit");

        const [admin] = (await database.sql`
          INSERT INTO core.members (display_name, name_skeleton)
          VALUES ('Board admin', 'board admin')
          RETURNING id::text AS id
        `) as Array<{ id: string }>;

        if (admin === undefined) {
          throw new Error("could not create the acting member");
        }

        const saved = await saveBoardSettings(database.sql, admin.id, {
          boardName: "Renamed board",
          boardDescription: "A renamed place",
          defaultLocale: "en",
          offline: false,
          offlineMessage: "",
        });

        expect(saved.ok).toBe(true);

        // The save bumped `board` in its own transaction; reload the settings the page gets.
        const settings = await loadBoardSettings(database.sql);
        await versions.refresh();

        const after = await renderHomeRoute({
          ...base,
          boardName: settings.boardName,
          boardDescription: settings.boardDescription,
        });

        expect(after.cache).toBe("miss");
        expect(after.html).toContain("Renamed board");
        expect(after.html).not.toContain("A friendly place");
        expect(after.etag).not.toBe(first.etag);
      } finally {
        await versions.close();
      }
    });
  });
});
