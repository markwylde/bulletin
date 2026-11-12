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
  createAuthService,
  hashToken,
  type SessionRecord,
  sessionCookieName,
} from "@bulletin/domain/auth";
import { loadEvent } from "@bulletin/domain/events";
import {
  approveHeldPosts,
  heldPostsForOverlay,
  heldTopicsForOverlay,
  listApprovalQueue,
  type ModerationQueueItem,
  moderatedForums,
  pendingApprovalCount,
  rejectHeldPosts,
} from "@bulletin/domain/moderation";
import { can, loadForumTree } from "@bulletin/domain/permissions";
import { readTopic, reply, startTopic } from "@bulletin/domain/topics";
import { createServerT } from "@bulletin/i18n";
import { assertCacheVariants, type VariantCase } from "@bulletin/test-utils/cache-variants";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { authIssuer, userOrigin } from "@bulletin/test-utils/urls";
import { SQL } from "bun";
import {
  authorizeStaffRoute,
  STAFF_ROUTES,
  type StaffRoute,
} from "../../apps/staff-api/src/api.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import type { UserAppSessionContext } from "../../apps/user-app/src/session.ts";
import { renderTopicRoute } from "../../apps/user-app/src/topics/route.ts";
import { createNotificationsEventHandler } from "../../apps/workers/src/notifications.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "moderation_queue" }, async (database) => {
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

