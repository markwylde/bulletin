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
import {
  firstUnreadForTopics,
  markBoardRead,
  markForumRead,
  reply,
  startTopic,
  unreadForumIds,
  unreadTopicIds,
} from "@bulletin/domain/topics";
import { memberViewerKey, recordVisit } from "@bulletin/domain/visits";
import { createServerT } from "@bulletin/i18n";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { renderForumRoute } from "../../apps/user-app/src/forums/route.ts";
import { renderHomeRoute } from "../../apps/user-app/src/home/route.ts";
import type { UserAppSessionContext } from "../../apps/user-app/src/session.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "read_tracking" }, async (database) => {
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

async function memberSession(database: TestDatabase, sub: string): Promise<UserAppSessionContext> {
  const [row] = (await database.sql`
    SELECT i.member_id::text AS member_id, m.display_name
    FROM pii.identities i JOIN core.members m ON m.id = i.member_id
    WHERE i.sub = ${sub}
  `) as Array<{ member_id: string; display_name: string | null }>;

  if (row === undefined) {
    throw new Error(`Missing member ${sub}`);
  }

  return {
    memberId: row.member_id,
    sessionId: "0",
    reauthAt: new Date().toISOString(),
    locale: "en",
    displayName: row.display_name,
  };
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

async function createQuestionTopic(
  database: TestDatabase,
  authorId: string,
  forumIdValue: string,
  title: string,
  replies = 0,
): Promise<{ topicId: string; postIds: string[] }> {
  const topic = await startTopic(database.sql, {
    actorId: authorId,
    forumId: forumIdValue,
    title,
    bodyMd: "First post.",
  });

  if (!topic.ok) {
    throw new Error(`Could not create topic: ${topic.code}`);
  }

  const postIds = [topic.result.postId];

  for (let index = 0; index < replies; index += 1) {
    const result = await reply(database.sql, {
      actorId: authorId,
      topicId: topic.result.topicId,
      bodyMd: `Reply ${index + 1}.`,
    });

    if (!result.ok) {
      throw new Error(`Could not reply: ${result.code}`);
    }

    postIds.push(result.result.postId);
  }

  return { topicId: topic.result.topicId, postIds };
}

integrationDescribe("read tracking", () => {
  test("unread forums include parents and clear with one forum-read row", async () => {
    await withSeededDb(async (database) => {
      const member = await memberSession(database, "member-2");
      const community = await forumId(database, "community");
      const offTopic = await forumId(database, "off-topic");
      const author = await memberSession(database, "member-1");
      await createQuestionTopic(database, author.memberId, offTopic, "Unread child topic");

      expect(
        await unreadForumIds(database.sql, {
          memberId: member.memberId,
          forumIds: [community, offTopic],
        }),
      ).toEqual(expect.arrayContaining([community, offTopic]));

      expect(await markForumRead(database.sql, member.memberId, community)).toBe(true);
      const rows = (await database.sql`
        SELECT count(*)::int AS count FROM core.forum_reads WHERE member_id = ${member.memberId}
      `) as Array<{ count: number }>;
      expect(rows[0]?.count).toBe(1);
      expect(
        await unreadForumIds(database.sql, {
          memberId: member.memberId,
          forumIds: [community, offTopic],
        }),
      ).toEqual([]);
    });
  }, 30_000);

  test("first unread points at the page after the member's timestamp marker", async () => {
    await withSeededDb(async (database) => {
      const member = await memberSession(database, "member-2");
      const author = await memberSession(database, "member-1");
      const offTopic = await forumId(database, "off-topic");
      const topic = await createQuestionTopic(
        database,
        author.memberId,
        offTopic,
        "Paging topic",
        12,
      );
      const twelfth = topic.postIds[11];
      const thirteenth = topic.postIds[12];

      if (twelfth === undefined || thirteenth === undefined) {
        throw new Error("Missing post");
      }

      const [post] = (await database.sql`
        SELECT created_at FROM core.posts WHERE id = ${twelfth}
      `) as Array<{ created_at: Date }>;

      if (post === undefined) {
        throw new Error("Missing timestamp");
      }

      await recordVisit(database.sql, {
        viewerKey: memberViewerKey(member.memberId),
        ctx: `topic:${topic.topicId}`,
        memberId: member.memberId,
        lastReadAt: post.created_at,
        lastReadPostId: twelfth,
      });

      const first = await firstUnreadForTopics(database.sql, {
        memberId: member.memberId,
        topicIds: [topic.topicId],
        perPage: 5,
      });

      expect(first).toEqual([
        expect.objectContaining({
          topicId: topic.topicId,
          postId: thirteenth,
          page: 3,
        }),
      ]);
    });
  }, 30_000);

  test("moderator first unread follows the visibility ordering that includes deleted posts", async () => {
    await withSeededDb(async (database) => {
      const member = await memberSession(database, "super-mod");
      const author = await memberSession(database, "member-1");
      const offTopic = await forumId(database, "off-topic");
      const topic = await createQuestionTopic(
        database,
        author.memberId,
        offTopic,
        "Moderator paging topic",
        13,
      );
      const markerPost = topic.postIds[5];
      const unreadPost = topic.postIds[6];

      if (markerPost === undefined || unreadPost === undefined) {
        throw new Error("Missing post");
      }

      await database.sql`
        UPDATE core.posts SET visibility = 'soft_deleted'
        WHERE topic_id = ${topic.topicId} AND position BETWEEN 2 AND 5
      `;
      const [post] = (await database.sql`
        SELECT created_at FROM core.posts WHERE id = ${markerPost}
      `) as Array<{ created_at: Date }>;

      if (post === undefined) {
        throw new Error("Missing timestamp");
      }

      await recordVisit(database.sql, {
        viewerKey: memberViewerKey(member.memberId),
        ctx: `topic:${topic.topicId}`,
        memberId: member.memberId,
        lastReadAt: post.created_at,
        lastReadPostId: markerPost,
      });

      const ordinary = await firstUnreadForTopics(database.sql, {
        memberId: member.memberId,
        topicIds: [topic.topicId],
        perPage: 2,
      });
      const moderator = await firstUnreadForTopics(database.sql, {
        memberId: member.memberId,
        topicIds: [topic.topicId],
        perPage: 2,
        seeDeleted: true,
      });

      expect(ordinary).toEqual([
        expect.objectContaining({ topicId: topic.topicId, postId: unreadPost, page: 2 }),
      ]);
      expect(moderator).toEqual([
        expect.objectContaining({ topicId: topic.topicId, postId: unreadPost, page: 4 }),
      ]);
    });
  }, 30_000);

  test("marking the board read clears every forum and topic and sets one member row", async () => {
    await withSeededDb(async (database) => {
      const member = await memberSession(database, "member-2");
      const author = await memberSession(database, "member-1");
      const community = await forumId(database, "community");
      const offTopic = await forumId(database, "off-topic");
      const topic = await createQuestionTopic(
        database,
        author.memberId,
        offTopic,
        "Board mark topic",
      );

      await markBoardRead(database.sql, member.memberId);

      expect(
        await unreadForumIds(database.sql, {
          memberId: member.memberId,
          forumIds: [community, offTopic],
        }),
      ).toEqual([]);
      expect(
        await unreadTopicIds(database.sql, {
          memberId: member.memberId,
          topicIds: [topic.topicId],
        }),
      ).toEqual([]);

      const [row] = (await database.sql`
        SELECT board_marked_at FROM core.members WHERE id = ${member.memberId}
      `) as Array<{ board_marked_at: Date | null }>;
      expect(row?.board_marked_at).toBeInstanceOf(Date);
    });
  }, 30_000);

  test("shared forum and board HTML carries no unread state", async () => {
    await withSeededDb(async (database) => {
      const member = await memberSession(database, "member-2");
      const author = await memberSession(database, "member-1");
      const offTopic = await forumId(database, "off-topic");
      await createQuestionTopic(database, author.memberId, offTopic, "Hidden unread topic");
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const forum = await renderForumRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session: member,
          ref: `${offTopic}-off-topic`,
          pluginsGeneration: 1,
          colourScheme: "system",
          cache,
          tagVersions: versions,
        });
        const home = await renderHomeRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session: member,
          pluginsGeneration: 1,
          colourScheme: "system",
          cache,
          tagVersions: versions,
        });

        expect(forum.kind === "page" ? forum.html : "").not.toContain('data-unread="true"');
        expect(home.html).not.toContain('data-unread="true"');
      } finally {
        await versions.close();
      }
    });
  }, 30_000);
});
