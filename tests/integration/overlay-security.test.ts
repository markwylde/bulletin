import { describe, expect, test } from "bun:test";
import {
  baseSeedModule,
  flagsSeedModule,
  forumExtrasSeedModule,
  groupsSeedModule,
  membersSeedModule,
  moderatorAssignmentsSeedModule,
  permissionFixtureSeedModule,
  reactionsSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import { createAuthService, hashToken, sessionCookieName } from "@bulletin/domain/auth";
import { setReaction } from "@bulletin/domain/reactions";
import { markBoardRead, reply, startTopic } from "@bulletin/domain/topics";
import { memberViewerKey, recordVisit } from "@bulletin/domain/visits";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { authIssuer, userOrigin } from "@bulletin/test-utils/urls";
import { SQL } from "bun";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const SESSION_SECRET = "overlay-security-secret";

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "overlay_security" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        flagsSeedModule,
        permissionFixtureSeedModule,
        reactionsSeedModule,
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

async function overlayAuth(database: TestDatabase) {
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
    sessionSecret: SESSION_SECRET,
    nodeEnv: "test",
    cacheTtlMs: 0,
  });

  return {
    auth,
    close: async () => {
      await auth.close();
      await sql.close();
    },
  };
}

async function sessionCookie(database: TestDatabase, memberIdValue: string): Promise<string> {
  const token = `overlay-${crypto.randomUUID()}`;
  await database.sql`
    INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
    VALUES (${memberIdValue}, 'user', ${hashToken(token)}, now() + interval '1 day')
  `;
  return `${sessionCookieName("user", "test")}=${token}`;
}

async function overlay(
  auth: Awaited<ReturnType<typeof overlayAuth>>["auth"],
  cookie: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return (
    (await auth.handle(
      new Request(`${userOrigin()}/api/me/overlay`, {
        method: "POST",
        headers: {
          cookie,
          origin: userOrigin(),
          "content-type": "application/json",
          "x-bulletin-overlay": "1",
        },
        body: JSON.stringify(body),
      }),
    )) ?? new Response(null, { status: 500 })
  );
}

