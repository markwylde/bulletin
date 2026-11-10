import { describe, expect, test } from "bun:test";
import { bumpCacheTags, createRenderCache, createTagVersions } from "@bulletin/cache";
import { baseSeedModule, runSeeds, SeedRegistry, themesSeedModule } from "@bulletin/db/seed";
import { createServerT } from "@bulletin/i18n";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { saveBoardSettings } from "../../apps/staff-api/src/board-settings.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { renderHomeRoute } from "../../apps/user-app/src/home/route.ts";
import { isNotModified } from "../../apps/user-app/src/http/cache.ts";

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

async function createAdmin(database: TestDatabase): Promise<string> {
  const [admin] = (await database.sql`
    INSERT INTO core.members (display_name, name_skeleton)
    VALUES ('Board admin', 'board admin')
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (admin === undefined) {
    throw new Error("could not create the acting member");
  }

  return admin.id;
}

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (check()) {
      return;
    }

    await Bun.sleep(20);
  }

  throw new Error("Timed out waiting for the tag listener");
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
        const input = {
          sql: database.sql,
          locale: "en" as const,
          translate: translateEn,
          pluginsGeneration: 1,
          colourScheme: "system" as const,
          cache: createRenderCache({ tags: versions }),
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
        const input = {
          sql: database.sql,
          locale: "en" as const,
          translate: translateEn,
          pluginsGeneration: 1,
          colourScheme: "system" as const,
          cache: createRenderCache({ tags: versions }),
          tagVersions: versions,
        };
        const first = await renderHomeRoute(input);
        const warm = await renderHomeRoute(input);

        expect(first.cache).toBe("miss");
        expect(warm.cache).toBe("hit");
        expect(first.html).toContain("data-board-name>Bulletin<");

        const saved = await saveBoardSettings(database.sql, await createAdmin(database), {
          boardName: "Renamed board",
          boardDescription: "A renamed place",
          defaultLocale: "en",
          offline: false,
          offlineMessage: "",
        });

        expect(saved.ok).toBe(true);
        await versions.refresh();

        const after = await renderHomeRoute(input);

        expect(after.cache).toBe("miss");
        expect(after.html).toContain("data-board-name>Renamed board<");
        expect(after.html).not.toContain("data-board-name>Bulletin<");
        expect(after.etag).not.toBe(first.etag);
      } finally {
        await versions.close();
      }
    });
  });

  test("a save racing the view-model load is retried, never stored stale", async () => {
    await withSeededDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const realCache = createRenderCache({ tags: versions });
        const admin = await createAdmin(database);
        let raced = false;

        // The first prepare reads the old settings; a real save commits (and invalidates)
        // before the cache can store that HTML under the new version.
        const racingCache = {
          ...realCache,
          getOrRender: (request: Parameters<typeof realCache.getOrRender>[0]) =>
            realCache.getOrRender({
              ...request,
              prepare: async () => {
                const prepared = await request.prepare();

                if (!raced) {
                  raced = true;
                  const saved = await saveBoardSettings(database.sql, admin, {
                    boardName: "Raced board",
                    boardDescription: "A raced place",
                    defaultLocale: "en",
                    offline: false,
                    offlineMessage: "",
                  });

                  expect(saved.ok).toBe(true);
                  await waitFor(() => versions.version("board") === "1");
                }

                return prepared;
              },
            }),
        };
        const input = {
          sql: database.sql,
          locale: "en" as const,
          translate: translateEn,
          pluginsGeneration: 1,
          colourScheme: "system" as const,
          tagVersions: versions,
        };

        const racedRender = await renderHomeRoute({ ...input, cache: racingCache });

        expect(racedRender.cache).toBe("miss");
        expect(racedRender.html).toContain("data-board-name>Raced board<");
        expect(racedRender.html).not.toContain("data-board-name>Bulletin<");

        await versions.refresh();

        // The retried render was stored under the post-save version: the next request hits the
        // new content (and not the stale first attempt).
        const stored = await renderHomeRoute({ ...input, cache: realCache });

        expect(stored.cache).toBe("hit");
        expect(stored.html).toContain("data-board-name>Raced board<");
        expect(stored.etag).toBe(racedRender.etag);
      } finally {
        await versions.close();
      }
    });
  });

  test("member and guest share the fragment but never the ETag", async () => {
    await withSeededDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const input = {
          sql: database.sql,
          locale: "en" as const,
          translate: translateEn,
          pluginsGeneration: 1,
          colourScheme: "system" as const,
          cache: createRenderCache({ tags: versions }),
          tagVersions: versions,
        };
        const guest = await renderHomeRoute({
          ...input,
          shell: { visitor: "guest", localeSource: "guest" },
        });
        const member = await renderHomeRoute({
          ...input,
          shell: { visitor: "member", localeSource: "member" },
        });

        expect(guest.cache).toBe("miss");
        // One shared fragment key and HTML for both shells.
        expect(member.variant).toBe(guest.variant);
        expect(member.cache).toBe("hit");
        expect(member.html).toBe(guest.html);
        // The per-response ETags differ, so a guest's cached response cannot satisfy the
        // member's revalidation (the shells differ: data-visitor, overlay).
        expect(member.etag).not.toBe(guest.etag);
        expect(isNotModified(guest.etag, member.etag)).toBe(false);
        expect(isNotModified(member.etag, member.etag)).toBe(true);
      } finally {
        await versions.close();
      }
    });
  });
});
