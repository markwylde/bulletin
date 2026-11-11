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
} from "@bulletin/db/seed";
import { insertQuoteSnapshot } from "@bulletin/domain/content";
import {
  editPost,
  hardDelete,
  lock,
  move,
  pin,
  reply,
  restore,
  softDelete,
  startTopic,
} from "@bulletin/domain/topics";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "topic_mutations" }, async (database) => {
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

interface ForumCounters {
  readonly topicCount: number;
  readonly postCount: number;
  readonly lastPostId: string | null;
  readonly lastPostMemberId: string | null;
}

async function forumCounters(database: TestDatabase, forumId: string): Promise<ForumCounters> {
  const [row] = (await database.sql`
    SELECT topic_count, post_count, last_post_id::text AS last_post_id,
      last_post_member_id::text AS last_post_member_id
    FROM core.forums WHERE id = ${forumId}
  `) as Array<{
    topic_count: number;
    post_count: number;
    last_post_id: string | null;
    last_post_member_id: string | null;
  }>;

  if (row === undefined) {
    throw new Error(`Missing forum ${forumId}`);
  }

  return {
    topicCount: row.topic_count,
    postCount: row.post_count,
    lastPostId: row.last_post_id,
    lastPostMemberId: row.last_post_member_id,
  };
}

async function memberPostCount(database: TestDatabase, memberId: string): Promise<number> {
  const [row] = (await database.sql`
    SELECT post_count FROM core.members WHERE id = ${memberId}
  `) as Array<{ post_count: number }>;

  return row?.post_count ?? -1;
}

async function tagVersion(database: TestDatabase, tag: string): Promise<string | null> {
  const [row] = (await database.sql`
    SELECT version::text AS version FROM core.cache_tags WHERE tag = ${tag}
  `) as Array<{ version: string }>;

  return row?.version ?? null;
}

async function expectOk<T>(
  outcome:
    | { readonly ok: true; readonly result: T }
    | { readonly ok: false; readonly code: string },
): Promise<T> {
  if (!outcome.ok) {
    throw new Error(`Expected success, received ${outcome.code}`);
  }

  return outcome.result;
}

integrationDescribe("topic and post mutations", () => {
  test("starts a topic with a prefix and updates every counter and tag", async () => {
    await withSeededDb(async (database) => {
      const general = await forumId(database, "general-discussion");
      const author = await memberId(database, "member-1");
      const [session] = (await database.sql`
        INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
        VALUES (${author}, 'user', decode(md5(random()::text), 'hex'), now() + interval '1 day')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (session === undefined) {
        throw new Error("Could not create a session");
      }

      await database.sql`
        INSERT INTO core.session_grants (session_id, kind, resource_id)
        VALUES (${session.id}, 'forum_password', ${general})
      `;
      const beforeForum = await forumCounters(database, general);
      const beforeMember = await memberPostCount(database, author);
      const [prefix] = (await database.sql`
        SELECT p.id::text AS id
        FROM core.forums f
        JOIN core.forum_prefixes fp ON fp.forum_id = f.id
        JOIN core.prefixes p ON p.id = fp.prefix_id
        WHERE f.slug = 'general-discussion' AND p.key = 'question'
      `) as Array<{ id: string }>;

      const result = await expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: general,
          sessionId: session.id,
          title: "  How do I quote a post?  ",
          bodyMd: "Use **multi-quote**.",
          ...(prefix === undefined ? {} : { prefixId: prefix.id }),
        }),
      );

      expect(result.position).toBe(1);

      const [topic] = (await database.sql`
        SELECT title, slug, prefix_id::text AS prefix_id, reply_count, view_count,
          first_post_id::text AS first_post_id, last_post_id::text AS last_post_id
        FROM core.topics WHERE id = ${result.topicId}
      `) as Array<{
        title: string;
        slug: string;
        prefix_id: string | null;
        reply_count: number;
        view_count: string;
        first_post_id: string;
        last_post_id: string;
      }>;
      expect(topic).toMatchObject({
        title: "How do I quote a post?",
        slug: "how-do-i-quote-a-post",
        prefix_id: prefix?.id ?? null,
        reply_count: 0,
        first_post_id: result.postId,
        last_post_id: result.postId,
      });
      expect(topic?.view_count).toBe("0");

      const [post] = (await database.sql`
        SELECT position, visibility, body_md, body_html, author_id::text AS author_id
        FROM core.posts WHERE id = ${result.postId}
      `) as Array<{
        position: number;
        visibility: string;
        body_md: string;
        body_html: string;
        author_id: string;
      }>;
      expect(post).toMatchObject({
        position: 1,
        visibility: "visible",
        body_md: "Use **multi-quote**.",
        author_id: author,
      });
      expect(post?.body_html).toContain("<strong>multi-quote</strong>");

      const afterForum = await forumCounters(database, general);
      expect(afterForum.topicCount).toBe(beforeForum.topicCount + 1);
      expect(afterForum.postCount).toBe(beforeForum.postCount + 1);
      expect(afterForum.lastPostId).toBe(result.postId);
      expect(afterForum.lastPostMemberId).toBe(author);
      expect(await memberPostCount(database, author)).toBe(beforeMember + 1);

      const category = await forumId(database, "community");
      expect(await tagVersion(database, `topic:${result.topicId}`)).toBe("1");
      expect(await tagVersion(database, `topic:${result.topicId}:pages`)).toBe("1");
      expect(await tagVersion(database, `forum:${general}`)).toBe("1");
      expect(await tagVersion(database, `forum:${category}`)).toBe("1");
      expect(await tagVersion(database, "board")).toBe("1");
      expect(await tagVersion(database, `member:${author}`)).toBe("1");
    });
  }, 30_000);

  test("requires a prefix where the forum asks for one and denies a forum the member cannot start in", async () => {
    await withSeededDb(async (database) => {
      const help = await forumId(database, "help-questions");
      const staff = await forumId(database, "staff-room");
      const author = await memberId(database, "member-1");

      expect(
        await startTopic(database.sql, {
          actorId: author,
          forumId: help,
          title: "x",
          bodyMd: "Bad title.",
        }),
      ).toEqual({ ok: false, code: "invalid_title" });
      expect(
        await startTopic(database.sql, {
          actorId: author,
          forumId: help,
          title: "Empty body",
          bodyMd: "   ",
        }),
      ).toEqual({ ok: false, code: "invalid_body" });

      const missing = await startTopic(database.sql, {
        actorId: author,
        forumId: help,
        title: "Missing prefix",
        bodyMd: "No prefix here.",
      });
      expect(missing).toEqual({ ok: false, code: "prefix_required" });

      const [prefix] = (await database.sql`
        SELECT p.id::text AS id
        FROM core.forums f
        JOIN core.forum_prefixes fp ON fp.forum_id = f.id
        JOIN core.prefixes p ON p.id = fp.prefix_id
        WHERE f.slug = 'help-questions' AND p.key = 'question'
      `) as Array<{ id: string }>;

      if (prefix === undefined) {
        throw new Error("Missing seeded prefix");
      }

      const withPrefix = await startTopic(database.sql, {
        actorId: author,
        forumId: help,
        title: "With prefix",
        bodyMd: "This one has a prefix.",
        prefixId: prefix.id,
      });
      expect(withPrefix.ok).toBe(true);

      expect(
        await startTopic(database.sql, {
          actorId: author,
          forumId: staff,
          title: "Not allowed",
          bodyMd: "Staff only.",
        }),
      ).toEqual({ ok: false, code: "forbidden" });
    });
  }, 30_000);

  test("keeps counters and positions correct under concurrent replies", async () => {
    await withSeededDb(async (database) => {
      const general = await forumId(database, "off-topic");
      const first = await memberId(database, "member-1");
      const second = await memberId(database, "member-2");
      const beforeForum = await forumCounters(database, general);
      const beforeFirst = await memberPostCount(database, first);
      const beforeSecond = await memberPostCount(database, second);

      const topic = await expectOk(
        await startTopic(database.sql, {
          actorId: first,
          forumId: general,
          title: "Concurrent replies",
          bodyMd: "Original post.",
        }),
      );

      const actors = [
        first,
        second,
        first,
        second,
        first,
        second,
        first,
        second,
        first,
        second,
        first,
        second,
      ];
      const replies = await Promise.all(
        actors.map((actorId, index) =>
          reply(database.sql, {
            actorId,
            topicId: topic.topicId,
            bodyMd: `Reply number ${index + 1}`,
          }),
        ),
      );
      const failures = replies.filter((outcome) => !outcome.ok);
      expect(failures).toEqual([]);

      const [row] = (await database.sql`
        SELECT reply_count, last_post_id::text AS last_post_id, last_post_at
        FROM core.topics WHERE id = ${topic.topicId}
      `) as Array<{ reply_count: number; last_post_id: string; last_post_at: Date }>;
      expect(row?.reply_count).toBe(actors.length);

      const positions = (await database.sql`
        SELECT position FROM core.posts WHERE topic_id = ${topic.topicId} ORDER BY position
      `) as Array<{ position: number }>;
      expect(positions.map((post) => post.position)).toEqual(
        Array.from({ length: actors.length + 1 }, (_value, index) => index + 1),
      );

      const afterForum = await forumCounters(database, general);
      expect(afterForum.postCount).toBe(beforeForum.postCount + 1 + actors.length);
      expect(afterForum.lastPostId).toBe(row?.last_post_id);

      expect(await memberPostCount(database, first)).toBe(beforeFirst + 1 + 6);
      expect(await memberPostCount(database, second)).toBe(beforeSecond + 6);
    });
  }, 60_000);

  test("rejects replies to a locked topic unless the member may lock topics", async () => {
    await withSeededDb(async (database) => {
      const general = await forumId(database, "off-topic");
      const author = await memberId(database, "member-1");
      const moderator = await memberId(database, "super-mod");
      const topic = await expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: general,
          title: "Locked topic",
          bodyMd: "Original post.",
        }),
      );

      expect(
        await lock(database.sql, { actorId: author, topicId: topic.topicId, locked: true }),
      ).toEqual({ ok: false, code: "forbidden" });
      await expectOk(
        await lock(database.sql, { actorId: moderator, topicId: topic.topicId, locked: true }),
      );

      expect(
        await reply(database.sql, {
          actorId: author,
          topicId: topic.topicId,
          bodyMd: "Should not appear.",
        }),
      ).toEqual({ ok: false, code: "locked" });

      const moderatorReply = await reply(database.sql, {
        actorId: moderator,
        topicId: topic.topicId,
        bodyMd: "Moderator reply.",
      });
      expect(moderatorReply.ok).toBe(true);

      expect(
        await pin(database.sql, { actorId: author, topicId: topic.topicId, pinned: true }),
      ).toEqual({ ok: false, code: "forbidden" });
      await expectOk(
        await pin(database.sql, { actorId: moderator, topicId: topic.topicId, pinned: true }),
      );
      const [row] = (await database.sql`
        SELECT pinned, locked FROM core.topics WHERE id = ${topic.topicId}
      `) as Array<{ pinned: boolean; locked: boolean }>;
      expect(row).toEqual({ pinned: true, locked: true });
    });
  }, 30_000);

  test("edits keep the previous version, enforce the window and redact moderator edits", async () => {
    await withSeededDb(async (database) => {
      const general = await forumId(database, "off-topic");
      const author = await memberId(database, "member-1");
      const other = await memberId(database, "member-2");
      const moderator = await memberId(database, "super-mod");

      await database.sql`
        INSERT INTO core.group_settings (group_id, key, value)
        SELECT g.id, 'posting.edit_window_minutes', to_jsonb(60)
        FROM core.groups g
        WHERE g.key = 'members'
        ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value
      `;

      const topic = await expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: general,
          title: "Editable post",
          bodyMd: "First version.",
        }),
      );

      const edit = await expectOk(
        await editPost(database.sql, {
          actorId: author,
          postId: topic.postId,
          bodyMd: "Second version.",
        }),
      );
      expect(edit.redacted).toBe(false);

      const [post] = (await database.sql`
        SELECT body_md, edited_by::text AS edited_by, edited_at
        FROM core.posts WHERE id = ${topic.postId}
      `) as Array<{ body_md: string; edited_by: string; edited_at: Date }>;
      expect(post?.body_md).toBe("Second version.");
      expect(post?.edited_by).toBe(author);
      expect(post?.edited_at).toBeInstanceOf(Date);

      const revisions = (await database.sql`
        SELECT body_md, editor_id::text AS editor_id, protected
        FROM core.post_revisions WHERE post_id = ${topic.postId} ORDER BY id
      `) as Array<{ body_md: string; editor_id: string; protected: boolean }>;
      expect(revisions).toHaveLength(1);
      expect(revisions[0]).toMatchObject({
        body_md: "First version.",
        editor_id: author,
        protected: false,
      });
      expect(await tagVersion(database, `topic:${topic.topicId}:pages`)).toBe("2");

      await database.sql`
        UPDATE core.posts SET created_at = now() - interval '2 hours' WHERE id = ${topic.postId}
      `;
      expect(
        await editPost(database.sql, {
          actorId: author,
          postId: topic.postId,
          bodyMd: "Too late.",
        }),
      ).toEqual({ ok: false, code: "edit_window_expired" });

      const snapshot = await insertQuoteSnapshot(database.sql, {
        sourceKind: "post",
        sourceId: topic.postId,
        sourceAuthorId: author,
        bodyMd: "Second version.",
        bodyHtml: "<p>Second version.</p>",
        renderVersion: 1,
        sanitiserVersion: 1,
      });

      const redacted = await expectOk(
        await editPost(database.sql, {
          actorId: moderator,
          postId: topic.postId,
          bodyMd: "Moderator version.",
        }),
      );
      expect(redacted.redacted).toBe(true);

      const protectedRows = (await database.sql`
        SELECT protected FROM core.post_revisions WHERE post_id = ${topic.postId}
      `) as Array<{ protected: boolean }>;
      expect(protectedRows.every((row) => row.protected)).toBe(true);

      const [redactedSnapshot] = (await database.sql`
        SELECT redacted_at FROM core.quote_snapshots WHERE id = ${snapshot}
      `) as Array<{ redacted_at: Date | null }>;
      expect(redactedSnapshot?.redacted_at).toBeInstanceOf(Date);
      expect(await tagVersion(database, `post:${topic.postId}:snapshots`)).toBe("1");

      expect(
        await editPost(database.sql, {
          actorId: other,
          postId: topic.postId,
          bodyMd: "Another member cannot edit this.",
        }),
      ).toEqual({ ok: false, code: "forbidden" });
    });
  }, 30_000);

  test("soft delete hides a reply, updates counts and restores only with the power", async () => {
    await withSeededDb(async (database) => {
      const general = await forumId(database, "off-topic");
      const author = await memberId(database, "member-1");
      const replier = await memberId(database, "member-2");
      const moderator = await memberId(database, "super-mod");
      const topic = await expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: general,
          title: "Deletable reply",
          bodyMd: "Original post.",
        }),
      );
      const firstReply = await expectOk(
        await reply(database.sql, {
          actorId: replier,
          topicId: topic.topicId,
          bodyMd: "Reply to delete.",
        }),
      );
      const beforeForum = await forumCounters(database, general);
      const beforeReplier = await memberPostCount(database, replier);

      expect(
        await softDelete(database.sql, { actorId: author, postId: firstReply.postId }),
      ).toEqual({ ok: false, code: "forbidden" });

      await expectOk(
        await softDelete(database.sql, { actorId: replier, postId: firstReply.postId }),
      );

      const [deleted] = (await database.sql`
        SELECT visibility FROM core.posts WHERE id = ${firstReply.postId}
      `) as Array<{ visibility: string }>;
      expect(deleted?.visibility).toBe("soft_deleted");

      const afterDeleteForum = await forumCounters(database, general);
      expect(afterDeleteForum.postCount).toBe(beforeForum.postCount - 1);
      expect(afterDeleteForum.lastPostId).toBe(topic.postId);
      expect(await memberPostCount(database, replier)).toBe(beforeReplier - 1);

      const [afterDeleteTopic] = (await database.sql`
        SELECT reply_count, last_post_id::text AS last_post_id
        FROM core.topics WHERE id = ${topic.topicId}
      `) as Array<{ reply_count: number; last_post_id: string }>;
      expect(afterDeleteTopic?.reply_count).toBe(0);
      expect(afterDeleteTopic?.last_post_id).toBe(topic.postId);

      expect(await restore(database.sql, { actorId: replier, postId: firstReply.postId })).toEqual({
        ok: false,
        code: "forbidden",
      });

      await expectOk(
        await restore(database.sql, { actorId: moderator, postId: firstReply.postId }),
      );

      const [restored] = (await database.sql`
        SELECT visibility FROM core.posts WHERE id = ${firstReply.postId}
      `) as Array<{ visibility: string }>;
      expect(restored?.visibility).toBe("visible");
      expect((await forumCounters(database, general)).postCount).toBe(beforeForum.postCount);
      expect((await forumCounters(database, general)).lastPostId).toBe(firstReply.postId);
      expect(await memberPostCount(database, replier)).toBe(beforeReplier);
    });
  }, 30_000);

  test("hard delete removes posts and topics and refuses the first post alone", async () => {
    await withSeededDb(async (database) => {
      const general = await forumId(database, "off-topic");
      const author = await memberId(database, "member-1");
      const replier = await memberId(database, "member-2");
      const moderator = await memberId(database, "super-mod");
      const topic = await expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: general,
          title: "Hard delete",
          bodyMd: "Original post.",
        }),
      );
      const second = await expectOk(
        await reply(database.sql, {
          actorId: replier,
          topicId: topic.topicId,
          bodyMd: "Reply to remove.",
        }),
      );
      const beforeForum = await forumCounters(database, general);
      const beforeReplier = await memberPostCount(database, replier);

      expect(await hardDelete(database.sql, { actorId: moderator, postId: topic.postId })).toEqual({
        ok: false,
        code: "first_post_requires_topic_delete",
      });
      expect(await hardDelete(database.sql, { actorId: replier, postId: second.postId })).toEqual({
        ok: false,
        code: "forbidden",
      });

      await expectOk(await hardDelete(database.sql, { actorId: moderator, postId: second.postId }));
      const remaining = (await database.sql`
        SELECT id::text AS id FROM core.posts WHERE topic_id = ${topic.topicId}
      `) as Array<{ id: string }>;
      expect(remaining.map((row) => row.id)).toEqual([topic.postId]);
      expect((await forumCounters(database, general)).postCount).toBe(beforeForum.postCount - 1);
      expect(await memberPostCount(database, replier)).toBe(beforeReplier - 1);

      await database.sql`
        UPDATE core.forums SET last_post_id = ${topic.postId},
          last_post_member_id = ${author}, last_post_at = now()
        WHERE id = ${general}
      `;

      await expectOk(
        await hardDelete(database.sql, { actorId: moderator, topicId: topic.topicId }),
      );

      const [topicRow] = (await database.sql`
        SELECT 1 FROM core.topics WHERE id = ${topic.topicId}
      `) as unknown[];
      expect(topicRow).toBeUndefined();
      expect(await memberPostCount(database, author)).toBeGreaterThanOrEqual(0);

      const afterForum = await forumCounters(database, general);
      expect(afterForum.topicCount).toBe(beforeForum.topicCount - 1);
      expect(afterForum.postCount).toBe(beforeForum.postCount - 2);
      expect(afterForum.lastPostId).not.toBe(topic.postId);
    });
  }, 30_000);

  test("moves a topic between forums with a redirect stub and denies members", async () => {
    await withSeededDb(async (database) => {
      const general = await forumId(database, "off-topic");
      const offTopic = await forumId(database, "bug-reports");
      const author = await memberId(database, "member-1");
      const moderator = await memberId(database, "super-mod");
      const topic = await expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: general,
          title: "Movable topic",
          bodyMd: "Original post.",
        }),
      );
      const beforeSource = await forumCounters(database, general);
      const beforeDestination = await forumCounters(database, offTopic);

      expect(
        await move(database.sql, {
          actorId: author,
          topicId: topic.topicId,
          toForumId: offTopic,
        }),
      ).toEqual({ ok: false, code: "forbidden" });
      expect(
        await move(database.sql, {
          actorId: moderator,
          topicId: topic.topicId,
          toForumId: "999999",
        }),
      ).toEqual({ ok: false, code: "forum_not_found" });

      const moved = await expectOk(
        await move(database.sql, {
          actorId: moderator,
          topicId: topic.topicId,
          toForumId: offTopic,
          stubDays: 7,
        }),
      );
      expect(moved.forumIds).toContain(general);
      expect(moved.forumIds).toContain(offTopic);

      const [row] = (await database.sql`
        SELECT forum_id::text AS forum_id FROM core.topics WHERE id = ${topic.topicId}
      `) as Array<{ forum_id: string }>;
      expect(row?.forum_id).toBe(offTopic);

      const stubs = (await database.sql`
        SELECT moved_to::text AS moved_to, stub_expires_at
        FROM core.topics
        WHERE forum_id = ${general} AND moved_to = ${topic.topicId}
      `) as Array<{ moved_to: string; stub_expires_at: Date }>;
      expect(stubs).toHaveLength(1);
      expect(stubs[0]?.moved_to).toBe(topic.topicId);
      expect(stubs[0]?.stub_expires_at).toBeInstanceOf(Date);

      const afterSource = await forumCounters(database, general);
      const afterDestination = await forumCounters(database, offTopic);
      expect(afterSource.topicCount).toBe(beforeSource.topicCount - 1);
      expect(afterSource.postCount).toBe(beforeSource.postCount - 1);
      expect(afterDestination.topicCount).toBe(beforeDestination.topicCount + 1);
      expect(afterDestination.postCount).toBe(beforeDestination.postCount + 1);
      expect(afterDestination.lastPostId).toBe(topic.postId);
    });
  }, 30_000);
});
