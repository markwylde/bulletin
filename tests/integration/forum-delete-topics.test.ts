import { describe, expect, test } from "bun:test";
import { createRenderCache, createTagVersions } from "@bulletin/cache";
import {
  baseSeedModule,
  flagsSeedModule,
  forumExtrasSeedModule,
  groupsSeedModule,
  membersSeedModule,
  moderatorAssignmentsSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import { startTopic } from "@bulletin/domain/topics";
import { createServerT } from "@bulletin/i18n";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { deleteForum } from "../../apps/staff-api/src/forums.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { renderMemberCards } from "../../apps/user-app/src/topics/fragments.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "forum_delete" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        flagsSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        forumExtrasSeedModule,
        membersSeedModule,
        moderatorAssignmentsSeedModule,
        themesSeedModule,
      ]),
    });
    await run(database);
  });
}

async function memberId(database: TestDatabase, sub: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT member_id::text AS member_id FROM pii.identities WHERE sub = ${sub}
  `) as Array<{ member_id: string }>;

  if (row === undefined) {
    throw new Error(`Missing member ${sub}`);
  }

  return row.member_id;
}

async function createForum(database: TestDatabase, title: string, slug: string): Promise<string> {
  const [row] = (await database.sql`
    INSERT INTO core.forums (parent_id, type, title, slug)
    VALUES (
      (SELECT id FROM core.forums WHERE slug = 'community'),
      'forum', ${title}, ${slug}
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Could not create ${title}`);
  }

  return row.id;
}

integrationDescribe("forum deletion with topics", () => {
  test("moves topics to the chosen forum and requires the choice when topics exist", async () => {
    await withSeededDb(async (database) => {
      const admin = await memberId(database, "admin");
      const author = await memberId(database, "member-1");
      const source = await createForum(database, "Old Source", "old-source");
      const destination = await createForum(database, "Archive", "archive-topics");

      const topicResult = await startTopic(database.sql, {
        actorId: author,
        forumId: source,
        title: "Topic to move",
        bodyMd: "Body.",
      });

      if (!topicResult.ok) {
        throw new Error("Could not create the topic");
      }

      const [destinationBefore] = (await database.sql`
        SELECT topic_count, post_count FROM core.forums WHERE id = ${destination}
      `) as Array<{ topic_count: number; post_count: number }>;

      const result = await deleteForum(database.sql, admin, {
        id: source,
        topicAction: "move",
        moveToForumId: destination,
      });
      expect(result).toEqual({ ok: true });

      const [moved] = (await database.sql`
        SELECT forum_id::text AS forum_id FROM core.topics WHERE id = ${topicResult.result.topicId}
      `) as Array<{ forum_id: string }>;
      expect(moved?.forum_id).toBe(destination);

      const [destinationAfter] = (await database.sql`
        SELECT topic_count, post_count FROM core.forums WHERE id = ${destination}
      `) as Array<{ topic_count: number; post_count: number }>;
      expect(destinationAfter?.topic_count).toBe((destinationBefore?.topic_count ?? 0) + 1);
      expect(destinationAfter?.post_count).toBe((destinationBefore?.post_count ?? 0) + 1);

      const secondSource = await createForum(database, "Second Source", "second-source");
      const secondTopic = await startTopic(database.sql, {
        actorId: author,
        forumId: secondSource,
        title: "Needs a choice",
        bodyMd: "Body.",
      });
      expect(secondTopic.ok).toBe(true);

      const missingChoice = await deleteForum(database.sql, admin, { id: secondSource });
      expect(missingChoice).toEqual({ ok: false, code: "topic_choice_required" });
    });
  }, 30_000);

  test("invalidates the author cards whose post counts the deletion reduces", async () => {
    await withSeededDb(async (database) => {
      const admin = await memberId(database, "admin");
      const author = await memberId(database, "member-1");
      const source = await createForum(database, "Doomed Forum", "doomed-forum");
      const topicResult = await startTopic(database.sql, {
        actorId: author,
        forumId: source,
        title: "Topic that will vanish",
        bodyMd: "Body.",
      });

      if (!topicResult.ok) {
        throw new Error("Could not create the topic");
      }

      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const renderCard = async (): Promise<string> =>
          (await renderMemberCards(database.sql, cache, [author], "en", translate)).get(author) ??
          "";

        const [before] = (await database.sql`
          SELECT post_count FROM core.members WHERE id = ${author}
        `) as Array<{ post_count: number }>;
        const cardCount = (html: string): number =>
          Number(/bl-author-card__posts">(\d+) posts?/.exec(html)?.[1] ?? -1);
        const warm = await renderCard();
        expect(cardCount(warm)).toBe(before?.post_count ?? -1);

        const result = await deleteForum(database.sql, admin, {
          id: source,
          topicAction: "delete",
        });
        expect(result).toEqual({ ok: true });
        await versions.refresh();

        const [after] = (await database.sql`
          SELECT post_count FROM core.members WHERE id = ${author}
        `) as Array<{ post_count: number }>;
        const rebuilt = await renderCard();

        expect(after?.post_count).toBe((before?.post_count ?? 0) - 1);
        expect(cardCount(rebuilt)).toBe(after?.post_count ?? -1);
        expect(rebuilt).not.toBe(warm);
      } finally {
        await versions.close();
      }
    });
  }, 30_000);
});
