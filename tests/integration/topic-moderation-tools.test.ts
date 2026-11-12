import { describe, expect, test } from "bun:test";
import { readTagVersion } from "@bulletin/cache";
import {
  baseSeedModule,
  flagsSeedModule,
  groupsSeedModule,
  membersSeedModule,
  moderatorAssignmentsSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
} from "@bulletin/db/seed";
import { readDownloadableAttachment } from "@bulletin/domain/attachments";
import { moderatedForums } from "@bulletin/domain/moderation";
import { listNotifications, unreadNotificationCount } from "@bulletin/domain/notifications";
import { can, loadForumTree, loadPermissionSnapshot } from "@bulletin/domain/permissions";
import { readRecentProfilePosts } from "@bulletin/domain/profiles";
import {
  applyMultimod,
  bulkAction,
  hardDelete,
  listMultimodActions,
  loadQuoteSources,
  mergeTopics,
  move,
  readTopicList,
  reply,
  restore,
  restoreTopic,
  saveMultimodAction,
  softDelete,
  softDeleteTopic,
  splitTopic,
  startTopic,
} from "@bulletin/domain/topics";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { topicSplitResponse } from "../../apps/user-api/src/topic-tools.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "topic_tools" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        flagsSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        membersSeedModule,
        moderatorAssignmentsSeedModule,
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

function expectOk<T>(
  outcome:
    | { readonly ok: true; readonly result: T }
    | { readonly ok: false; readonly code: string },
): T {
  if (!outcome.ok) {
    throw new Error(`Expected success, received ${outcome.code}`);
  }

  return outcome.result;
}

async function visibleCounters(
  database: TestDatabase,
  forum: string,
): Promise<{ readonly topic_count: number; readonly post_count: number }> {
  const [row] = (await database.sql`
    SELECT
      (
        SELECT count(*)::int FROM core.topics
        WHERE forum_id = ${forum} AND visibility = 'visible'
      ) AS topic_count,
      (
        SELECT count(*)::int
        FROM core.posts p JOIN core.topics t ON t.id = p.topic_id
        WHERE t.forum_id = ${forum}
          AND t.visibility = 'visible'
          AND p.visibility = 'visible'
      ) AS post_count
  `) as Array<{ topic_count: number; post_count: number }>;

  return { topic_count: row?.topic_count ?? 0, post_count: row?.post_count ?? 0 };
}

async function storedCounters(
  database: TestDatabase,
  forum: string,
): Promise<{ readonly topic_count: number; readonly post_count: number }> {
  const [row] = (await database.sql`
    SELECT topic_count, post_count FROM core.forums WHERE id = ${forum}
  `) as Array<{ topic_count: number; post_count: number }>;

  return { topic_count: row?.topic_count ?? 0, post_count: row?.post_count ?? 0 };
}

async function memberVisiblePostCount(database: TestDatabase, member: string): Promise<number> {
  const [row] = (await database.sql`
    SELECT count(*)::int AS count
    FROM core.posts p JOIN core.topics t ON t.id = p.topic_id
    WHERE p.author_id = ${member}
      AND t.visibility = 'visible'
      AND p.visibility = 'visible'
  `) as Array<{ count: number }>;

  return row?.count ?? 0;
}

/** Replaces seeded synthetic counters with a fresh count of the forum's visible rows. */
async function syncForumCounters(database: TestDatabase, forum: string): Promise<void> {
  await database.sql`
    UPDATE core.forums f
    SET topic_count = (
          SELECT count(*)::int FROM core.topics t
          WHERE t.forum_id = f.id AND t.visibility = 'visible'
        ),
        post_count = (
          SELECT count(*)::int
          FROM core.posts p JOIN core.topics t ON t.id = p.topic_id
          WHERE t.forum_id = f.id
            AND t.visibility = 'visible'
            AND p.visibility = 'visible'
        )
    WHERE f.id = ${forum}
  `;
}

async function syncMemberPostCounter(database: TestDatabase, member: string): Promise<void> {
  await database.sql`
    UPDATE core.members m
    SET post_count = (
      SELECT count(*)::int
      FROM core.posts p JOIN core.topics t ON t.id = p.topic_id
      WHERE p.author_id = m.id
        AND t.visibility = 'visible'
        AND p.visibility = 'visible'
    )
    WHERE m.id = ${member}
  `;
}

async function topicBodyOrder(database: TestDatabase, topicId: string): Promise<string[]> {
  const rows = (await database.sql`
    SELECT body_text FROM core.posts WHERE topic_id = ${topicId} ORDER BY position
  `) as Array<{ body_text: string }>;

  return rows.map((row) => row.body_text);
}

async function topicPositions(database: TestDatabase, topicId: string): Promise<number[]> {
  const rows = (await database.sql`
    SELECT position FROM core.posts WHERE topic_id = ${topicId} ORDER BY position
  `) as Array<{ position: number }>;

  return rows.map((row) => row.position);
}