integrationDescribe("overlay security and unread state", () => {
  test("filters forged private topic, forum and post ids", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const moderator = await memberId(database, "super-mod");
      const staff = await forumId(database, "staff-room");
      const offTopic = await forumId(database, "off-topic");
      const privateTopic = await startTopic(database.sql, {
        actorId: moderator,
        forumId: staff,
        title: "Overlay private topic",
        bodyMd: "Private body.",
      });
      const publicTopic = await startTopic(database.sql, {
        actorId: member,
        forumId: offTopic,
        title: "Overlay public topic",
        bodyMd: "Public body.",
      });

      if (!privateTopic.ok || !publicTopic.ok) {
        throw new Error("Could not create the topics");
      }

      const auth = await overlayAuth(database);
      const cookie = await sessionCookie(database, member);

      try {
        const privateCtx = await overlay(auth.auth, cookie, {
          ctx: `topic:${privateTopic.result.topicId}`,
        });
        expect(privateCtx.status).toBe(404);

        const response = await overlay(auth.auth, cookie, {
          ctx: `forum:${offTopic}`,
          topics: [privateTopic.result.topicId, publicTopic.result.topicId],
          forums: [staff, offTopic],
          posts: [privateTopic.result.postId, publicTopic.result.postId],
        });
        expect(response.status).toBe(200);
        const payload = (await response.json()) as {
          unread: string[];
          unreadForums: string[];
          firstUnread: Array<{ topicId: string }>;
          editablePosts: Array<{ postId: string }>;
        };

        expect(payload.unread).not.toContain(privateTopic.result.topicId);
        expect(payload.unreadForums).not.toContain(staff);
        expect(payload.firstUnread.map((entry) => entry.topicId)).not.toContain(
          privateTopic.result.topicId,
        );
        expect(payload.editablePosts.map((entry) => entry.postId)).toEqual([
          publicTopic.result.postId,
        ]);
        expect(payload.editablePosts[0]).toMatchObject({ bodyMd: "Public body." });
      } finally {
        await auth.close();
      }
    });
  }, 30_000);

  test("delivers the member's own reaction and own posts through the overlay", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const replier = await memberId(database, "member-2");
      const offTopic = await forumId(database, "off-topic");
      const topic = await startTopic(database.sql, {
        actorId: member,
        forumId: offTopic,
        title: "Overlay reaction topic",
        bodyMd: "My own body.",
      });

      if (!topic.ok) {
        throw new Error("Could not create the topic");
      }

      const answer = await reply(database.sql, {
        actorId: replier,
        topicId: topic.result.topicId,
        bodyMd: "Someone else's body.",
      });

      if (!answer.ok) {
        throw new Error("Could not reply");
      }

      const [reaction] = (await database.sql`
        SELECT id::text AS id FROM core.reactions WHERE key = 'like'
      `) as Array<{ id: string }>;

      if (reaction === undefined) {
        throw new Error("Missing the like reaction");
      }

      await setReaction(database.sql, {
        actorId: member,
        postId: answer.result.postId,
        reactionId: reaction.id,
      });

      const auth = await overlayAuth(database);
      const cookie = await sessionCookie(database, member);

      try {
        const response = await overlay(auth.auth, cookie, {
          ctx: `topic:${topic.result.topicId}`,
          posts: [topic.result.postId, answer.result.postId],
        });
        expect(response.status).toBe(200);
        const payload = (await response.json()) as {
          reactions: Array<{ postId: string; reactionId: string | null; own: boolean }>;
        };

        expect(payload.reactions).toEqual([
          { postId: topic.result.postId, reactionId: null, own: true },
          { postId: answer.result.postId, reactionId: reaction.id, own: false },
        ]);
      } finally {
        await auth.close();
      }
    });
  }, 30_000);

  test("first unread uses a post permalink so moderators land on the right page", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-2");
      const author = await memberId(database, "member-1");
      const offTopic = await forumId(database, "off-topic");
      const topic = await startTopic(database.sql, {
        actorId: author,
        forumId: offTopic,
        title: "Overlay permalink topic",
        bodyMd: "First body.",
      });

      if (!topic.ok) {
        throw new Error("Could not create the topic");
      }

      const second = await reply(database.sql, {
        actorId: author,
        topicId: topic.result.topicId,
        bodyMd: "Second body.",
      });

      if (!second.ok) {
        throw new Error("Could not reply");
      }

      const [firstPost] = (await database.sql`
        SELECT created_at FROM core.posts WHERE id = ${topic.result.postId}
      `) as Array<{ created_at: Date }>;

      if (firstPost === undefined) {
        throw new Error("Missing first post");
      }

      await recordVisit(database.sql, {
        viewerKey: memberViewerKey(member),
        ctx: `topic:${topic.result.topicId}`,
        memberId: member,
        lastReadAt: firstPost.created_at,
        lastReadPostId: topic.result.postId,
      });

      const auth = await overlayAuth(database);
      const cookie = await sessionCookie(database, member);

      try {
        const response = await overlay(auth.auth, cookie, {
          ctx: `forum:${offTopic}`,
          topics: [topic.result.topicId],
          forums: [offTopic],
        });
        expect(response.status).toBe(200);
        const payload = (await response.json()) as {
          firstUnread: Array<{ topicId: string; url: string }>;
        };
        const entry = payload.firstUnread.find((row) => row.topicId === topic.result.topicId);
        expect(entry?.url).toMatch(new RegExp(`/topic/\\d+[^/]*/post/${second.result.postId}$`));
      } finally {
        await auth.close();
      }
    });
  }, 30_000);

  test("unread is timestamp-based and mark-all-read clears unvisited topics", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-2");
      const author = await memberId(database, "member-1");
      const offTopic = await forumId(database, "off-topic");
      const topic = await startTopic(database.sql, {
        actorId: author,
        forumId: offTopic,
        title: "Overlay unread topic",
        bodyMd: "First body.",
      });

      if (!topic.ok) {
        throw new Error("Could not create the topic");
      }

      const auth = await overlayAuth(database);
      const cookie = await sessionCookie(database, member);

      try {
        expect(
          (await overlay(auth.auth, cookie, { ctx: `topic:${topic.result.topicId}` })).status,
        ).toBe(200);

        const added = await reply(database.sql, {
          actorId: author,
          topicId: topic.result.topicId,
          bodyMd: "New reply.",
        });
        expect(added.ok).toBe(true);

        const unread = await overlay(auth.auth, cookie, {
          ctx: `forum:${offTopic}`,
          topics: [topic.result.topicId],
        });
        expect(((await unread.json()) as { unread: string[] }).unread).toContain(
          topic.result.topicId,
        );

        await markBoardRead(database.sql, member);
        const read = await overlay(auth.auth, cookie, {
          ctx: `forum:${offTopic}`,
          topics: [topic.result.topicId],
        });
        expect(((await read.json()) as { unread: string[] }).unread).toEqual([]);
      } finally {
        await auth.close();
      }
    });
  }, 30_000);
});
