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
  listMultimodActions,
  loadQuoteSources,
  mergeTopics,
  move,
  readTopicList,
  reply,
  saveMultimodAction,
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
