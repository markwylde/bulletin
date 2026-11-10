import { describe, expect, test } from "bun:test";
import {
  bumpCacheTags,
  createRenderCache,
  createTagVersions,
  forumTag,
  GLOBAL_CACHE_TAGS,
} from "@bulletin/cache";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "cache_listener" }, run);
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (await check()) {
      return;
    }

    await Bun.sleep(20);
  }

  throw new Error("Timed out waiting for the cache listener");
}

/** Terminates the LISTEN connection that carries the process's unique health channel. */
async function killListener(database: TestDatabase, healthChannel: string): Promise<boolean> {
  const rows = (await database.sql`
    SELECT pg_terminate_backend(pid) AS killed
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
      AND query LIKE ${`%${healthChannel}%`}
  `) as Array<{ killed: boolean }>;

  return rows.some((row) => row.killed === true);
}

integrationDescribe("cache tag listener", () => {
  test("loads tag versions after LISTEN and refreshes on NOTIFY", async () => {
    await withDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        expect(versions.isTrusted()).toBe(true);
        expect(versions.version(forumTag("1"))).toBe("0");

        await bumpCacheTags(database.sql, [forumTag("1")]);

        await waitFor(() => versions.version(forumTag("1")) === "1");
      } finally {
        await versions.close();
      }
    });
  });

  test("marks the listener untrusted on a drop and bypasses the render cache", async () => {
    await withDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        let renders = 0;
        const request = {
          key: "variant-a",
          tags: [forumTag("2")],
          render: () => {
            renders += 1;
            return `render ${renders}`;
          },
        };

        expect((await cache.getOrRender(request)).status).toBe("miss");
        expect((await cache.getOrRender(request)).status).toBe("hit");

        versions.markDown();

        expect(versions.isTrusted()).toBe(false);
        expect((await cache.getOrRender(request)).status).toBe("bypass");
        expect(await cache.getOrRender(request)).toMatchObject({ status: "bypass" });

        // A reconnect reloads versions and makes the cache usable again. The entry that was
        // stored before the drop is still valid, so it serves as a hit until its tag moves.
        await versions.refresh();

        expect(versions.isTrusted()).toBe(true);
        expect((await cache.getOrRender(request)).status).toBe("hit");

        await bumpCacheTags(database.sql, [forumTag("2")]);
        await waitFor(() => versions.version(forumTag("2")) === "1");
        expect((await cache.getOrRender(request)).status).toBe("miss");
        expect((await cache.getOrRender(request)).status).toBe("hit");
      } finally {
        await versions.close();
      }
    });
  });

  test("fails closed when the LISTEN connection is killed and reloads after reconnect", async () => {
    await withDb(async (database) => {
      const healthChannel = `bulletin_cache_health_${crypto.randomUUID().slice(0, 8)}`;
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 20,
        heartbeatTimeoutMs: 60,
        healthChannel,
      });

      try {
        expect(versions.isConnected()).toBe(true);
        await bumpCacheTags(database.sql, ["topic:1"]);
        await waitFor(() => versions.version("topic:1") === "1");

        const killed = await killListener(database, healthChannel);

        expect(killed).toBe(true);

        // The heartbeat stops arriving, so the store must stop trusting its versions.
        await waitFor(() => !versions.isTrusted(), 2_000);

        // A write whose NOTIFY is lost while the connection is down: only the reconnect's
        // LISTEN-then-load can bring the new version in.
        await database.sql`
          UPDATE core.cache_tags SET version = version + 1 WHERE tag = 'topic:1'
        `;

        await waitFor(() => versions.isTrusted() && versions.version("topic:1") === "2", 15_000);
      } finally {
        await versions.close();
      }
    });
  });

  test("re-reads perm every second even without a NOTIFY", async () => {
    await withDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
        permBackstopMs: 50,
      });

      try {
        expect(versions.version(GLOBAL_CACHE_TAGS.perm)).toBe("0");

        // A permission write whose NOTIFY was lost: only the backstop can see it.
        await database.sql`
          INSERT INTO core.cache_tags (tag, version)
          VALUES (${GLOBAL_CACHE_TAGS.perm}, 7)
          ON CONFLICT (tag) DO UPDATE SET version = 7
        `;
        await Bun.sleep(80);

        await versions.ensurePermFresh();

        expect(versions.version(GLOBAL_CACHE_TAGS.perm)).toBe("7");
      } finally {
        await versions.close();
      }
    });
  });

  test("closing the store unlistens and marks it untrusted", async () => {
    await withDb(async (database) => {
      const versions = await createTagVersions({ sql: database.sql });

      expect(versions.isTrusted()).toBe(true);
      await versions.close();

      expect(versions.isTrusted()).toBe(false);
      expect(versions.isConnected()).toBe(false);
    });
  });
});
