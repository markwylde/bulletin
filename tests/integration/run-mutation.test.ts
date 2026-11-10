import { describe, expect, test } from "bun:test";
import {
  bumpCacheTags,
  CACHE_TAG_NOTIFY_CHANNEL,
  createRenderCache,
  createTagVersions,
  forumTag,
  readTagVersion,
  readTagVersions,
  topicPagesTag,
  topicTag,
} from "@bulletin/cache";
import { baseSeedModule, runSeeds, SeedRegistry } from "@bulletin/db/seed";
import { defineMutation, runMutation } from "@bulletin/domain/mutations";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "run_mutation" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([baseSeedModule]),
    });
    await run(database);
  });
}

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (check()) {
      return;
    }

    await Bun.sleep(10);
  }

  throw new Error("Timed out waiting for the test condition");
}

/** A stub for the reply mutation the topics change will add: one write, three tags. */
const stubReply = defineMutation<{ readonly forumId: string; readonly topicId: string }, string>({
  name: "stub.reply",
  tags: (input) => [topicTag(input.topicId), topicPagesTag(input.topicId), forumTag(input.forumId)],
});

integrationDescribe("runMutation", () => {
  test("bumps every declared tag in the write's transaction and wakes listeners", async () => {
    await withDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });
      const notifications: string[] = [];
      const subscription = await database.sql.listen(CACHE_TAG_NOTIFY_CHANNEL, (payload) =>
        notifications.push(payload),
      );

      try {
        const cache = createRenderCache({ tags: versions });
        const topicPage = {
          key: "topic-page",
          tags: [topicTag("5"), topicPagesTag("5")],
          render: () => "<article>topic 5</article>",
        };
        const forumList = {
          key: "forum-list",
          tags: [forumTag("1")],
          render: () => "<ol>forum 1</ol>",
        };
        const otherTopic = {
          key: "other-topic",
          tags: [topicPagesTag("6")],
          render: () => "<article>topic 6</article>",
        };

        // Warm every variant.
        for (const request of [topicPage, forumList, otherTopic]) {
          await cache.getOrRender(request);
        }

        const result = await runMutation({
          sql: database.sql,
          mutation: stubReply,
          input: { forumId: "1", topicId: "5" },
          apply: async (tx, input) => {
            await tx`
              UPDATE core.board_settings
              SET board_description = ${`reply to ${input.topicId} at ${Date.now()}`}
              WHERE id = 1
            `;
            return `reply-${input.topicId}`;
          },
        });

        expect(result).toBe("reply-5");

        // NOTIFY is a wake-up: the listener reloads the versions a moment after commit.
        await waitFor(() => versions.version(topicPagesTag("5")) === "1");

        // The topic page and the forum list miss; an unrelated topic still hits.
        expect((await cache.getOrRender(topicPage)).status).toBe("miss");
        expect((await cache.getOrRender(forumList)).status).toBe("miss");
        expect((await cache.getOrRender(otherTopic)).status).toBe("hit");

        const current = await readTagVersions(database.sql, [
          topicTag("5"),
          topicPagesTag("5"),
          forumTag("1"),
          topicPagesTag("6"),
        ]);

        expect(current.get(topicTag("5"))).toBe("1");
        expect(current.get(topicPagesTag("5"))).toBe("1");
        expect(current.get(forumTag("1"))).toBe("1");
        expect(current.has(topicPagesTag("6"))).toBe(false);

        await waitFor(() => notifications.includes(forumTag("1")));
        expect(notifications).toEqual(
          expect.arrayContaining([topicTag("5"), topicPagesTag("5"), forumTag("1")]),
        );
      } finally {
        await subscription.unlisten();
        await versions.close();
      }
    });
  });

  test("rolls back the writes and the bumps together", async () => {
    await withDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });
      const cache = createRenderCache({ tags: versions });

      try {
        const otherTopic = {
          key: "other-topic",
          tags: [topicPagesTag("6")],
          render: () => "<article>topic 6</article>",
        };

        await cache.getOrRender(otherTopic);

        await expect(
          runMutation({
            sql: database.sql,
            mutation: stubReply,
            input: { forumId: "1", topicId: "6" },
            apply: async () => {
              throw new Error("write failed");
            },
          }),
        ).rejects.toThrow("write failed");

        expect(await readTagVersion(database.sql, topicPagesTag("6"))).toBe("0");
        expect((await cache.getOrRender(otherTopic)).status).toBe("hit");
      } finally {
        await versions.close();
      }
    });
  });

  test("bumps a duplicated tag once", async () => {
    await withDb(async (database) => {
      const mutation = defineMutation<null, null>({
        name: "stub.duplicate",
        tags: () => [forumTag("2"), forumTag("2"), forumTag("2")],
      });

      await runMutation({
        sql: database.sql,
        mutation,
        input: null,
        apply: async (tx) => {
          await tx`UPDATE core.board_settings SET board_name = 'Bulletin' WHERE id = 1`;
          return null;
        },
      });

      expect(await readTagVersion(database.sql, forumTag("2"))).toBe("1");

      await bumpCacheTags(database.sql, [forumTag("2")]);

      expect(await readTagVersion(database.sql, forumTag("2"))).toBe("2");
    });
  });
});
