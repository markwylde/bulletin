import { describe, expect, test } from "bun:test";
import { createRenderCache, createTagVersions, readTagVersion } from "@bulletin/cache";
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
  flushTopicViews,
  move,
  readTopic,
  readTopicPageOfPost,
  reply,
  softDelete,
  startTopic,
} from "@bulletin/domain/topics";
import { createServerT } from "@bulletin/i18n";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { beaconResponse } from "../../apps/user-api/src/beacon.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import type { UserAppSessionContext } from "../../apps/user-app/src/session.ts";
import { renderTopicViewsFragment } from "../../apps/user-app/src/topics/fragments.ts";
import { renderTopicRoute } from "../../apps/user-app/src/topics/route.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "topic_routing" }, async (database) => {
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

integrationDescribe("topic routing, stubs, view counts and permalinks", () => {
  test("redirects stubs and old slugs, and drops expired stubs", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const bugReports = await forumId(database, "bug-reports");
      const moderator = await memberSession(database, "super-mod");
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const topic = expectOk(
          await startTopic(database.sql, {
            actorId: moderator.memberId,
            forumId: offTopic,
            title: "Moved topic",
            bodyMd: "Body.",
          }),
        );

        await expectOk(
          await move(database.sql, {
            actorId: moderator.memberId,
            topicId: topic.topicId,
            toForumId: bugReports,
            stubDays: 7,
          }),
        );
        const [stub] = (await database.sql`
          SELECT id::text AS id, slug FROM core.topics
          WHERE forum_id = ${offTopic} AND moved_to = ${topic.topicId}
        `) as Array<{ id: string; slug: string }>;

        if (stub === undefined) {
          throw new Error("Missing moved stub");
        }

        const moved = await renderTopicRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session: null,
          ref: `${stub.id}-${stub.slug}`,
          pluginsGeneration: 1,
          colourScheme: "system",
          cache,
          tagVersions: versions,
        });
        expect(moved).toMatchObject({
          kind: "redirect",
          status: 301,
          reason: "moved",
        });
        expect(moved.kind === "redirect" ? moved.location : "").toContain(
          `/topic/${topic.topicId}-moved-topic`,
        );

        await database.sql`
          UPDATE core.topics SET stub_expires_at = now() - interval '1 minute'
          WHERE id = ${stub.id}
        `;
        const expired = await renderTopicRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session: null,
          ref: `${stub.id}-${stub.slug}`,
          pluginsGeneration: 1,
          colourScheme: "system",
          cache,
          tagVersions: versions,
        });
        expect(expired.kind === "page" ? expired.status : 0).toBe(404);

        const wrongSlug = await renderTopicRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session: null,
          ref: `${topic.topicId}-not-the-slug`,
          pluginsGeneration: 1,
          colourScheme: "system",
          cache,
          tagVersions: versions,
        });
        expect(wrongSlug.kind).toBe("redirect");
        expect(wrongSlug.kind === "redirect" ? wrongSlug.location : "").toBe(
          `/topic/${topic.topicId}-moved-topic`,
        );
      } finally {
        await versions.close();
      }
    });
  }, 45_000);

  test("never redirects to restricted topics before authorisation", async () => {
    await withSeededDb(async (database) => {
      const staff = await forumId(database, "staff-room");
      const offTopic = await forumId(database, "off-topic");
      const moderator = await memberSession(database, "super-mod");
      const privateTopic = expectOk(
        await startTopic(database.sql, {
          actorId: moderator.memberId,
          forumId: staff,
          title: "Restricted redirect title",
          bodyMd: "Private.",
        }),
      );
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const direct = await renderTopicRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session: null,
          ref: `${privateTopic.topicId}-wrong-restricted-slug`,
          pluginsGeneration: 1,
          colourScheme: "system",
          cache,
          tagVersions: versions,
        });
        expect(direct.kind).toBe("page");
        expect(direct.kind === "page" ? direct.status : 0).toBe(404);

        const [stub] = (await database.sql`
          INSERT INTO core.topics (
            forum_id, title, slug, starter_id, locked, moved_to, stub_expires_at
          )
          VALUES (
            ${offTopic}, 'Restricted redirect title', 'restricted-redirect-title',
            ${moderator.memberId}, true, ${privateTopic.topicId}, now() + interval '1 day'
          )
          RETURNING id::text AS id
        `) as Array<{ id: string }>;

        if (stub === undefined) {
          throw new Error("Could not create the stub");
        }

        const moved = await renderTopicRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session: null,
          ref: `${stub.id}-restricted-redirect-title`,
          pluginsGeneration: 1,
          colourScheme: "system",
          cache,
          tagVersions: versions,
        });
        expect(moved.kind).toBe("page");
        expect(moved.kind === "page" ? moved.status : 0).toBe(404);
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("hidden topics are unreachable directly without visibility", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const member = await memberSession(database, "member-1");
      const moderator = await memberSession(database, "super-mod");
      const hidden = expectOk(
        await startTopic(database.sql, {
          actorId: member.memberId,
          forumId: offTopic,
          title: "Hidden topic title",
          bodyMd: "Hidden body.",
        }),
      );

      const [hiddenRow] = (await database.sql`
        SELECT slug FROM core.topics WHERE id = ${hidden.topicId}
      `) as Array<{ slug: string }>;
      await database.sql`
        UPDATE core.posts SET visibility = 'unapproved' WHERE topic_id = ${hidden.topicId}
      `;
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
            ref: `${hidden.topicId}-${hiddenRow?.slug ?? ""}`,
            pluginsGeneration: 1,
            colourScheme: "system",
            cache,
            tagVersions: versions,
          });

        const guest = await render(null);
        expect(guest.kind).toBe("page");
        expect(guest.kind === "page" ? guest.status : 0).toBe(404);

        const ordinary = await render(member);
        expect(ordinary.kind).toBe("page");
        expect(ordinary.kind === "page" ? ordinary.status : 0).toBe(404);
        expect(ordinary.kind === "page" ? ordinary.html : "").not.toContain("Hidden topic title");

        const visibleToModerator = await render(moderator);
        expect(visibleToModerator.kind).toBe("page");
        expect(visibleToModerator.kind === "page" ? visibleToModerator.status : 0).toBe(200);
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("counts a guest view once per bucket and flushes without bumping the content tag", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const member = await memberSession(database, "member-1");
      const now = new Date("2026-11-10T12:00:00Z");
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: member.memberId,
          forumId: offTopic,
          title: "Viewed topic",
          bodyMd: "Body.",
        }),
      );
      const contentTagBefore = await readTagVersion(database.sql, `topic:${topic.topicId}`);

      const beaconRequest = (cookie?: string) =>
        new Request("http://bulletin.localhost/api/beacon", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": "203.0.113.5",
            ...(cookie === undefined ? {} : { cookie }),
          },
          body: JSON.stringify({ ctx: `topic:${topic.topicId}` }),
        });
      const beacon = (request: Request, offsetMs: number) =>
        beaconResponse(database.sql, request, {
          session: null,
          nodeEnv: "test",
          rateLimitSecret: "test-secret",
          now: new Date(now.getTime() + offsetMs),
        });

      const firstBeacon = await beacon(beaconRequest(), 0);
      expect(firstBeacon.status).toBe(204);
      const cookie = firstBeacon.headers.get("set-cookie")?.split(";")[0];
      expect(cookie).toBeDefined();
      expect((await beacon(beaconRequest(cookie), 60_000)).status).toBe(204);

      const [buffered] = (await database.sql`
        SELECT count(*)::int AS count FROM core.topic_view_buffer
        WHERE topic_id = ${topic.topicId}
      `) as Array<{ count: number }>;
      expect(buffered?.count).toBe(1);

      expect(await flushTopicViews(database.sql)).toBe(1);
      expect((await readTopic(database.sql, topic.topicId))?.viewCount).toBe("1");
      expect(await readTagVersion(database.sql, `topic:${topic.topicId}`)).toBe(contentTagBefore);

      // A reload in the same 30-minute bucket is still deduplicated after the flush.
      expect((await beacon(beaconRequest(cookie), 120_000)).status).toBe(204);
      expect(await flushTopicViews(database.sql)).toBe(0);
      expect((await readTopic(database.sql, topic.topicId))?.viewCount).toBe("1");
    });
  }, 30_000);

  test("the view fragment expires after sixty seconds so a flush becomes visible", async () => {
    await withSeededDb(async (database) => {
      let now = new Date("2026-11-10T12:00:00Z");
      const member = await memberSession(database, "member-1");
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: member.memberId,
          forumId: await forumId(database, "off-topic"),
          title: "View fragment topic",
          bodyMd: "Body.",
        }),
      );
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions, now: () => now.getTime() });
        const first = await renderTopicViewsFragment(
          database.sql,
          cache,
          topic.topicId,
          "en",
          translate,
        );
        expect(first).toContain(">0 views<");

        await beaconResponse(
          database.sql,
          new Request("http://bulletin.localhost/api/beacon", {
            method: "POST",
            headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
            body: JSON.stringify({ ctx: `topic:${topic.topicId}` }),
          }),
          { session: null, nodeEnv: "test", rateLimitSecret: "view-secret", now },
        );
        expect(await flushTopicViews(database.sql)).toBe(1);

        const warm = await renderTopicViewsFragment(
          database.sql,
          cache,
          topic.topicId,
          "en",
          translate,
        );
        expect(warm).toContain(">0 views<");

        now = new Date(now.getTime() + 61_000);
        const refreshed = await renderTopicViewsFragment(
          database.sql,
          cache,
          topic.topicId,
          "en",
          translate,
        );
        expect(refreshed).toContain(">1 view<");
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("a post permalink lands on the viewer's page after earlier posts are deleted", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const member = await memberSession(database, "member-1");
      const moderator = await memberSession(database, "super-mod");
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: member.memberId,
          forumId: offTopic,
          title: "Permalink topic",
          bodyMd: "First post.",
        }),
      );
      const posts: string[] = [topic.postId];

      for (const body of ["Second post.", "Third post."]) {
        const replyResult = expectOk(
          await reply(database.sql, {
            actorId: member.memberId,
            topicId: topic.topicId,
            bodyMd: body,
          }),
        );
        posts.push(replyResult.postId);
      }

      const second = posts[1];
      const third = posts[2];

      if (second === undefined || third === undefined) {
        throw new Error("Missing seeded posts");
      }

      await expectOk(
        await softDelete(database.sql, { actorId: moderator.memberId, postId: second }),
      );
      await database.sql`UPDATE core.board_settings SET posts_per_page = 1 WHERE id = 1`;

      expect(
        await readTopicPageOfPost(database.sql, {
          topicId: topic.topicId,
          postId: third,
          perPage: 1,
          seeUnapproved: false,
          seeDeleted: false,
        }),
      ).toMatchObject({ page: 2, before: 1 });

      expect(
        await readTopicPageOfPost(database.sql, {
          topicId: topic.topicId,
          postId: third,
          perPage: 1,
          seeUnapproved: true,
          seeDeleted: true,
        }),
      ).toMatchObject({ page: 3, before: 2 });

      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const memberRedirect = await renderTopicRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session: member,
          ref: `${topic.topicId}-permalink-topic/post/${third}`,
          pluginsGeneration: 1,
          colourScheme: "system",
          cache,
          tagVersions: versions,
        });
        expect(memberRedirect.kind).toBe("redirect");
        expect(memberRedirect.kind === "redirect" ? memberRedirect.location : "").toBe(
          `/topic/${topic.topicId}-permalink-topic/page/2#post-${third}`,
        );

        const moderatorRedirect = await renderTopicRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session: moderator,
          ref: `${topic.topicId}-permalink-topic/post/${third}`,
          pluginsGeneration: 1,
          colourScheme: "system",
          cache,
          tagVersions: versions,
        });
        expect(moderatorRedirect.kind).toBe("redirect");
        expect(moderatorRedirect.kind === "redirect" ? moderatorRedirect.location : "").toBe(
          `/topic/${topic.topicId}-permalink-topic/page/3#post-${third}`,
        );
      } finally {
        await versions.close();
      }
    });
  }, 45_000);
});
