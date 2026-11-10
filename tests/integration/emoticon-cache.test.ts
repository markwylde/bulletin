import { describe, expect, test } from "bun:test";
import {
  createRenderCache,
  createTagVersions,
  GLOBAL_CACHE_TAGS,
  readTagVersion,
} from "@bulletin/cache";
import {
  baseSeedModule,
  flagsSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import { createServerT } from "@bulletin/i18n";
import type { StorageClient } from "@bulletin/storage";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { mutateEmoticon } from "../../apps/staff-api/src/emoticons.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { renderDemoRoute } from "../../apps/user-app/src/demo/route.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

/** Set saves never touch storage; the paths that do are covered by the emoticon image tests. */
const STORAGE: StorageClient = {
  async put() {
    return 0;
  },
  async get() {
    return new Uint8Array();
  },
  async delete() {},
  presignGet() {
    return "";
  },
  presignPut() {
    return "";
  },
};

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "emoticon_cache" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        membersSeedModule,
        flagsSeedModule,
        themesSeedModule,
      ]),
    });
    await run(database);
  });
}

async function actorId(database: TestDatabase): Promise<string> {
  const [row] = (await database.sql`
    SELECT member_id::text AS member_id FROM pii.identities WHERE sub = 'admin'
  `) as Array<{ member_id: string }>;

  if (row === undefined) {
    throw new Error("Missing seeded admin");
  }

  return row.member_id;
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

integrationDescribe("emoticon cache invalidation", () => {
  test("a change rebuilds a warmed editor page but leaves other pages cached", async () => {
    await withSeededDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const render = (forumId: string) =>
          renderDemoRoute({
            sql: database.sql,
            locale: "en",
            translate,
            session: null,
            forumId,
            showDeleted: false,
            pluginsGeneration: 1,
            colourScheme: "system",
            cache,
            tagVersions: versions,
          });

        const editorFirst = await render("editor");
        const editorWarm = await render("editor");
        const forumFirst = await render("2");
        const forumWarm = await render("2");

        expect(editorFirst.cache).toBe("miss");
        expect(editorFirst.tags).toContain(GLOBAL_CACHE_TAGS.emoticons);
        expect(editorWarm.cache).toBe("hit");
        expect(forumFirst.cache).toBe("miss");
        expect(forumFirst.tags).not.toContain(GLOBAL_CACHE_TAGS.emoticons);
        expect(forumWarm.cache).toBe("hit");

        const admin = await actorId(database);
        const saved = await mutateEmoticon(database.sql, STORAGE, admin, {
          action: "set-save",
          set: { key: "waves", title: "Waves", position: 0, editorVisible: true },
        });
        expect(saved.ok).toBe(true);

        await waitFor(() => versions.version(GLOBAL_CACHE_TAGS.emoticons) === "1");
        expect(await readTagVersion(database.sql, GLOBAL_CACHE_TAGS.emoticons)).toBe("1");

        expect((await render("editor")).cache).toBe("miss");
        expect((await render("2")).cache).toBe("hit");
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("a failed emoticon mutation does not bump the tag", async () => {
    await withSeededDb(async (database) => {
      const admin = await actorId(database);

      const result = await mutateEmoticon(database.sql, STORAGE, admin, {
        action: "set-save",
        set: { key: "NOT A KEY", title: "", position: 0 },
      });

      expect(result.ok).toBe(false);
      expect(await readTagVersion(database.sql, GLOBAL_CACHE_TAGS.emoticons)).toBe("0");
    });
  }, 30_000);
});
