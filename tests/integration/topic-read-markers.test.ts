import { describe, expect, test } from "bun:test";
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
import { reply, startTopic, unreadTopicIds } from "@bulletin/domain/topics";
import { memberViewerKey, recordVisit } from "@bulletin/domain/visits";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "read_markers" }, async (database) => {
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

async function forumId(database: TestDatabase, slug: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT id::text AS id FROM core.forums WHERE slug = ${slug}
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing forum ${slug}`);
  }

  return row.id;
}

integrationDescribe("timestamp read markers", () => {
  test("unread state follows post timestamps, not positions, across merge and split", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberId(database, "member-1");
      const reader = await memberId(database, "member-2");
      const topicResult = await startTopic(database.sql, {
        actorId: author,
        forumId: offTopic,
        title: "Read marker topic",
        bodyMd: "First post.",
      });

      if (!topicResult.ok) {
        throw new Error("Could not create the topic");
      }

      const posts: Array<{ id: string; createdAt: Date }> = [];
      const [first] = (await database.sql`
        SELECT id::text AS id, created_at FROM core.posts WHERE id = ${topicResult.result.postId}
      `) as Array<{ id: string; created_at: Date }>;

      if (first === undefined) {
        throw new Error("Missing first post");
      }

      posts.push({ id: first.id, createdAt: first.created_at });

      for (const body of ["Second post.", "Third post."]) {
        const replyResult = await reply(database.sql, {
          actorId: author,
          topicId: topicResult.result.topicId,
          bodyMd: body,
        });

        if (!replyResult.ok) {
          throw new Error("Could not reply");
        }

        const [row] = (await database.sql`
          SELECT id::text AS id, created_at FROM core.posts WHERE id = ${replyResult.result.postId}
        `) as Array<{ id: string; created_at: Date }>;

        if (row === undefined) {
          throw new Error("Missing reply");
        }

        posts.push({ id: row.id, createdAt: row.created_at });
      }

      const second = posts[1];
      const third = posts[2];

      if (second === undefined || third === undefined) {
        throw new Error("Missing posts");
      }

      await recordVisit(database.sql, {
        viewerKey: memberViewerKey(reader),
        ctx: `topic:${topicResult.result.topicId}`,
        memberId: reader,
        lastReadAt: second.createdAt,
        lastReadPostId: second.id,
      });

      const [marker] = (await database.sql`
        SELECT last_read_at, last_read_post_id::text AS last_read_post_id
        FROM core.topic_reads WHERE member_id = ${reader} AND topic_id = ${topicResult.result.topicId}
      `) as Array<{ last_read_at: Date; last_read_post_id: string }>;
      expect(marker?.last_read_at.getTime()).toBe(second.createdAt.getTime());
      expect(marker?.last_read_post_id).toBe(second.id);

      expect(
        await unreadTopicIds(database.sql, {
          memberId: reader,
          topicIds: [topicResult.result.topicId],
        }),
      ).toEqual([topicResult.result.topicId]);

      // A split removes posts after the marker: the topic is no longer unread...
      await database.sql`
        UPDATE core.topics SET last_post_at = ${second.createdAt}
        WHERE id = ${topicResult.result.topicId}
      `;
      expect(
        await unreadTopicIds(database.sql, {
          memberId: reader,
          topicIds: [topicResult.result.topicId],
        }),
      ).toEqual([]);

      // ...and a merge adds a newer post. Renumbering positions does not change the marker.
      await database.sql`
        UPDATE core.topics SET last_post_at = ${third.createdAt}
        WHERE id = ${topicResult.result.topicId}
      `;
      await database.sql`
        UPDATE core.posts SET position = position + 10
        WHERE topic_id = ${topicResult.result.topicId}
      `;
      expect(
        await unreadTopicIds(database.sql, {
          memberId: reader,
          topicIds: [topicResult.result.topicId],
        }),
      ).toEqual([topicResult.result.topicId]);

      // An older page cannot move the marker backwards.
      const beforeMarker = (await database.sql`
        SELECT last_read_at FROM core.topic_reads
        WHERE member_id = ${reader} AND topic_id = ${topicResult.result.topicId}
      `) as Array<{ last_read_at: Date }>;
      await recordVisit(database.sql, {
        viewerKey: memberViewerKey(reader),
        ctx: `topic:${topicResult.result.topicId}`,
        memberId: reader,
        lastReadAt: posts[0]?.createdAt,
        lastReadPostId: posts[0]?.id,
      });
      const [after] = (await database.sql`
        SELECT last_read_at, last_read_post_id::text AS last_read_post_id
        FROM core.topic_reads WHERE member_id = ${reader} AND topic_id = ${topicResult.result.topicId}
      `) as Array<{ last_read_at: Date; last_read_post_id: string }>;
      expect(after?.last_read_at.getTime()).toBe(beforeMarker[0]?.last_read_at.getTime());
      expect(after?.last_read_post_id).toBe(second.id);
    });
  }, 30_000);
});