integrationDescribe("topic moderation tools", () => {
  test("merges topics in date order, leaves a stub and invalidates both topics", async () => {
    await withSeededDb(async (database) => {
      const forum = await forumId(database, "off-topic");
      const admin = await memberId(database, "admin");
      const memberA = await memberId(database, "member-1");
      const memberB = await memberId(database, "member-2");
      const destination = expectOk(
        await startTopic(database.sql, {
          actorId: memberA,
          forumId: forum,
          title: "Destination topic",
          bodyMd: "Older opening.",
        }),
      );
      const source = expectOk(
        await startTopic(database.sql, {
          actorId: memberB,
          forumId: forum,
          title: "Source topic",
          bodyMd: "Newer opening.",
        }),
      );
      expectOk(
        await reply(database.sql, {
          actorId: memberA,
          topicId: destination.topicId,
          bodyMd: "Destination reply.",
        }),
      );
      expectOk(
        await reply(database.sql, {
          actorId: memberB,
          topicId: source.topicId,
          bodyMd: "Source reply.",
        }),
      );

      await database.sql`
        UPDATE core.posts SET created_at = '2026-01-01T10:00:00Z'
        WHERE id = ${destination.postId}
      `;
      await database.sql`
        UPDATE core.posts SET created_at = '2026-01-01T11:00:00Z'
        WHERE id = ${source.postId}
      `;
      await database.sql`
        UPDATE core.posts SET created_at = now() WHERE body_text = 'Destination reply.'
      `;
      await database.sql`
        UPDATE core.posts SET created_at = now() + interval '1 minute'
        WHERE body_text = 'Source reply.'
      `;

      const topicTagBefore = await readTagVersion(database.sql, `topic:${destination.topicId}`);
      const sourceTagBefore = await readTagVersion(database.sql, `topic:${source.topicId}`);
      const forumTagBefore = await readTagVersion(database.sql, `forum:${forum}`);
      const [forumBefore] = (await database.sql`
        SELECT topic_count, post_count FROM core.forums WHERE id = ${forum}
      `) as Array<{ topic_count: number; post_count: number }>;

      const merged = expectOk(
        await mergeTopics(database.sql, {
          actorId: admin,
          destinationTopicId: destination.topicId,
          sourceTopicIds: [source.topicId],
          title: "Merged discussion",
          stubDays: 7,
        }),
      );
      expect(merged.topicId).toBe(destination.topicId);
      expect(await topicBodyOrder(database, destination.topicId)).toEqual([
        "Older opening.",
        "Newer opening.",
        "Destination reply.",
        "Source reply.",
      ]);
      expect(await readTagVersion(database.sql, `topic:${destination.topicId}`)).not.toBe(
        topicTagBefore,
      );
      expect(await readTagVersion(database.sql, `topic:${source.topicId}`)).not.toBe(
        sourceTagBefore,
      );
      expect(await readTagVersion(database.sql, `forum:${forum}`)).not.toBe(forumTagBefore);

      const [stub] = (await database.sql`
        SELECT moved_to::text AS moved_to, stub_expires_at
        FROM core.topics WHERE id = ${source.topicId}
      `) as Array<{ moved_to: string | null; stub_expires_at: Date | null }>;
      expect(stub?.moved_to).toBe(destination.topicId);
      expect(stub?.stub_expires_at).toBeInstanceOf(Date);

      const [forumAfter] = (await database.sql`
        SELECT topic_count, post_count FROM core.forums WHERE id = ${forum}
      `) as Array<{ topic_count: number; post_count: number }>;
      expect(forumAfter?.topic_count).toBe((forumBefore?.topic_count ?? 0) - 1);
      expect(forumAfter?.post_count).toBe(forumBefore?.post_count);

      const [destinationAfter] = (await database.sql`
        SELECT title, reply_count, first_post_id, last_post_id
        FROM core.topics WHERE id = ${destination.topicId}
      `) as Array<{
        title: string;
        reply_count: number;
        first_post_id: string | null;
        last_post_id: string | null;
      }>;
      expect(destinationAfter?.title).toBe("Merged discussion");
      expect(destinationAfter?.reply_count).toBe(3);
      expect(destinationAfter?.first_post_id).not.toBeNull();
      expect(destinationAfter?.last_post_id).not.toBeNull();

      const secondDestination = expectOk(
        await startTopic(database.sql, {
          actorId: memberA,
          forumId: forum,
          title: "No stub destination",
          bodyMd: "Keeping this topic.",
        }),
      );
      const secondSource = expectOk(
        await startTopic(database.sql, {
          actorId: memberB,
          forumId: forum,
          title: "No stub source",
          bodyMd: "Gone after the merge.",
        }),
      );
      expectOk(
        await mergeTopics(database.sql, {
          actorId: admin,
          destinationTopicId: secondDestination.topicId,
          sourceTopicIds: [secondSource.topicId],
        }),
      );
      expect(
        (await database.sql`SELECT 1 FROM core.topics WHERE id = ${secondSource.topicId}`).length,
      ).toBe(0);
    });
  }, 60_000);

  test("splits selected posts into a new topic and an existing topic", async () => {
    await withSeededDb(async (database) => {
      const forum = await forumId(database, "off-topic");
      const admin = await memberId(database, "admin");
      const member = await memberId(database, "member-1");
      const source = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Split source",
          bodyMd: "Opening.",
        }),
      );
      const replies: string[] = [];

      for (const body of ["First reply.", "Second reply.", "Third reply.", "Fourth reply."]) {
        replies.push(
          expectOk(
            await reply(database.sql, {
              actorId: member,
              topicId: source.topicId,
              bodyMd: body,
            }),
          ).postId,
        );
      }

      const [forumBefore] = (await database.sql`
        SELECT topic_count, post_count FROM core.forums WHERE id = ${forum}
      `) as Array<{ topic_count: number; post_count: number }>;

      expect(
        await splitTopic(database.sql, {
          actorId: member,
          sourceTopicId: source.topicId,
          postIds: [replies[1] ?? ""],
          target: { kind: "new", forumId: forum, title: "Denied split" },
        }),
      ).toEqual({ ok: false, code: "forbidden" });

      const split = expectOk(
        await splitTopic(database.sql, {
          actorId: admin,
          sourceTopicId: source.topicId,
          postIds: [replies[1] ?? "", replies[2] ?? ""],
          target: { kind: "new", forumId: forum, title: "Off-topic split" },
        }),
      );
      expect(split.postIds).toHaveLength(2);
      expect(await topicBodyOrder(database, split.topicId)).toEqual([
        "Second reply.",
        "Third reply.",
      ]);
      expect(await topicBodyOrder(database, source.topicId)).toEqual([
        "Opening.",
        "First reply.",
        "Fourth reply.",
      ]);
      expect(await topicPositions(database, source.topicId)).toEqual([1, 2, 3]);
      expect(await topicPositions(database, split.topicId)).toEqual([1, 2]);

      const [forumAfter] = (await database.sql`
        SELECT topic_count, post_count FROM core.forums WHERE id = ${forum}
      `) as Array<{ topic_count: number; post_count: number }>;
      expect(forumAfter?.topic_count).toBe((forumBefore?.topic_count ?? 0) + 1);
      expect(forumAfter?.post_count).toBe(forumBefore?.post_count);

      const [sourceCounts] = (await database.sql`
        SELECT reply_count FROM core.topics WHERE id = ${source.topicId}
      `) as Array<{ reply_count: number }>;
      expect(sourceCounts?.reply_count).toBe(2);

      const existing = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Existing split target",
          bodyMd: "Existing opening.",
        }),
      );
      expectOk(
        await splitTopic(database.sql, {
          actorId: admin,
          sourceTopicId: source.topicId,
          postIds: [replies[0] ?? ""],
          target: { kind: "existing", topicId: existing.topicId },
        }),
      );
      expect(await topicBodyOrder(database, existing.topicId)).toEqual([
        "Existing opening.",
        "First reply.",
      ]);
      expect(await topicBodyOrder(database, source.topicId)).toEqual(["Opening.", "Fourth reply."]);
      expect(await topicPositions(database, source.topicId)).toEqual([1, 2]);
      expect(await topicPositions(database, existing.topicId)).toEqual([1, 2]);
    });
  }, 60_000);

  test("hidden sources need the restore power to be merged or split", async () => {
    await withSeededDb(async (database) => {
      const forum = await forumId(database, "off-topic");
      const admin = await memberId(database, "admin");
      const withoutRestore = await memberId(database, "member-2");
      const withRestore = await memberId(database, "member-1");

      await database.sql`
        INSERT INTO core.moderators (forum_id, member_id, powers, this_forum_only)
        VALUES (
          ${forum}, ${withoutRestore},
          ${"{merge,split,soft_delete,see_deleted}"}::text[], false
        ), (
          ${forum}, ${withRestore},
          ${"{merge,split,restore,soft_delete,see_deleted}"}::text[], false
        )
      `;

      const destination = expectOk(
        await startTopic(database.sql, {
          actorId: withRestore,
          forumId: forum,
          title: "Hidden merge destination",
          bodyMd: "Destination opening.",
        }),
      );
      const mergeSource = expectOk(
        await startTopic(database.sql, {
          actorId: withRestore,
          forumId: forum,
          title: "Hidden merge source",
          bodyMd: "Deleted merge body.",
        }),
      );
      expectOk(
        await softDeleteTopic(database.sql, { actorId: admin, topicId: mergeSource.topicId }),
      );
      await syncForumCounters(database, forum);
      await syncMemberPostCounter(database, withRestore);
      const memberTagBefore = await readTagVersion(database.sql, `member:${withRestore}`);
      const [mergeBefore] = (await database.sql`
        SELECT topic_count, post_count FROM core.forums WHERE id = ${forum}
      `) as Array<{ topic_count: number; post_count: number }>;
      const mergeMemberBefore = await memberVisiblePostCount(database, withRestore);

      expect(
        await mergeTopics(database.sql, {
          actorId: withoutRestore,
          destinationTopicId: destination.topicId,
          sourceTopicIds: [mergeSource.topicId],
        }),
      ).toEqual({ ok: false, code: "forbidden" });

      const [stillHidden] = (await database.sql`
        SELECT visibility FROM core.topics WHERE id = ${mergeSource.topicId}
      `) as Array<{ visibility: string }>;
      expect(stillHidden?.visibility).toBe("soft_deleted");
      expect(await topicBodyOrder(database, destination.topicId)).toEqual(["Destination opening."]);

      const [mergeDenied] = (await database.sql`
        SELECT topic_count, post_count FROM core.forums WHERE id = ${forum}
      `) as Array<{ topic_count: number; post_count: number }>;
      expect(mergeDenied).toEqual(mergeBefore);

      expectOk(
        await mergeTopics(database.sql, {
          actorId: withRestore,
          destinationTopicId: destination.topicId,
          sourceTopicIds: [mergeSource.topicId],
        }),
      );
      expect(await topicBodyOrder(database, destination.topicId)).toEqual([
        "Destination opening.",
        "Deleted merge body.",
      ]);

      const [mergeAfter] = (await database.sql`
        SELECT topic_count, post_count FROM core.forums WHERE id = ${forum}
      `) as Array<{ topic_count: number; post_count: number }>;
      const [mergeFresh] = (await database.sql`
        SELECT
          (
            SELECT count(*)::int FROM core.topics
            WHERE forum_id = ${forum} AND visibility = 'visible'
          ) AS topic_count,
          (
            SELECT count(*)::int
            FROM core.posts p JOIN core.topics t ON t.id = p.topic_id
            WHERE t.forum_id = ${forum}
              AND t.visibility = 'visible'
              AND p.visibility = 'visible'
          ) AS post_count
      `) as Array<{ topic_count: number; post_count: number }>;

      // The soft-deleted source was never in the forum's counts, so the merge leaves the topic
      // count alone; its post becomes visible through the destination and adds one.
      expect(mergeAfter).toEqual(mergeFresh);
      expect(mergeAfter?.topic_count).toBe(mergeBefore?.topic_count);
      expect(mergeAfter?.post_count).toBe((mergeBefore?.post_count ?? 0) + 1);
      expect(await memberVisiblePostCount(database, withRestore)).toBe(mergeMemberBefore + 1);
      expect(
        (
          await database.sql`
          SELECT post_count FROM core.members WHERE id = ${withRestore}
        `
        )[0],
      ).toMatchObject({ post_count: mergeMemberBefore + 1 });
      expect(await readTagVersion(database.sql, `member:${withRestore}`)).not.toBe(memberTagBefore);

      const splitSource = expectOk(
        await startTopic(database.sql, {
          actorId: withRestore,
          forumId: forum,
          title: "Hidden split source",
          bodyMd: "Split opening.",
        }),
      );
      const splitReplies: string[] = [];

      for (const body of ["Split reply one.", "Split reply two."]) {
        splitReplies.push(
          expectOk(
            await reply(database.sql, {
              actorId: withRestore,
              topicId: splitSource.topicId,
              bodyMd: body,
            }),
          ).postId,
        );
      }

      expectOk(
        await softDeleteTopic(database.sql, { actorId: admin, topicId: splitSource.topicId }),
      );
      await syncForumCounters(database, forum);
      await syncMemberPostCounter(database, withRestore);
      const splitMemberTagBefore = await readTagVersion(database.sql, `member:${withRestore}`);
      const [splitBefore] = (await database.sql`
        SELECT topic_count, post_count FROM core.forums WHERE id = ${forum}
      `) as Array<{ topic_count: number; post_count: number }>;
      const splitMemberBefore = await memberVisiblePostCount(database, withRestore);

      expect(
        await splitTopic(database.sql, {
          actorId: withoutRestore,
          sourceTopicId: splitSource.topicId,
          postIds: splitReplies,
          target: { kind: "new", forumId: forum, title: "Denied restored split" },
        }),
      ).toEqual({ ok: false, code: "forbidden" });

      const [splitDenied] = (await database.sql`
        SELECT topic_count, post_count FROM core.forums WHERE id = ${forum}
      `) as Array<{ topic_count: number; post_count: number }>;
      expect(splitDenied).toEqual(splitBefore);
      expect(await topicBodyOrder(database, splitSource.topicId)).toEqual([
        "Split opening.",
        "Split reply one.",
        "Split reply two.",
      ]);

      const split = expectOk(
        await splitTopic(database.sql, {
          actorId: withRestore,
          sourceTopicId: splitSource.topicId,
          postIds: splitReplies,
          target: { kind: "new", forumId: forum, title: "Restored split" },
        }),
      );
      expect(await topicBodyOrder(database, split.topicId)).toEqual([
        "Split reply one.",
        "Split reply two.",
      ]);
      expect(await topicBodyOrder(database, splitSource.topicId)).toEqual(["Split opening."]);

      const [splitAfter] = (await database.sql`
        SELECT topic_count, post_count FROM core.forums WHERE id = ${forum}
      `) as Array<{ topic_count: number; post_count: number }>;
      expect(splitAfter?.topic_count).toBe((splitBefore?.topic_count ?? 0) + 1);
      expect(splitAfter?.post_count).toBe((splitBefore?.post_count ?? 0) + 2);
      expect(splitAfter?.post_count).toBe((await visibleCounters(database, forum)).post_count);
      expect(await memberVisiblePostCount(database, withRestore)).toBe(splitMemberBefore + 2);
      expect(
        (
          await database.sql`
          SELECT post_count FROM core.members WHERE id = ${withRestore}
        `
        )[0],
      ).toMatchObject({ post_count: splitMemberBefore + 2 });
      expect(await readTagVersion(database.sql, `member:${withRestore}`)).not.toBe(
        splitMemberTagBefore,
      );
    });
  }, 60_000);

  test("delete and restore of held content never publishes without approve", async () => {
    await withSeededDb(async (database) => {
      const forum = await forumId(database, "off-topic");
      const member = await memberId(database, "member-1");
      const heldAuthor = await memberId(database, "new-member");
      const noApprove = await memberId(database, "member-2");

      await database.sql`
        INSERT INTO core.moderators (forum_id, member_id, powers, this_forum_only)
        VALUES (
          ${forum}, ${noApprove},
          ${"{soft_delete,restore,see_deleted}"}::text[], true
        )
      `;
      await database.sql`UPDATE core.members SET post_count = 0 WHERE id = ${heldAuthor}`;
      await database.sql`
        UPDATE core.board_settings SET new_member_approval_posts = 1 WHERE id = 1
      `;

      const heldTopic = expectOk(
        await startTopic(database.sql, {
          actorId: heldAuthor,
          forumId: forum,
          title: "Held delete restore topic",
          bodyMd: "Held delete restore body.",
        }),
      );
      expectOk(
        await reply(database.sql, {
          actorId: member,
          topicId: heldTopic.topicId,
          bodyMd: "Visible reply inside the held topic.",
        }),
      );
      await syncForumCounters(database, forum);
      await syncMemberPostCounter(database, heldAuthor);
      await syncMemberPostCounter(database, member);
      const forumBefore = await storedCounters(database, forum);
      const heldAuthorBefore = await memberVisiblePostCount(database, heldAuthor);

      expectOk(
        await softDeleteTopic(database.sql, { actorId: noApprove, topicId: heldTopic.topicId }),
      );
      expect(await storedCounters(database, forum)).toEqual(forumBefore);
      expect(await memberVisiblePostCount(database, heldAuthor)).toBe(heldAuthorBefore);

      expectOk(
        await restoreTopic(database.sql, { actorId: noApprove, topicId: heldTopic.topicId }),
      );

      const [topicRow] = (await database.sql`
        SELECT visibility FROM core.topics WHERE id = ${heldTopic.topicId}
      `) as Array<{ visibility: string }>;
      expect(topicRow?.visibility).toBe("unapproved");
      expect(await storedCounters(database, forum)).toEqual(forumBefore);
      expect(await memberVisiblePostCount(database, heldAuthor)).toBe(heldAuthorBefore);

      const visibleTopic = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Visible topic with a held reply",
          bodyMd: "Visible opening.",
        }),
      );
      const heldReply = expectOk(
        await reply(database.sql, {
          actorId: heldAuthor,
          topicId: visibleTopic.topicId,
          bodyMd: "Held reply to delete and restore.",
        }),
      );
      await syncForumCounters(database, forum);
      await syncMemberPostCounter(database, heldAuthor);
      const replyForumBefore = await storedCounters(database, forum);
      const replyMemberBefore = await memberVisiblePostCount(database, heldAuthor);

      expectOk(await softDelete(database.sql, { actorId: noApprove, postId: heldReply.postId }));
      expect(await storedCounters(database, forum)).toEqual(replyForumBefore);
      expect(await memberVisiblePostCount(database, heldAuthor)).toBe(replyMemberBefore);

      expectOk(await restore(database.sql, { actorId: noApprove, postId: heldReply.postId }));

      const [replyRow] = (await database.sql`
        SELECT visibility FROM core.posts WHERE id = ${heldReply.postId}
      `) as Array<{ visibility: string }>;
      expect(replyRow?.visibility).toBe("unapproved");
      expect(await storedCounters(database, forum)).toEqual(replyForumBefore);
      expect(await memberVisiblePostCount(database, heldAuthor)).toBe(replyMemberBefore);
    });
  }, 60_000);

  test("publishing held content through merge or split needs approve", async () => {
    await withSeededDb(async (database) => {
      const forum = await forumId(database, "off-topic");
      const admin = await memberId(database, "admin");
      const member = await memberId(database, "member-1");
      const heldAuthor = await memberId(database, "new-member");
      const noApprove = await memberId(database, "member-2");

      await database.sql`
        INSERT INTO core.moderators (forum_id, member_id, powers, this_forum_only)
        VALUES (
          ${forum}, ${noApprove},
          ${"{merge,split,soft_delete,restore,see_deleted}"}::text[], true
        )
      `;
      // Create the destination before approval is switched on so it is a public topic.
      const destination = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Visible merge destination",
          bodyMd: "Destination opening.",
        }),
      );
      await database.sql`UPDATE core.members SET post_count = 0 WHERE id = ${heldAuthor}`;
      await database.sql`
        UPDATE core.board_settings SET new_member_approval_posts = 1 WHERE id = 1
      `;

      const heldSource = expectOk(
        await startTopic(database.sql, {
          actorId: heldAuthor,
          forumId: forum,
          title: "Held merge and split source",
          bodyMd: "Held opening.",
        }),
      );
      const visibleReply = expectOk(
        await reply(database.sql, {
          actorId: member,
          topicId: heldSource.topicId,
          bodyMd: "Visible reply in a hidden topic.",
        }),
      );

      const [visibilityRows] = (await database.sql`
        SELECT
          (SELECT visibility FROM core.topics WHERE id = ${heldSource.topicId}) AS source,
          (SELECT visibility FROM core.topics WHERE id = ${destination.topicId}) AS destination
      `) as Array<{ source: string; destination: string }>;
      expect(visibilityRows).toEqual({ source: "unapproved", destination: "visible" });

      expect(
        await mergeTopics(database.sql, {
          actorId: noApprove,
          destinationTopicId: destination.topicId,
          sourceTopicIds: [heldSource.topicId],
        }),
      ).toEqual({ ok: false, code: "forbidden" });

      expect(
        await splitTopic(database.sql, {
          actorId: noApprove,
          sourceTopicId: heldSource.topicId,
          postIds: [visibleReply.postId],
          target: { kind: "new", forumId: forum, title: "Publishing split" },
        }),
      ).toEqual({ ok: false, code: "forbidden" });

      expect(await topicBodyOrder(database, destination.topicId)).toEqual(["Destination opening."]);
      expect(await topicBodyOrder(database, heldSource.topicId)).toEqual([
        "Held opening.",
        "Visible reply in a hidden topic.",
      ]);

      expectOk(
        await mergeTopics(database.sql, {
          actorId: admin,
          destinationTopicId: destination.topicId,
          sourceTopicIds: [heldSource.topicId],
        }),
      );
      expect(await topicBodyOrder(database, destination.topicId)).toEqual([
        "Destination opening.",
        "Held opening.",
        "Visible reply in a hidden topic.",
      ]);
    });
  }, 60_000);

  test("splitting only held posts creates a held topic without touching counters", async () => {
    await withSeededDb(async (database) => {
      const forum = await forumId(database, "off-topic");
      const admin = await memberId(database, "admin");
      const member = await memberId(database, "member-1");
      const heldAuthor = await memberId(database, "new-member");

      const source = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Visible source with a held reply",
          bodyMd: "Visible source opening.",
        }),
      );
      await database.sql`UPDATE core.members SET post_count = 0 WHERE id = ${heldAuthor}`;
      await database.sql`
        UPDATE core.board_settings SET new_member_approval_posts = 1 WHERE id = 1
      `;
      const heldReply = expectOk(
        await reply(database.sql, {
          actorId: heldAuthor,
          topicId: source.topicId,
          bodyMd: "Held reply to split.",
        }),
      );
      await syncForumCounters(database, forum);
      await syncMemberPostCounter(database, heldAuthor);
      const before = await storedCounters(database, forum);
      const memberBefore = await memberVisiblePostCount(database, heldAuthor);

      const split = expectOk(
        await splitTopic(database.sql, {
          actorId: admin,
          sourceTopicId: source.topicId,
          postIds: [heldReply.postId],
          target: { kind: "new", forumId: forum, title: "Held split topic" },
        }),
      );

      const [target] = (await database.sql`
        SELECT visibility FROM core.topics WHERE id = ${split.topicId}
      `) as Array<{ visibility: string }>;
      expect(target?.visibility).toBe("unapproved");
      expect(await storedCounters(database, forum)).toEqual(before);
      expect(await memberVisiblePostCount(database, heldAuthor)).toBe(memberBefore);
    });
  }, 60_000);

  test("merging a held source does not subtract an uncounted topic", async () => {
    await withSeededDb(async (database) => {
      const forum = await forumId(database, "off-topic");
      const admin = await memberId(database, "admin");
      const member = await memberId(database, "member-1");
      const heldAuthor = await memberId(database, "new-member");

      await database.sql`UPDATE core.members SET post_count = 0 WHERE id = ${heldAuthor}`;
      await database.sql`
        UPDATE core.board_settings SET new_member_approval_posts = 1 WHERE id = 1
      `;

      const destination = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Held merge destination",
          bodyMd: "Destination opening.",
        }),
      );
      const heldSource = expectOk(
        await startTopic(database.sql, {
          actorId: heldAuthor,
          forumId: forum,
          title: "Held merge source",
          bodyMd: "Held merge body.",
        }),
      );
      expect(
        (
          await database.sql`
          SELECT visibility FROM core.topics WHERE id = ${heldSource.topicId}
        `
        )[0],
      ).toMatchObject({ visibility: "unapproved" });
      await syncForumCounters(database, forum);

      const [before] = (await database.sql`
        SELECT topic_count, post_count FROM core.forums WHERE id = ${forum}
      `) as Array<{ topic_count: number; post_count: number }>;

      expectOk(
        await mergeTopics(database.sql, {
          actorId: admin,
          destinationTopicId: destination.topicId,
          sourceTopicIds: [heldSource.topicId],
        }),
      );

      const [after] = (await database.sql`
        SELECT topic_count, post_count FROM core.forums WHERE id = ${forum}
      `) as Array<{ topic_count: number; post_count: number }>;
      const [fresh] = (await database.sql`
        SELECT
          (
            SELECT count(*)::int FROM core.topics
            WHERE forum_id = ${forum} AND visibility = 'visible'
          ) AS topic_count,
          (
            SELECT count(*)::int
            FROM core.posts p JOIN core.topics t ON t.id = p.topic_id
            WHERE t.forum_id = ${forum}
              AND t.visibility = 'visible'
              AND p.visibility = 'visible'
          ) AS post_count
      `) as Array<{ topic_count: number; post_count: number }>;

      expect(after).toEqual(fresh);
      expect(after).toEqual(before);
    });
  }, 60_000);

  test("moving, multi-moving or hard-deleting a hidden topic leaves forum counters alone", async () => {
    await withSeededDb(async (database) => {
      const source = await forumId(database, "off-topic");
      const destination = await forumId(database, "bug-reports");
      const admin = await memberId(database, "admin");
      const author = await memberId(database, "member-1");

      const hiddenTopic = expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: source,
          title: "Hidden move source",
          bodyMd: "Hidden move body.",
        }),
      );
      expectOk(
        await reply(database.sql, {
          actorId: author,
          topicId: hiddenTopic.topicId,
          bodyMd: "Hidden reply.",
        }),
      );
      expectOk(
        await softDeleteTopic(database.sql, { actorId: admin, topicId: hiddenTopic.topicId }),
      );
      await syncForumCounters(database, source);
      await syncForumCounters(database, destination);
      await syncMemberPostCounter(database, author);
      const sourceBefore = await visibleCounters(database, source);
      const destinationBefore = await visibleCounters(database, destination);
      const memberBefore = await memberVisiblePostCount(database, author);

      expectOk(
        await move(database.sql, {
          actorId: admin,
          topicId: hiddenTopic.topicId,
          toForumId: destination,
        }),
      );
      expect(await storedCounters(database, source)).toEqual(sourceBefore);
      expect(await storedCounters(database, destination)).toEqual(destinationBefore);
      expect(await visibleCounters(database, destination)).toEqual(destinationBefore);
      expect(await memberVisiblePostCount(database, author)).toBe(memberBefore);

      expectOk(await hardDelete(database.sql, { actorId: admin, topicId: hiddenTopic.topicId }));
      expect(await storedCounters(database, destination)).toEqual(destinationBefore);
      expect(await visibleCounters(database, destination)).toEqual(destinationBefore);
      expect(await memberVisiblePostCount(database, author)).toBe(memberBefore);

      const multiSource = expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: source,
          title: "Hidden multi-move source",
          bodyMd: "Hidden multi-move body.",
        }),
      );
      expectOk(
        await softDeleteTopic(database.sql, { actorId: admin, topicId: multiSource.topicId }),
      );
      await syncForumCounters(database, source);
      const multiSourceBefore = await visibleCounters(database, source);
      const action = expectOk(
        await saveMultimodAction(database.sql, admin, {
          name: `Hidden move ${Date.now()}`,
          forumIds: [source],
          steps: [{ type: "move", forumId: destination }],
        }),
      );

      expectOk(
        await applyMultimod(database.sql, {
          actorId: admin,
          actionId: action.id,
          topicId: multiSource.topicId,
        }),
      );
      expect(await storedCounters(database, source)).toEqual(multiSourceBefore);
      expect(await storedCounters(database, destination)).toEqual(destinationBefore);
      expect(await memberVisiblePostCount(database, author)).toBe(memberBefore);
    });
  }, 60_000);

  test("bulk locks topics and denies a member without the lock power", async () => {
    await withSeededDb(async (database) => {
      const forum = await forumId(database, "off-topic");
      const admin = await memberId(database, "admin");
      const member = await memberId(database, "member-1");
      const topics: string[] = [];

      for (let index = 0; index < 5; index += 1) {
        topics.push(
          expectOk(
            await startTopic(database.sql, {
              actorId: member,
              forumId: forum,
              title: `Bulk topic ${index}`,
              bodyMd: `Bulk body ${index}.`,
            }),
          ).topicId,
        );
      }

      const postTopic = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Bulk post action topic",
          bodyMd: "Post action opening.",
        }),
      );

      expect(
        await bulkAction(database.sql, {
          actorId: member,
          target: "topics",
          action: "lock",
          ids: topics,
        }),
      ).toEqual({ ok: false, code: "forbidden" });

      const result = expectOk(
        await bulkAction(database.sql, {
          actorId: admin,
          target: "topics",
          action: "lock",
          ids: topics,
        }),
      );
      expect(result.applied).toHaveLength(5);

      const rows = (await database.sql`
        SELECT id::text AS id, locked FROM core.topics
        WHERE id = ANY(${`{${topics.join(",")}}`}::bigint[])
      `) as Array<{ id: string; locked: boolean }>;
      expect(rows).toHaveLength(5);
      expect(rows.every((row) => row.locked)).toBe(true);

      const post = expectOk(
        await reply(database.sql, {
          actorId: member,
          topicId: postTopic.topicId,
          bodyMd: "Bulk post action target.",
        }),
      );
      expectOk(
        await bulkAction(database.sql, {
          actorId: admin,
          target: "posts",
          action: "soft_delete",
          ids: [post.postId],
        }),
      );
      const [deleted] = (await database.sql`
        SELECT visibility FROM core.posts WHERE id = ${post.postId}
      `) as Array<{ visibility: string }>;
      expect(deleted?.visibility).toBe("soft_deleted");

      expectOk(
        await bulkAction(database.sql, {
          actorId: admin,
          target: "posts",
          action: "restore",
          ids: [post.postId],
        }),
      );
      const [restored] = (await database.sql`
        SELECT visibility FROM core.posts WHERE id = ${post.postId}
      `) as Array<{ visibility: string }>;
      expect(restored?.visibility).toBe("visible");
    });
  }, 60_000);

  test("a moderator cannot move a topic into a forum they do not moderate", async () => {
    await withSeededDb(async (database) => {
      const admin = await memberId(database, "admin");
      const forumMod = await memberId(database, "forum-mod");
      const author = await memberId(database, "member-1");
      const tree = await loadForumTree(database.sql);
      const moderated = new Set(
        (await moderatedForums(database.sql, forumMod, null, tree)).map((forum) => forum.id),
      );
      const forums = (await database.sql`
        SELECT id::text AS id FROM core.forums WHERE type = 'forum' ORDER BY id
      `) as Array<{ id: string }>;
      let source: string | null = null;
      let destination: string | null = null;

      for (const forum of forums) {
        if (
          moderated.has(forum.id) &&
          (await can(database.sql, author, "start", { forumId: forum.id, tree }))
        ) {
          source = forum.id;
          break;
        }
      }

      for (const forum of forums) {
        if (
          !moderated.has(forum.id) &&
          (await can(database.sql, author, "start", { forumId: forum.id, tree }))
        ) {
          destination = forum.id;
          break;
        }
      }

      if (source === null || destination === null) {
        throw new Error("Missing a moderated and an unmoderated forum");
      }

      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: source,
          title: "Move permission topic",
          bodyMd: "Move me.",
        }),
      );

      expect(
        await move(database.sql, {
          actorId: forumMod,
          topicId: topic.topicId,
          toForumId: destination,
        }),
      ).toEqual({ ok: false, code: "forbidden" });

      expectOk(
        await move(database.sql, {
          actorId: admin,
          topicId: topic.topicId,
          toForumId: destination,
        }),
      );
      const stubs = (await database.sql`
        SELECT 1 FROM core.topics WHERE forum_id = ${source} AND moved_to = ${topic.topicId}
      `) as unknown[];
      expect(stubs).toHaveLength(0);

      const multimodTopic = expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: source,
          title: "Multimod move permission topic",
          bodyMd: "Move me with multi-moderation.",
        }),
      );
      const action = expectOk(
        await saveMultimodAction(database.sql, admin, {
          name: `Move without destination power ${Date.now()}`,
          forumIds: [source],
          steps: [{ type: "move", forumId: destination }],
        }),
      );
      expect(
        await applyMultimod(database.sql, {
          actorId: forumMod,
          actionId: action.id,
          topicId: multimodTopic.topicId,
        }),
      ).toEqual({ ok: false, code: "forbidden" });
    });
  }, 60_000);

  test("the split endpoint returns 403 for a member without the split power", async () => {
    await withSeededDb(async (database) => {
      const author = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: forum,
          title: "Endpoint split source",
          bodyMd: "Opening.",
        }),
      );
      const replyPost = expectOk(
        await reply(database.sql, {
          actorId: author,
          topicId: topic.topicId,
          bodyMd: "A reply.",
        }),
      );
      const response = await topicSplitResponse(
        database.sql,
        { memberId: author },
        topic.topicId,
        new Request(`http://user.test/api/topics/${topic.topicId}/split`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            postIds: [replyPost.postId],
            target: { kind: "new", forumId: forum, title: "Denied split" },
          }),
        }),
      );
      expect(response.status).toBe(403);
    });
  }, 60_000);

  test("split re-authorizes both forums after a concurrent move of the destination", async () => {
    await withSeededDb(async (database) => {
      const author = await memberId(database, "member-1");
      const moderator = await memberId(database, "forum-mod");
      const tree = await loadForumTree(database.sql);
      const moderated = new Set(
        (await moderatedForums(database.sql, moderator, null, tree)).map((forum) => forum.id),
      );
      const forums = (await database.sql`
        SELECT id::text AS id FROM core.forums WHERE type = 'forum' ORDER BY id
      `) as Array<{ id: string }>;
      let sourceForum: { readonly id: string } | undefined;

      for (const forum of forums) {
        if (
          moderated.has(forum.id) &&
          (await can(database.sql, author, "start", { forumId: forum.id, tree }))
        ) {
          sourceForum = forum;
          break;
        }
      }
      const destinationForum = forums.find((forum) => !moderated.has(forum.id));

      if (sourceForum === undefined || destinationForum === undefined) {
        throw new Error("Missing a moderated and an unmoderated forum");
      }

      const source = expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: sourceForum.id,
          title: "Raced split source",
          bodyMd: "Opening.",
        }),
      );
      const movedPost = expectOk(
        await reply(database.sql, {
          actorId: author,
          topicId: source.topicId,
          bodyMd: "Move this reply.",
        }),
      );
      const target = expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: sourceForum.id,
          title: "Raced split target",
          bodyMd: "Target opening.",
        }),
      );

      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const moving = database.sql.begin(async (tx) => {
        await tx`UPDATE core.topics SET forum_id = ${destinationForum.id} WHERE id = ${target.topicId}`;
        await gate;
      });
      await Bun.sleep(50);
      const splitting = splitTopic(database.sql, {
        actorId: moderator,
        sourceTopicId: source.topicId,
        postIds: [movedPost.postId],
        target: { kind: "existing", topicId: target.topicId },
      });
      await Bun.sleep(100);
      release();
      await moving;

      expect(await splitting).toEqual({ ok: false, code: "forbidden" });
      expect(
        (await database.sql`SELECT topic_id FROM core.posts WHERE id = ${movedPost.postId}`)[0],
      ).toMatchObject({ topic_id: source.topicId });
    });
  }, 60_000);

  test("bulk topic deletion hides every reply and restores the complete topic", async () => {
    await withSeededDb(async (database) => {
      const forum = await forumId(database, "off-topic");
      const admin = await memberId(database, "admin");
      const member = await memberId(database, "member-1");
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Whole topic deletion",
          bodyMd: "Topic opening.",
        }),
      );

      for (const body of ["Reply one.", "Reply two.", "Reply three."]) {
        expectOk(
          await reply(database.sql, {
            actorId: member,
            topicId: topic.topicId,
            bodyMd: body,
          }),
        );
      }

      const [forumBefore] = (await database.sql`
        SELECT topic_count, post_count FROM core.forums WHERE id = ${forum}
      `) as Array<{ topic_count: number; post_count: number }>;
      const [memberBefore] = (await database.sql`
        SELECT post_count FROM core.members WHERE id = ${member}
      `) as Array<{ post_count: number }>;
      const beforeList = await readTopicList(database.sql, {
        forumId: forum,
        locale: "en",
        sort: "last_post",
        prefixId: null,
        page: 1,
        perPage: 100,
        seeUnapproved: false,
        seeDeleted: false,
      });
      expect(beforeList.rows.map((row) => row.id)).toContain(topic.topicId);

      expectOk(
        await bulkAction(database.sql, {
          actorId: admin,
          target: "topics",
          action: "soft_delete",
          ids: [topic.topicId],
        }),
      );

      const [deleted] = (await database.sql`
        SELECT visibility, reply_count FROM core.topics WHERE id = ${topic.topicId}
      `) as Array<{ visibility: string; reply_count: number }>;
      expect(deleted).toEqual({ visibility: "soft_deleted", reply_count: 3 });
      const deletedPosts = (await database.sql`
        SELECT visibility FROM core.posts WHERE topic_id = ${topic.topicId}
      `) as Array<{ visibility: string }>;
      expect(deletedPosts).toHaveLength(4);
      expect(deletedPosts.every((post) => post.visibility === "visible")).toBe(true);

      const [forumDuring] = (await database.sql`
        SELECT topic_count, post_count FROM core.forums WHERE id = ${forum}
      `) as Array<{ topic_count: number; post_count: number }>;
      const [memberDuring] = (await database.sql`
        SELECT post_count FROM core.members WHERE id = ${member}
      `) as Array<{ post_count: number }>;
      expect(forumDuring).toEqual({
        topic_count: (forumBefore?.topic_count ?? 0) - 1,
        post_count: (forumBefore?.post_count ?? 0) - 4,
      });
      expect(memberDuring?.post_count).toBe((memberBefore?.post_count ?? 0) - 4);

      const duringList = await readTopicList(database.sql, {
        forumId: forum,
        locale: "en",
        sort: "last_post",
        prefixId: null,
        page: 1,
        perPage: 100,
        seeUnapproved: false,
        seeDeleted: false,
      });
      expect(duringList.rows.map((row) => row.id)).not.toContain(topic.topicId);

      expectOk(
        await bulkAction(database.sql, {
          actorId: admin,
          target: "topics",
          action: "restore",
          ids: [topic.topicId],
        }),
      );

      const [restored] = (await database.sql`
        SELECT visibility, reply_count FROM core.topics WHERE id = ${topic.topicId}
      `) as Array<{ visibility: string; reply_count: number }>;
      expect(restored).toEqual({ visibility: "visible", reply_count: 3 });
      expect(await topicBodyOrder(database, topic.topicId)).toEqual([
        "Topic opening.",
        "Reply one.",
        "Reply two.",
        "Reply three.",
      ]);
      expect(await topicPositions(database, topic.topicId)).toEqual([1, 2, 3, 4]);
      const [forumAfter] = (await database.sql`
        SELECT topic_count, post_count FROM core.forums WHERE id = ${forum}
      `) as Array<{ topic_count: number; post_count: number }>;
      const [memberAfter] = (await database.sql`
        SELECT post_count FROM core.members WHERE id = ${member}
      `) as Array<{ post_count: number }>;
      expect(forumAfter).toEqual(forumBefore);
      expect(memberAfter).toEqual(memberBefore);
      const afterList = await readTopicList(database.sql, {
        forumId: forum,
        locale: "en",
        sort: "last_post",
        prefixId: null,
        page: 1,
        perPage: 100,
        seeUnapproved: false,
        seeDeleted: false,
      });
      expect(afterList.rows.map((row) => row.id)).toContain(topic.topicId);

      const logActions = (await database.sql`
        SELECT action FROM core.moderation_log
        WHERE target_type = 'topic' AND target_id = ${topic.topicId}
        ORDER BY id
      `) as Array<{ action: string }>;
      expect(logActions.map((row) => row.action)).toEqual(["topic.delete", "topic.restore"]);
    });
  }, 60_000);

  test("splits a 10,000-post topic with contiguous positions in both topics", async () => {
    await withSeededDb(async (database) => {
      const admin = await memberId(database, "admin");
      const author = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: forum,
          title: "Huge split source",
          bodyMd: "Opening.",
        }),
      );
      const firstReply = (await database.sql`
        SELECT id::text AS id FROM core.posts WHERE id = ${topic.postId}
      `) as Array<{ id: string }>;

      if (firstReply[0] === undefined) {
        throw new Error("Missing the opening post");
      }

      await database.sql`
        INSERT INTO core.posts (
          topic_id, author_id, body_md, body_html, body_text, render_version,
          sanitiser_version, visibility, position, created_at
        )
        SELECT ${topic.topicId}, ${author}, 'Load reply ' || g,
          '<p>Load reply ' || g || '</p>', 'Load reply ' || g, 1, 1, 'visible',
          g + 1, now() - make_interval(secs => 10001 - g)
        FROM generate_series(1, 10000) AS g
      `;
      const postIds = (await database.sql`
        SELECT id::text AS id FROM core.posts
        WHERE topic_id = ${topic.topicId} AND position BETWEEN 5001 AND 6000
        ORDER BY position
      `) as Array<{ id: string }>;

      const split = expectOk(
        await splitTopic(database.sql, {
          actorId: admin,
          sourceTopicId: topic.topicId,
          postIds: postIds.map((post) => post.id),
          target: { kind: "new", forumId: forum, title: "Huge split target" },
        }),
      );
      const sourceCount = (await database.sql`
        SELECT count(*)::int AS count, max(position)::int AS last_position,
          min(position)::int AS first_position
        FROM core.posts WHERE topic_id = ${topic.topicId}
      `) as Array<{ count: number; last_position: number; first_position: number }>;
      const targetCount = (await database.sql`
        SELECT count(*)::int AS count, max(position)::int AS last_position,
          min(position)::int AS first_position
        FROM core.posts WHERE topic_id = ${split.topicId}
      `) as Array<{ count: number; last_position: number; first_position: number }>;
      expect(sourceCount[0]).toEqual({ count: 9001, last_position: 9001, first_position: 1 });
      expect(targetCount[0]).toEqual({ count: 1000, last_position: 1000, first_position: 1 });
    });
  }, 120_000);

  test("a soft-deleted topic disappears from attachments, quotes, profiles and notifications", async () => {
    await withSeededDb(async (database) => {
      const admin = await memberId(database, "admin");
      const author = await memberId(database, "member-1");
      const viewer = await memberId(database, "member-2");
      const forum = await forumId(database, "off-topic");
      const tree = await loadForumTree(database.sql);
      const snapshot = await loadPermissionSnapshot(database.sql, viewer, { tree });
      const source = expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: forum,
          title: "Deleted surfaces source",
          bodyMd: "Source body remains hidden with its topic.",
        }),
      );
      const attachment = (await database.sql`
        INSERT INTO core.attachments (
          member_id, state, filename, declared_type, declared_bytes, quarantine_key,
          storage_key, size_bytes, sha256, verified_type
        )
        VALUES (
          ${author}, 'ready', 'surface.pdf', 'application/pdf', 1,
          ${`quarantine/${crypto.randomUUID()}`}, ${`att/${crypto.randomUUID()}`}, 1,
          ${"a".repeat(64)}, 'application/pdf'
        )
        RETURNING id::text AS id
      `) as Array<{ id: string }>;
      const attachmentId = attachment[0]?.id;

      if (attachmentId === undefined) {
        throw new Error("Could not create the attachment");
      }

      await database.sql`
        INSERT INTO core.post_attachments (post_id, attachment_id, position)
        VALUES (${source.postId}, ${attachmentId}, 0)
      `;
      expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: forum,
          title: "Quote holder",
          bodyMd: `:::quote{source="post:${source.postId}"}
Quoted.
:::

Holder body.`,
        }),
      );
      await database.sql`
        INSERT INTO core.notifications (
          member_id, type, topic_id, forum_id, post_id, count, read_at
        )
        VALUES (${viewer}, 'topic.reply', ${source.topicId}, ${forum}, ${source.postId}, 1, NULL)
      `;

      const profile = async () =>
        (
          await readRecentProfilePosts(database.sql, {
            memberId: author,
            limit: 10,
            principal: viewer,
            sessionId: null,
            tree,
            snapshot,
          })
        ).posts.map((post) => post.id);
      expect(await profile()).toContain(source.postId);
      expect(await readDownloadableAttachment(database.sql, attachmentId)).not.toBeNull();
      expect((await loadQuoteSources(database.sql, [source.postId])).has(source.postId)).toBe(true);
      expect((await listNotifications(database.sql, viewer)).length).toBe(1);
      expect(await unreadNotificationCount(database.sql, viewer)).toBe(1);

      expectOk(
        await bulkAction(database.sql, {
          actorId: admin,
          target: "topics",
          action: "soft_delete",
          ids: [source.topicId],
        }),
      );

      expect(await profile()).not.toContain(source.postId);
      expect(await readDownloadableAttachment(database.sql, attachmentId)).toBeNull();
      expect((await loadQuoteSources(database.sql, [source.postId])).size).toBe(0);
      expect((await listNotifications(database.sql, viewer)).length).toBe(0);
      expect(await unreadNotificationCount(database.sql, viewer)).toBe(0);

      expectOk(
        await bulkAction(database.sql, {
          actorId: admin,
          target: "topics",
          action: "restore",
          ids: [source.topicId],
        }),
      );
      expect(await profile()).toContain(source.postId);
      expect(await readDownloadableAttachment(database.sql, attachmentId)).not.toBeNull();
      expect((await loadQuoteSources(database.sql, [source.postId])).has(source.postId)).toBe(true);
      expect((await listNotifications(database.sql, viewer)).length).toBe(1);
      expect(await unreadNotificationCount(database.sql, viewer)).toBe(1);
    });
  }, 60_000);

  test("multi-moderation re-authorizes the locked topic after a concurrent move", async () => {
    await withSeededDb(async (database) => {
      const admin = await memberId(database, "admin");
      const author = await memberId(database, "member-1");
      const moderator = await memberId(database, "forum-mod");
      const tree = await loadForumTree(database.sql);
      const moderated = new Set(
        (await moderatedForums(database.sql, moderator, null, tree)).map((forum) => forum.id),
      );
      const forums = (await database.sql`
        SELECT id::text AS id FROM core.forums WHERE type = 'forum' ORDER BY id
      `) as Array<{ id: string }>;
      let source: { readonly id: string } | undefined;
      let destination: { readonly id: string } | undefined;

      for (const forum of forums) {
        if (
          moderated.has(forum.id) &&
          (await can(database.sql, author, "start", { forumId: forum.id, tree }))
        ) {
          source = forum;
          break;
        }
      }

      destination = forums.find((forum) => !moderated.has(forum.id));

      if (source === undefined || destination === undefined) {
        throw new Error("Missing a moderated and an unmoderated forum");
      }

      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: source.id,
          title: "Raced multimod topic",
          bodyMd: "Opening.",
        }),
      );
      const action = expectOk(
        await saveMultimodAction(database.sql, admin, {
          name: `Raced multimod ${Date.now()}`,
          forumIds: [source.id],
          steps: [{ type: "lock", locked: true }],
        }),
      );

      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const moving = database.sql.begin(async (tx) => {
        await tx`UPDATE core.topics SET forum_id = ${destination.id} WHERE id = ${topic.topicId}`;
        await gate;
      });
      await Bun.sleep(50);
      const applying = applyMultimod(database.sql, {
        actorId: moderator,
        actionId: action.id,
        topicId: topic.topicId,
      });
      await Bun.sleep(100);
      release();
      await moving;

      expect(await applying).toEqual({ ok: false, code: "forbidden" });
      const [row] = (await database.sql`
        SELECT forum_id::text AS forum_id, locked FROM core.topics WHERE id = ${topic.topicId}
      `) as Array<{ forum_id: string; locked: boolean }>;
      expect(row).toEqual({ forum_id: destination.id, locked: false });
    });
  }, 60_000);

  test("applies mark-solved as one logged multi-moderation action", async () => {
    await withSeededDb(async (database) => {
      const forum = await forumId(database, "off-topic");
      const admin = await memberId(database, "admin");
      const member = await memberId(database, "member-1");
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Question that gets solved",
          bodyMd: "How do I do this?",
        }),
      );
      const [prefix] = (await database.sql`
        INSERT INTO core.prefixes (key, colour)
        VALUES (${`solved_${Date.now()}`}, '#2f855a')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (prefix === undefined) {
        throw new Error("Could not create the prefix");
      }

      await database.sql`
        INSERT INTO core.forum_prefixes (forum_id, prefix_id)
        VALUES (${forum}, ${prefix.id})
      `;

      const definition = expectOk(
        await saveMultimodAction(database.sql, admin, {
          name: `Mark solved ${Date.now()}`,
          forumIds: [forum],
          steps: [
            { type: "prefix", prefixId: prefix.id },
            { type: "lock", locked: true },
            { type: "reply", bodyMd: "Marked as solved", authorId: null },
          ],
        }),
      );

      const [logBefore] = (await database.sql`
        SELECT count(*)::int AS count FROM core.moderation_log
      `) as Array<{ count: number }>;
      const applied = expectOk(
        await applyMultimod(database.sql, {
          actorId: admin,
          actionId: definition.id,
          topicId: topic.topicId,
        }),
      );
      expect(applied.topicId).toBe(topic.topicId);

      const [row] = (await database.sql`
        SELECT prefix_id::text AS prefix_id, locked, last_post_id::text AS last_post_id
        FROM core.topics WHERE id = ${topic.topicId}
      `) as Array<{ prefix_id: string | null; locked: boolean; last_post_id: string | null }>;
      expect(row?.prefix_id).toBe(prefix.id);
      expect(row?.locked).toBe(true);

      const [lastPost] = (await database.sql`
        SELECT author_id::text AS author_id, body_md
        FROM core.posts WHERE id = ${row?.last_post_id}
      `) as Array<{ author_id: string; body_md: string }>;
      expect(lastPost).toMatchObject({ author_id: admin, body_md: "Marked as solved" });

      const [logAfter] = (await database.sql`
        SELECT count(*)::int AS count FROM core.moderation_log
      `) as Array<{ count: number }>;
      expect(logAfter?.count).toBe((logBefore?.count ?? 0) + 1);
      const logs = (await database.sql`
        SELECT action, target_id::text AS target_id FROM core.moderation_log
        WHERE action = 'multimod.apply'
      `) as Array<{ action: string; target_id: string }>;
      expect(logs).toEqual([{ action: "multimod.apply", target_id: topic.topicId }]);

      expect(
        await applyMultimod(database.sql, {
          actorId: member,
          actionId: definition.id,
          topicId: topic.topicId,
        }),
      ).toEqual({ ok: false, code: "forbidden" });
      expect((await listMultimodActions(database.sql))[0]?.steps).toHaveLength(3);
    });
  }, 60_000);

  test("a suspended moderator cannot publish a multi-moderation reply", async () => {
    await withSeededDb(async (database) => {
      const forum = await forumId(database, "off-topic");
      const admin = await memberId(database, "admin");
      const member = await memberId(database, "member-1");
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Suspended multi-mod topic",
          bodyMd: "Opening.",
        }),
      );
      const definition = expectOk(
        await saveMultimodAction(database.sql, admin, {
          name: `Suspended reply ${Date.now()}`,
          forumIds: [forum],
          steps: [{ type: "reply", bodyMd: "This must not publish", authorId: null }],
        }),
      );
      await database.sql`
        INSERT INTO core.member_restrictions (member_id, kind, until)
        VALUES (${admin}, 'cannot_post', now() + interval '1 day')
      `;

      expect(
        await applyMultimod(database.sql, {
          actorId: admin,
          actionId: definition.id,
          topicId: topic.topicId,
        }),
      ).toEqual({ ok: false, code: "posting_suspended" });

      const posts = (await database.sql`
        SELECT 1 FROM core.posts WHERE body_md = 'This must not publish'
      `) as unknown[];
      expect(posts).toHaveLength(0);
    });
  }, 60_000);

  test("a multi-moderation reply is held when the moderator needs approval", async () => {
    await withSeededDb(async (database) => {
      const forum = await forumId(database, "off-topic");
      const admin = await memberId(database, "admin");
      const moderator = await memberId(database, "super-mod");
      const member = await memberId(database, "member-1");
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Held multi-mod topic",
          bodyMd: "Opening.",
        }),
      );
      const definition = expectOk(
        await saveMultimodAction(database.sql, admin, {
          name: `Held reply ${Date.now()}`,
          forumIds: [forum],
          steps: [{ type: "reply", bodyMd: "Held macro reply", authorId: null }],
        }),
      );
      await database.sql`
        INSERT INTO core.member_restrictions (member_id, kind, until)
        VALUES (${moderator}, 'posts_require_approval', now() + interval '1 day')
      `;

      expectOk(
        await applyMultimod(database.sql, {
          actorId: moderator,
          actionId: definition.id,
          topicId: topic.topicId,
        }),
      );

      const [post] = (await database.sql`
        SELECT id::text AS id, visibility, hold_reason
        FROM core.posts WHERE body_md = 'Held macro reply'
      `) as Array<{ id: string; visibility: string; hold_reason: string | null }>;
      expect(post).toMatchObject({ visibility: "unapproved", hold_reason: "warning" });

      const [row] = (await database.sql`
        SELECT reply_count, last_post_id::text AS last_post_id
        FROM core.topics WHERE id = ${topic.topicId}
      `) as Array<{ reply_count: number; last_post_id: string | null }>;
      expect(row).toEqual({ reply_count: 0, last_post_id: topic.postId });
      expect(post?.id).not.toBe(topic.postId);
    });
  }, 60_000);

  test("rejects a reply step author who is not a service member", async () => {
    await withSeededDb(async (database) => {
      const forum = await forumId(database, "off-topic");
      const admin = await memberId(database, "admin");
      const member = await memberId(database, "member-1");

      expect(
        await saveMultimodAction(database.sql, admin, {
          name: `Bad reply author ${Date.now()}`,
          forumIds: [forum],
          steps: [{ type: "reply", bodyMd: "Should not save", authorId: member }],
        }),
      ).toEqual({ ok: false, code: "invalid_step" });

      const [service] = (await database.sql`
        INSERT INTO core.members (display_name, name_skeleton, is_service)
        VALUES ('Service Bot', 'service-bot', true)
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (service === undefined) {
        throw new Error("Could not create the service member");
      }

      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Service reply target",
          bodyMd: "Opening.",
        }),
      );
      const definition = expectOk(
        await saveMultimodAction(database.sql, admin, {
          name: `Service reply ${Date.now()}`,
          forumIds: [forum],
          steps: [{ type: "reply", bodyMd: "Service says hello", authorId: service.id }],
        }),
      );
      expectOk(
        await applyMultimod(database.sql, {
          actorId: admin,
          actionId: definition.id,
          topicId: topic.topicId,
        }),
      );
      const [lastPost] = (await database.sql`
        SELECT p.author_id::text AS author_id, p.body_md
        FROM core.topics t JOIN core.posts p ON p.id = t.last_post_id
        WHERE t.id = ${topic.topicId}
      `) as Array<{ author_id: string; body_md: string }>;
      expect(lastPost).toMatchObject({ author_id: service.id, body_md: "Service says hello" });
    });
  }, 60_000);
});