async function memberSession(database: TestDatabase, sub: string): Promise<UserAppSessionContext> {
  const [row] = (await database.sql`
    SELECT i.member_id::text AS member_id, m.display_name
    FROM pii.identities i
    JOIN core.members m ON m.id = i.member_id
    WHERE i.sub = ${sub}
  `) as Array<{ member_id: string; display_name: string | null }>;

  if (row === undefined) {
    throw new Error(`Missing seeded member ${sub}`);
  }

  return {
    memberId: row.member_id,
    sessionId: "0",
    reauthAt: new Date().toISOString(),
    locale: "en",
    displayName: row.display_name,
  };
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

async function counters(database: TestDatabase, forum: string, member: string) {
  const [forumRow] = (await database.sql`
    SELECT topic_count, post_count FROM core.forums WHERE id = ${forum}
  `) as Array<{ topic_count: number; post_count: number }>;
  const [memberRow] = (await database.sql`
    SELECT post_count FROM core.members WHERE id = ${member}
  `) as Array<{ post_count: number }>;

  return { forum: forumRow, member: memberRow };
}

async function notifications(database: TestDatabase) {
  return (await database.sql`
    SELECT member_id::text AS member_id, type, topic_id::text AS topic_id,
      post_id::text AS post_id, count
    FROM core.notifications
    ORDER BY id
  `) as Array<{
    member_id: string;
    type: string;
    topic_id: string | null;
    post_id: string | null;
    count: number;
  }>;
}

function route(id: string): StaffRoute {
  const found = STAFF_ROUTES.find((entry) => entry.id === id);

  if (found === undefined) {
    throw new Error(`Missing staff route ${id}`);
  }

  return found;
}

async function overlayRequest(
  database: TestDatabase,
  member: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = new URL(database.url);
  url.username = "user_api";
  url.password = "";
  const sql = new SQL(url.toString());
  const auth = await createAuthService({
    sql,
    kind: "user",
    issuer: authIssuer(),
    jwksUrl: "http://127.0.0.1:1/jwks.json",
    clientId: "bulletin-user",
    origin: userOrigin(),
    sessionSecret: "moderation-queue-secret",
    nodeEnv: "test",
    cacheTtlMs: 0,
    translateFor: (locale) => createServerT(locale, { shipped: USER_CATALOGS }),
  });
  const token = `moderation-${crypto.randomUUID()}`;
  await database.sql`
    INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
    VALUES (${member}, 'user', ${hashToken(token)}, now() + interval '1 day')
  `;

  try {
    const response = await auth.handle(
      new Request(`${userOrigin()}/api/me/overlay`, {
        method: "POST",
        headers: {
          cookie: `${sessionCookieName("user", "test")}=${token}`,
          origin: userOrigin(),
          "content-type": "application/json",
          "x-bulletin-overlay": "1",
        },
        body: JSON.stringify(body),
      }),
    );

    if (response === null) {
      throw new Error("Overlay returned no response");
    }

    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  } finally {
    await auth.close();
    await sql.close();
  }
}

integrationDescribe("moderation queue", () => {
  test("holds a new member's first N approved posts and notifies the author after approval", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberId(database, "new-member");
      const moderator = await memberId(database, "super-mod");

      await database.sql`UPDATE core.members SET post_count = 0 WHERE id = ${author}`;
      await database.sql`
        UPDATE core.board_settings SET new_member_approval_posts = 2 WHERE id = 1
      `;
      const before = await counters(database, offTopic, author);

      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: offTopic,
          title: "New member held topic",
          bodyMd: "First held post.",
        }),
      );
      const heldTopic = await readTopic(database.sql, topic.topicId);
      expect(heldTopic?.visibility).toBe("unapproved");
      expect(heldTopic?.holdReason).toBe("new_member");

      const heldPost = (await database.sql`
        SELECT visibility, hold_reason FROM core.posts WHERE id = ${topic.postId}
      `) as Array<{ visibility: string; hold_reason: string | null }>;
      expect(heldPost[0]).toEqual({ visibility: "unapproved", hold_reason: "new_member" });
      expect(await counters(database, offTopic, author)).toEqual(before);

      const queue = await listApprovalQueue(database.sql, {
        actorId: moderator,
        limit: 10,
        offset: 0,
      });
      expect(queue.items).toHaveLength(1);
      expect(queue.items[0]).toMatchObject({
        postId: topic.postId,
        kind: "topic",
        reason: "new_member",
      });
      expect(await pendingApprovalCount(database.sql, moderator)).toBe(1);

      expectOk(
        await approveHeldPosts(database.sql, {
          actorId: moderator,
          postIds: [topic.postId],
        }),
      );
      expect((await readTopic(database.sql, topic.topicId))?.visibility).toBe("visible");
      expect(await counters(database, offTopic, author)).toEqual({
        forum: {
          topic_count: (before.forum?.topic_count ?? 0) + 1,
          post_count: (before.forum?.post_count ?? 0) + 1,
        },
        member: { post_count: 1 },
      });

      const eventRow = (await database.sql`
        SELECT id FROM core.events WHERE type = 'post.approved' ORDER BY id DESC LIMIT 1
      `) as Array<{ id: string | bigint }>;
      const event = await loadEvent(database.sql, BigInt(eventRow[0]?.id ?? "0"));
      expect(event).not.toBeNull();

      if (event !== null) {
        const handler = createNotificationsEventHandler({ sql: database.sql });
        await handler(event);
        expect(await notifications(database)).toEqual([
          {
            member_id: author,
            type: "post.approved",
            topic_id: topic.topicId,
            post_id: topic.postId,
            count: 1,
          },
        ]);
      }

      // One approved post is below N = 2, so the next reply is held; the third publishes.
      const second = expectOk(
        await reply(database.sql, {
          actorId: author,
          topicId: topic.topicId,
          bodyMd: "Second held post.",
        }),
      );
      expect(
        (await database.sql`SELECT visibility FROM core.posts WHERE id = ${second.postId}`)[0],
      ).toMatchObject({ visibility: "unapproved" });
      expectOk(
        await approveHeldPosts(database.sql, {
          actorId: moderator,
          postIds: [second.postId],
        }),
      );

      const third = expectOk(
        await reply(database.sql, {
          actorId: author,
          topicId: topic.topicId,
          bodyMd: "Third post publishes.",
        }),
      );
      expect(
        (await database.sql`SELECT visibility FROM core.posts WHERE id = ${third.postId}`)[0],
      ).toMatchObject({ visibility: "visible" });
    });
  }, 60_000);

  test("a forum approval rule hides too, with two authors sharing one cached page", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const authorA = await memberSession(database, "member-1");
      const authorB = await memberSession(database, "member-2");
      const moderator = await memberSession(database, "super-mod");

      await database.sql`
        UPDATE core.forums SET require_approval_posts = true WHERE id = ${offTopic}
      `;
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: authorA.memberId,
          forumId: offTopic,
          title: "Two author held replies",
          bodyMd: "Visible opening post.",
        }),
      );
      const heldA = expectOk(
        await reply(database.sql, {
          actorId: authorA.memberId,
          topicId: topic.topicId,
          bodyMd: "HELD-AUTHOR-A-TEXT",
        }),
      );
      const heldB = expectOk(
        await reply(database.sql, {
          actorId: authorB.memberId,
          topicId: topic.topicId,
          bodyMd: "HELD-AUTHOR-B-TEXT",
        }),
      );

      const [topicRow] = (await database.sql`
        SELECT reply_count FROM core.topics WHERE id = ${topic.topicId}
      `) as Array<{ reply_count: number }>;
      expect(topicRow?.reply_count).toBe(0);
      expect(await counters(database, offTopic, authorA.memberId)).toMatchObject({
        member: { post_count: 1 },
      });

      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const render = (session: UserAppSessionContext | null) =>
          renderTopicRoute({
            sql: database.sql,
            locale: "en",
            translate,
            session,
            ref: `${topic.topicId}-two-author-held-replies`,
            pluginsGeneration: 1,
            colourScheme: "system",
            cache,
            tagVersions: versions,
          });
        const page = async (session: UserAppSessionContext | null) => {
          const result = await render(session);

          if (result.kind !== "page") {
            throw new Error("Expected a topic page");
          }

          return {
            variant: result.variant ?? "",
            html: result.html,
            ...(result.cache === null ? {} : { cache: result.cache }),
          };
        };

        const cases: VariantCase[] = [
          { name: "guest", render: () => page(null) },
          { name: "author-a", render: () => page(authorA) },
          { name: "moderator", render: () => page(moderator) },
        ];

        await assertCacheVariants({
          route: "/topic/[ref]",
          cases,
          cache,
          leaks: [
            {
              markers: ["HELD-AUTHOR-A-TEXT", "HELD-AUTHOR-B-TEXT"],
              absentFrom: ["guest", "author-a"],
            },
          ],
        });

        const authorBPage = await page(authorB);
        const authorAPage = await page(authorA);
        expect(authorBPage.variant).toBe(authorAPage.variant);
        expect(authorBPage.html).toBe(authorAPage.html);
        expect(authorBPage.html).not.toContain("HELD-AUTHOR");

        const forA = await heldPostsForOverlay(database.sql, {
          memberId: authorA.memberId,
          topicId: topic.topicId,
          translate,
          sessionId: "0",
        });
        const forB = await heldPostsForOverlay(database.sql, {
          memberId: authorB.memberId,
          topicId: topic.topicId,
          translate,
          sessionId: "0",
        });
        expect(forA.map((post) => post.postId)).toEqual([heldA.postId]);
        expect(forB.map((post) => post.postId)).toEqual([heldB.postId]);

        const overlayForB = await overlayRequest(database, authorB.memberId, {
          ctx: `topic:${topic.topicId}`,
        });
        expect(overlayForB.status).toBe(200);
        const heldPosts = overlayForB.body.heldPosts as Array<{ postId: string }>;
        expect(heldPosts.map((post) => post.postId)).toEqual([heldB.postId]);

        const overlayForMod = await overlayRequest(database, moderator.memberId, {
          ctx: `topic:${topic.topicId}`,
        });
        expect((overlayForMod.body.heldPosts as unknown[]).length).toBe(0);
      } finally {
        await versions.close();
      }

      // The forum list hides both held replies and keeps its public counters.
      const listRows = (await database.sql`
        SELECT id FROM core.topics WHERE forum_id = ${offTopic} AND visibility = 'unapproved'
      `) as Array<{ id: string }>;
      expect(listRows).toHaveLength(0);
    });
  }, 60_000);

  test("approves and rejects held items in bulk, logs counts and denies non-moderators", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberSession(database, "member-2");
      const moderator = await memberSession(database, "super-mod");

      await database.sql`
        UPDATE core.forums SET require_approval_posts = true WHERE id = ${offTopic}
      `;
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: author.memberId,
          forumId: offTopic,
          title: "Bulk approval topic",
          bodyMd: "Opening body.",
        }),
      );
      const held: string[] = [];

      for (let index = 0; index < 10; index += 1) {
        const post = expectOk(
          await reply(database.sql, {
            actorId: author.memberId,
            topicId: topic.topicId,
            bodyMd: `Bulk held reply ${index}`,
          }),
        );
        held.push(post.postId);
      }

      const [beforeForum] = (await database.sql`
        SELECT post_count FROM core.forums WHERE id = ${offTopic}
      `) as Array<{ post_count: number }>;
      const queue = await listApprovalQueue(database.sql, {
        actorId: moderator.memberId,
        limit: 20,
        offset: 0,
      });
      expect(queue.total).toBe(10);
      expect(queue.items.map((item: ModerationQueueItem) => item.reason)).toEqual(
        Array.from({ length: 10 }, () => "forum"),
      );

      // A member without the approve power sees nothing and cannot act.
      expect(
        await listApprovalQueue(database.sql, {
          actorId: author.memberId,
          limit: 20,
          offset: 0,
        }),
      ).toMatchObject({ items: [], total: 0, forums: [] });
      expect(await pendingApprovalCount(database.sql, author.memberId)).toBe(0);
      expect(
        await approveHeldPosts(database.sql, {
          actorId: author.memberId,
          postIds: held,
        }),
      ).toEqual({ ok: false, code: "forbidden" });
      expect(
        await rejectHeldPosts(database.sql, {
          actorId: author.memberId,
          postIds: held,
        }),
      ).toEqual({ ok: false, code: "forbidden" });

      const approved = expectOk(
        await approveHeldPosts(database.sql, {
          actorId: moderator.memberId,
          postIds: held,
        }),
      );
      expect(approved.postIds).toHaveLength(10);
      const [afterForum] = (await database.sql`
        SELECT post_count FROM core.forums WHERE id = ${offTopic}
      `) as Array<{ post_count: number }>;
      const [afterTopic] = (await database.sql`
        SELECT reply_count FROM core.topics WHERE id = ${topic.topicId}
      `) as Array<{ reply_count: number }>;
      expect(afterForum?.post_count).toBe((beforeForum?.post_count ?? 0) + 10);
      expect(afterTopic?.reply_count).toBe(10);
      expect(await pendingApprovalCount(database.sql, moderator.memberId)).toBe(0);

      const rejected = expectOk(
        await reply(database.sql, {
          actorId: author.memberId,
          topicId: topic.topicId,
          bodyMd: "Reject this held reply",
        }),
      );
      expectOk(
        await rejectHeldPosts(database.sql, {
          actorId: moderator.memberId,
          postIds: [rejected.postId],
        }),
      );
      expect(
        (await database.sql`SELECT 1 FROM core.posts WHERE id = ${rejected.postId}`).length,
      ).toBe(0);
    });
  }, 60_000);

  test("rejection never deletes published content", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberId(database, "member-1");
      const moderator = await memberId(database, "super-mod");
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: offTopic,
          title: "Published rejection target",
          bodyMd: "This opening must survive.",
        }),
      );
      const replyPost = expectOk(
        await reply(database.sql, {
          actorId: author,
          topicId: topic.topicId,
          bodyMd: "This reply must survive too.",
        }),
      );

      const rejected = expectOk(
        await rejectHeldPosts(database.sql, {
          actorId: moderator,
          postIds: [topic.postId, replyPost.postId],
        }),
      );
      expect(rejected.postIds).toEqual([]);
      expect(
        (await database.sql`SELECT 1 FROM core.topics WHERE id = ${topic.topicId}`).length,
      ).toBe(1);
      expect((await database.sql`SELECT 1 FROM core.posts WHERE id = ${topic.postId}`).length).toBe(
        1,
      );
      expect(
        (await database.sql`SELECT 1 FROM core.posts WHERE id = ${replyPost.postId}`).length,
      ).toBe(1);
    });
  }, 60_000);

  test("serializes concurrent approval and rejection of the same held post", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberId(database, "new-member");
      const moderator = await memberId(database, "super-mod");

      await database.sql`UPDATE core.members SET post_count = 0 WHERE id = ${author}`;
      await database.sql`
        UPDATE core.board_settings SET new_member_approval_posts = 1 WHERE id = 1
      `;
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: offTopic,
          title: "Concurrent approval target",
          bodyMd: "Approve or reject exactly once.",
        }),
      );

      const [approved, rejected] = await Promise.all([
        approveHeldPosts(database.sql, {
          actorId: moderator,
          postIds: [topic.postId],
        }),
        rejectHeldPosts(database.sql, {
          actorId: moderator,
          postIds: [topic.postId],
        }),
      ]);
      expect(approved.ok).toBe(true);
      expect(rejected.ok).toBe(true);
      const approvedIds = approved.ok ? approved.result.postIds : [];
      const rejectedIds = rejected.ok ? rejected.result.postIds : [];
      expect(approvedIds.length + rejectedIds.length).toBe(1);

      const rows = (await database.sql`
        SELECT t.visibility AS topic_visibility, p.visibility AS post_visibility
        FROM core.topics t
        LEFT JOIN core.posts p ON p.topic_id = t.id
        WHERE t.id = ${topic.topicId}
      `) as Array<{ topic_visibility: string; post_visibility: string | null }>;

      if (approvedIds.length === 1) {
        expect(rows).toEqual([{ topic_visibility: "visible", post_visibility: "visible" }]);
      } else {
        expect(rows).toEqual([]);
        expect(
          (
            await database.sql`
            SELECT count(*)::int AS count FROM core.posts WHERE topic_id = ${topic.topicId}
          `
          )[0],
        ).toEqual({ count: 0 });
      }
    });
  }, 60_000);

  test("approval re-authorizes the topic's current forum after a concurrent move", async () => {
    await withSeededDb(async (database) => {
      const author = await memberId(database, "member-1");
      const replier = await memberId(database, "member-2");
      const moderator = await memberId(database, "forum-mod");
      const tree = await loadForumTree(database.sql);
      const moderated = new Set(
        (await moderatedForums(database.sql, moderator, null, tree)).map((forum) => forum.id),
      );
      const forums = (await database.sql`
        SELECT id::text AS id FROM core.forums WHERE type = 'forum' ORDER BY id
      `) as Array<{ id: string }>;
      const source = forums.find((forum) => moderated.has(forum.id));
      const destination = forums.find((forum) => !moderated.has(forum.id));

      if (source === undefined || destination === undefined) {
        throw new Error("Missing a moderated and an unmoderated forum");
      }

      await database.sql`
        UPDATE core.forums SET require_approval_posts = true WHERE id = ${source.id}
      `;
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: source.id,
          title: "Concurrent move approval topic",
          bodyMd: "Opening.",
        }),
      );
      const held = expectOk(
        await reply(database.sql, {
          actorId: replier,
          topicId: topic.topicId,
          bodyMd: "Hold this reply for the race.",
        }),
      );
      expect(
        (await database.sql`SELECT visibility FROM core.posts WHERE id = ${held.postId}`)[0],
      ).toMatchObject({ visibility: "unapproved" });

      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const moving = database.sql.begin(async (tx) => {
        await tx`UPDATE core.topics SET forum_id = ${destination.id} WHERE id = ${topic.topicId}`;
        await gate;
      });
      await Bun.sleep(50);
      const acting = approveHeldPosts(database.sql, {
        actorId: moderator,
        postIds: [held.postId],
      });
      await Bun.sleep(100);
      release();
      await moving;

      expect(await acting).toEqual({ ok: false, code: "forbidden" });
      expect(
        (await database.sql`SELECT visibility FROM core.posts WHERE id = ${held.postId}`)[0],
      ).toMatchObject({ visibility: "unapproved" });
    });
  }, 60_000);

  test("rejection re-authorizes the topic's current forum after a concurrent move", async () => {
    await withSeededDb(async (database) => {
      const author = await memberId(database, "member-1");
      const replier = await memberId(database, "member-2");
      const moderator = await memberId(database, "forum-mod");
      const tree = await loadForumTree(database.sql);
      const moderated = new Set(
        (await moderatedForums(database.sql, moderator, null, tree)).map((forum) => forum.id),
      );
      const forums = (await database.sql`
        SELECT id::text AS id FROM core.forums WHERE type = 'forum' ORDER BY id
      `) as Array<{ id: string }>;
      const source = forums.find((forum) => moderated.has(forum.id));
      const destination = forums.find((forum) => !moderated.has(forum.id));

      if (source === undefined || destination === undefined) {
        throw new Error("Missing a moderated and an unmoderated forum");
      }

      await database.sql`
        UPDATE core.forums SET require_approval_posts = true WHERE id = ${source.id}
      `;
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: source.id,
          title: "Concurrent move rejection topic",
          bodyMd: "Opening.",
        }),
      );
      const held = expectOk(
        await reply(database.sql, {
          actorId: replier,
          topicId: topic.topicId,
          bodyMd: "Reject this reply after the race.",
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
      const acting = rejectHeldPosts(database.sql, {
        actorId: moderator,
        postIds: [held.postId],
      });
      await Bun.sleep(100);
      release();
      await moving;

      expect(await acting).toEqual({ ok: false, code: "forbidden" });
      expect((await database.sql`SELECT 1 FROM core.posts WHERE id = ${held.postId}`).length).toBe(
        1,
      );
    });
  }, 60_000);

  test("delivers a held topic to its author through the forum overlay only", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberSession(database, "member-1");
      const other = await memberSession(database, "member-2");

      await database.sql`
        UPDATE core.forums SET require_approval_topics = true WHERE id = ${offTopic}
      `;
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: author.memberId,
          forumId: offTopic,
          title: "Held topic for its author",
          bodyMd: "Held opening body.",
        }),
      );

      const own = await heldTopicsForOverlay(database.sql, {
        memberId: author.memberId,
        forumId: offTopic,
        sessionId: "0",
      });
      const others = await heldTopicsForOverlay(database.sql, {
        memberId: other.memberId,
        forumId: offTopic,
        sessionId: "0",
      });
      expect(own.map((row) => row.topicId)).toEqual([topic.topicId]);
      expect(others).toEqual([]);

      const overlay = await overlayRequest(database, author.memberId, {
        ctx: `forum:${offTopic}`,
      });
      expect(overlay.status).toBe(200);
      expect(
        (overlay.body.heldTopics as Array<{ topicId: string }>).map((row) => row.topicId),
      ).toEqual([topic.topicId]);
    });
  }, 60_000);

  test("staff moderation routes and the dashboard widget are permission scoped", async () => {
    await withSeededDb(async (database) => {
      const moderator = await memberId(database, "super-mod");
      const member = await memberId(database, "member-1");
      const queueRoute = route("moderation.queue");
      const widgetRoute = route("dashboard.moderation");

      expect(queueRoute.permission).toBe("acp.members");
      expect(widgetRoute.permission).toBe("acp.members");

      const call = (actor: string, target: StaffRoute) => {
        const url = new URL(`http://staff.localhost${target.path}`);

        return authorizeStaffRoute(target, {
          request: new Request(url),
          url,
          session: { memberId: actor, lastAuthAt: new Date() } as SessionRecord,
          sql: database.sql,
          checks: [],
        });
      };

      expect((await call(member, queueRoute)).status).toBe(403);
      expect((await call(member, widgetRoute)).status).toBe(403);
      expect((await call(moderator, queueRoute)).status).toBe(200);
      expect(await (await call(moderator, widgetRoute)).json()).toEqual({ count: 0 });
    });
  }, 60_000);
});
