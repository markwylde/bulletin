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
import type { SessionRecord } from "@bulletin/domain/auth";
import { createAuthService, hashToken, sessionCookieName } from "@bulletin/domain/auth";
import {
  autoFollowTopicsEnabled,
  follow,
  followedTargets,
  listFollows,
  setAutoFollowTopics,
  unfollow,
} from "@bulletin/domain/follows";
import { bumpPermVersion, forumActionMask } from "@bulletin/domain/permissions";
import { reply, startTopic } from "@bulletin/domain/topics";
import { createServerT } from "@bulletin/i18n";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { authIssuer, userOrigin } from "@bulletin/test-utils/urls";
import { SQL } from "bun";
import { followResponse, followSettingsResponse } from "../../apps/user-api/src/follows.ts";
import { buildFollowsPage } from "../../apps/user-app/src/account/follows.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { renderTopicRoute } from "../../apps/user-app/src/topics/route.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const SESSION_SECRET = "follows-test-secret";
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "follows" }, async (database) => {
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

function session(memberIdValue: string): SessionRecord {
  return {
    id: "1",
    memberId: memberIdValue,
    kind: "user",
    displayName: null,
    createdAt: new Date(),
    lastSeenAt: new Date(),
    reauthAt: new Date(Date.now() + 60_000),
    lastAuthAt: new Date(),
    reauthRetryCount: 0,
    revokedAt: null,
    rotatePending: false,
    viaPreviousToken: false,
    previousTokenExpiresAt: null,
  };
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function followedRows(database: TestDatabase, memberIdValue: string) {
  const [topics, forums, members] = await Promise.all([
    database.sql`
      SELECT topic_id::text AS id FROM core.followed_topics
      WHERE member_id = ${memberIdValue} ORDER BY topic_id
    ` as Promise<Array<{ id: string }>>,
    database.sql`
      SELECT forum_id::text AS id FROM core.followed_forums
      WHERE member_id = ${memberIdValue} ORDER BY forum_id
    ` as Promise<Array<{ id: string }>>,
    database.sql`
      SELECT followed_id::text AS id FROM core.followed_members
      WHERE follower_id = ${memberIdValue} ORDER BY followed_id
    ` as Promise<Array<{ id: string }>>,
  ]);

  return {
    topics: topics.map((row) => row.id),
    forums: forums.map((row) => row.id),
    members: members.map((row) => row.id),
  };
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
  const token = `follows-${crypto.randomUUID()}`;
  await database.sql`
    INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
    VALUES (${memberIdValue}, 'user', ${hashToken(token)}, now() + interval '1 day')
  `;
  return `${sessionCookieName("user", "test")}=${token}`;
}

integrationDescribe("follows", () => {
  test("follows and unfollows topics, forums and members", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const other = await memberId(database, "member-2");
      const forum = await forumId(database, "off-topic");
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: other,
          forumId: forum,
          title: "A topic to follow",
          bodyMd: "Body.",
        }),
      );

      expect(
        await follow(database.sql, { memberId: member, kind: "topic", id: topic.topicId }),
      ).toEqual({
        ok: true,
      });
      expect(await follow(database.sql, { memberId: member, kind: "forum", id: forum })).toEqual({
        ok: true,
      });
      expect(await follow(database.sql, { memberId: member, kind: "member", id: other })).toEqual({
        ok: true,
      });
      // Following twice stays a single row.
      await follow(database.sql, { memberId: member, kind: "topic", id: topic.topicId });

      expect(await followedRows(database, member)).toEqual({
        topics: [topic.topicId],
        forums: [forum],
        members: [other],
      });

      await unfollow(database.sql, { memberId: member, kind: "topic", id: topic.topicId });
      await unfollow(database.sql, { memberId: member, kind: "forum", id: forum });
      await unfollow(database.sql, { memberId: member, kind: "member", id: other });

      expect(await followedRows(database, member)).toEqual({
        topics: [],
        forums: [],
        members: [],
      });
    });
  }, 30_000);

  test("denies inaccessible content without revealing it", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const staffRoom = await forumId(database, "staff-room");
      const admin = await memberId(database, "admin");
      const hiddenTopic = expectOk(
        await startTopic(database.sql, {
          actorId: admin,
          forumId: staffRoom,
          title: "Staff only topic",
          bodyMd: "Hidden.",
        }),
      );

      expect(
        await follow(database.sql, { memberId: member, kind: "forum", id: staffRoom }),
      ).toEqual({ ok: false, code: "not_found" });
      expect(
        await follow(database.sql, { memberId: member, kind: "topic", id: hiddenTopic.topicId }),
      ).toEqual({ ok: false, code: "not_found" });
      expect(await follow(database.sql, { memberId: member, kind: "topic", id: "999999" })).toEqual(
        { ok: false, code: "not_found" },
      );
      expect(await follow(database.sql, { memberId: member, kind: "member", id: member })).toEqual({
        ok: false,
        code: "self",
      });

      expect(await followedRows(database, member)).toEqual({
        topics: [],
        forums: [],
        members: [],
      });
    });
  }, 30_000);

  test("auto-follows on participation and respects the member's preference", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");

      expect(await autoFollowTopicsEnabled(database.sql, member)).toBe(true);

      const started = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Auto-follow on start",
          bodyMd: "Body.",
        }),
      );

      expect((await followedRows(database, member)).topics).toEqual([started.topicId]);

      const replied = expectOk(
        await startTopic(database.sql, {
          actorId: await memberId(database, "member-2"),
          forumId: forum,
          title: "Auto-follow on reply",
          bodyMd: "Body.",
        }),
      );
      await reply(database.sql, {
        actorId: member,
        topicId: replied.topicId,
        bodyMd: "A reply.",
      });

      expect((await followedRows(database, member)).topics.sort()).toEqual(
        [started.topicId, replied.topicId].sort(),
      );

      await setAutoFollowTopics(database.sql, member, false);
      expect(await autoFollowTopicsEnabled(database.sql, member)).toBe(false);

      const ignored = expectOk(
        await reply(database.sql, {
          actorId: member,
          topicId: replied.topicId,
          bodyMd: "Another reply.",
        }),
      );
      expect(await followedRows(database, member)).toEqual({
        topics: [started.topicId, replied.topicId].sort(),
        forums: [],
        members: [],
      });
      expect(ignored.postId.length).toBeGreaterThan(0);
    });
  }, 30_000);

  test("lists every follow and marks inaccessible ones unavailable", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "super-mod");
      const admin = await memberId(database, "admin");
      const staffRoom = await forumId(database, "staff-room");
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: admin,
          forumId: staffRoom,
          title: "Staff topic for follows",
          bodyMd: "Body.",
        }),
      );

      expect(
        await follow(database.sql, { memberId: member, kind: "forum", id: staffRoom }),
      ).toEqual({ ok: true });
      expect(
        await follow(database.sql, { memberId: member, kind: "topic", id: topic.topicId }),
      ).toEqual({ ok: true });
      expect(await follow(database.sql, { memberId: member, kind: "member", id: admin })).toEqual({
        ok: true,
      });

      const before = await listFollows(database.sql, member);
      expect(before.forums[0]).toMatchObject({ id: staffRoom, available: true });
      expect(before.topics[0]).toMatchObject({ id: topic.topicId, available: true });
      expect(before.members).toEqual([
        expect.objectContaining({ id: admin, displayName: "Admin" }),
      ]);

      // The forum becomes hidden to the staff mask after the follow was created.
      await database.sql`
        UPDATE core.forum_permissions fp
        SET actions = ${forumActionMask(["show"])}
        FROM core.forums f, core.masks m
        WHERE fp.forum_id = f.id AND fp.mask_id = m.id
          AND f.slug = 'staff-area' AND m.key = 'staff'
      `;
      await bumpPermVersion(database.sql);

      const after = await listFollows(database.sql, member);
      expect(after.forums[0]).toMatchObject({ id: staffRoom, available: false });
      expect(after.topics[0]).toMatchObject({ id: topic.topicId, available: false });
      expect(after.members).toHaveLength(1);

      const page = await buildFollowsPage({
        sql: database.sql,
        memberId: member,
        sessionId: null,
        locale: "en",
        translate,
      });
      expect(page.viewModel.hasTopics).toBe(true);
      expect(page.viewModel.hasForums).toBe(true);
      expect(page.viewModel.hasMembers).toBe(true);
      expect(page.viewModel.topics[0]).toMatchObject({ available: false });
      expect(page.viewModel.forums[0]).toMatchObject({ available: false });
      expect(page.viewModel.members[0]?.href).toMatch(/^\/profile\/\d+-admin$/);
    });
  }, 30_000);

  test("only the follower's rows are listed", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const other = await memberId(database, "member-2");
      const forum = await forumId(database, "off-topic");

      await follow(database.sql, { memberId: member, kind: "forum", id: forum });

      expect(await listFollows(database.sql, other)).toEqual({
        topics: [],
        forums: [],
        members: [],
      });
    });
  }, 30_000);

  test("the API follows readable targets and denies the rest", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");
      const staffRoom = await forumId(database, "staff-room");

      const followed = await followResponse(
        database.sql,
        session(member),
        jsonRequest("http://user.test/api/follows", {
          kind: "forum",
          id: forum,
          following: true,
        }),
      );
      expect(followed.status).toBe(200);
      expect(await followed.json()).toEqual({ ok: true, following: true });

      const denied = await followResponse(
        database.sql,
        session(member),
        jsonRequest("http://user.test/api/follows", {
          kind: "forum",
          id: staffRoom,
          following: true,
        }),
      );
      expect(denied.status).toBe(404);

      const self = await followResponse(
        database.sql,
        session(member),
        jsonRequest("http://user.test/api/follows", {
          kind: "member",
          id: member,
          following: true,
        }),
      );
      expect(self.status).toBe(400);

      const invalid = await followResponse(
        database.sql,
        session(member),
        jsonRequest("http://user.test/api/follows", { kind: "board", id: forum, following: true }),
      );
      expect(invalid.status).toBe(400);

      // An inaccessible follow can still be removed, so the member can clean up.
      await database.sql`
        INSERT INTO core.followed_forums (member_id, forum_id) VALUES (${member}, ${staffRoom})
      `;
      const removed = await followResponse(
        database.sql,
        session(member),
        jsonRequest("http://user.test/api/follows", {
          kind: "forum",
          id: staffRoom,
          following: false,
        }),
      );
      expect(removed.status).toBe(200);
      expect(await followedRows(database, member)).toEqual({
        topics: [],
        forums: [forum],
        members: [],
      });
    });
  }, 30_000);

  test("the API saves the auto-follow preference", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");

      const saved = await followSettingsResponse(
        database.sql,
        session(member),
        jsonRequest("http://user.test/api/me/follow-settings", { autoFollowTopics: false }),
      );
      expect(saved.status).toBe(200);
      expect(await saved.json()).toEqual({ ok: true, autoFollowTopics: false });
      expect(await autoFollowTopicsEnabled(database.sql, member)).toBe(false);

      const invalid = await followSettingsResponse(
        database.sql,
        session(member),
        jsonRequest("http://user.test/api/me/follow-settings", { autoFollowTopics: "no" }),
      );
      expect(invalid.status).toBe(400);
    });
  }, 30_000);

  test("grants follows to the app role read-only and to workers for fan-out", async () => {
    await withSeededDb(async ({ sql }) => {
      const [privileges] = (await sql`
        SELECT
          has_table_privilege('user_app', 'core.followed_topics', 'SELECT') AS app_read,
          has_table_privilege('user_app', 'core.followed_topics', 'INSERT') AS app_insert,
          has_table_privilege('user_api', 'core.followed_topics', 'INSERT') AS api_insert,
          has_table_privilege('user_api', 'core.followed_topics', 'DELETE') AS api_delete,
          has_table_privilege('workers', 'core.followed_topics', 'SELECT') AS workers_read,
          has_table_privilege('user_api', 'core.follow_settings', 'UPDATE') AS api_settings_update
      `) as Array<Record<string, boolean>>;

      expect(privileges).toEqual({
        app_read: true,
        app_insert: false,
        api_insert: true,
        api_delete: true,
        workers_read: true,
        api_settings_update: true,
      });
    });
  }, 30_000);

});
