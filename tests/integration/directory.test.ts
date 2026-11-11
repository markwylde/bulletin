import { describe, expect, test } from "bun:test";
import { createRenderCache, createTagVersions } from "@bulletin/cache";
import {
  baseSeedModule,
  flagsSeedModule,
  forumExtrasSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
  topicsSeedModule,
} from "@bulletin/db/seed";
import { readBoardStatistics } from "@bulletin/domain/forums";
import {
  guestReadableForumIds,
  readLeaderboard,
  readTodayTopPoster,
  recomputeLeaderboards,
} from "@bulletin/domain/leaderboards";
import { listMembers } from "@bulletin/domain/member";
import {
  bumpPermVersion,
  GUEST_PRINCIPAL,
  loadForumTree,
  loadPermissionSnapshot,
} from "@bulletin/domain/permissions";
import { readOnlineOverview, updateOnlineRecord } from "@bulletin/domain/presence";
import { saveMemberProfile } from "@bulletin/domain/profiles";
import { recordVisit } from "@bulletin/domain/visits";
import { createServerT } from "@bulletin/i18n";
import { assertCacheVariants, type VariantCase } from "@bulletin/test-utils/cache-variants";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { renderHomeRoute } from "../../apps/user-app/src/home/route.ts";
import { isNotModified } from "../../apps/user-app/src/http/cache.ts";
import { renderLeaderboardRoute } from "../../apps/user-app/src/leaderboards/route.ts";
import { renderOnlineRoute } from "../../apps/user-app/src/members/online-route.ts";
import { renderMemberListRoute } from "../../apps/user-app/src/members/route.ts";
import type { UserAppSessionContext } from "../../apps/user-app/src/session.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "directory" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        permissionFixtureSeedModule,
        forumExtrasSeedModule,
        groupsSeedModule,
        membersSeedModule,
        topicsSeedModule,
        flagsSeedModule,
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

async function session(database: TestDatabase, sub: string): Promise<UserAppSessionContext> {
  const [row] = (await database.sql`
    SELECT i.member_id::text AS member_id, m.display_name
    FROM pii.identities i
    JOIN core.members m ON m.id = i.member_id
    WHERE i.sub = ${sub}
  `) as Array<{ member_id: string; display_name: string | null }>;

  if (row === undefined) {
    throw new Error(`Missing session ${sub}`);
  }

  return {
    memberId: row.member_id,
    sessionId: "0",
    reauthAt: new Date().toISOString(),
    locale: "en",
    displayName: row.display_name,
  };
}

async function htmlOf(
  result:
    | Awaited<ReturnType<typeof renderMemberListRoute>>
    | Awaited<ReturnType<typeof renderOnlineRoute>>,
): Promise<string> {
  return result.html;
}

integrationDescribe("member directory", () => {
  test("member list filters by group, excludes opt-outs and honours pagination", async () => {
    await withDb(async (database) => {
      const moderatorGroup = (await database.sql`
        SELECT id::text AS id FROM core.groups WHERE key = 'moderators'
      `) as Array<{ id: string }>;
      const memberTwo = await memberId(database, "member-2");

      await database.sql`
        UPDATE core.members SET hide_from_member_list = true WHERE id = ${memberTwo}
      `;

      const guestPage = await listMembers(database.sql, {
        query: "",
        groupId: null,
        joinedFrom: null,
        joinedTo: null,
        sort: "name",
        direction: "asc",
        page: 1,
        includeHidden: false,
      });
      expect(guestPage.members.some((member) => member.id === memberTwo)).toBe(false);

      const staffPage = await listMembers(database.sql, {
        query: "",
        groupId: null,
        joinedFrom: null,
        joinedTo: null,
        sort: "name",
        direction: "asc",
        page: 1,
        includeHidden: true,
      });
      expect(staffPage.members.some((member) => member.id === memberTwo)).toBe(true);

      const filtered = await listMembers(database.sql, {
        query: "",
        groupId: moderatorGroup[0]?.id ?? null,
        joinedFrom: null,
        joinedTo: null,
        sort: "name",
        direction: "asc",
        page: 1,
        includeHidden: true,
      });
      expect(filtered.members.length).toBeGreaterThan(0);
      expect(filtered.members.every((member) => member.groupTitle === "Moderators")).toBe(true);

      // Fill a second page with synthetic members.
      for (let index = 0; index < 30; index += 1) {
        await database.sql`
          INSERT INTO core.members (display_name, name_skeleton)
          VALUES (${`Page Member ${index}`}, ${`page member ${index}`})
        `;
      }

      const first = await listMembers(database.sql, {
        query: "Page Member",
        groupId: null,
        joinedFrom: null,
        joinedTo: null,
        sort: "name",
        direction: "asc",
        page: 1,
        includeHidden: false,
      });
      const second = await listMembers(database.sql, {
        query: "Page Member",
        groupId: null,
        joinedFrom: null,
        joinedTo: null,
        sort: "name",
        direction: "asc",
        page: 2,
        includeHidden: false,
      });
      expect(first.members).toHaveLength(24);
      expect(first.pageCount).toBe(2);
      expect(second.members).toHaveLength(6);
      expect(
        second.members.some((member) => first.members.some((entry) => entry.id === member.id)),
      ).toBe(false);
    });
  }, 30_000);

  test("the member list route denies a group without members.view_list", async () => {
    await withDb(async (database) => {
      const [denied] = (await database.sql`
        INSERT INTO core.members (display_name, name_skeleton)
        VALUES ('No List Member', 'no list member')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;
      const [group] = (await database.sql`
        INSERT INTO core.groups (key, title) VALUES ('no_list', 'No List')
        ON CONFLICT (key) DO UPDATE SET title = EXCLUDED.title
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (denied === undefined || group === undefined) {
        throw new Error("Could not create the denied fixture");
      }

      await database.sql`
        INSERT INTO core.member_groups (member_id, group_id, is_primary)
        VALUES (${denied.id}, ${group.id}, true)
      `;

      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const result = await renderMemberListRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session: {
            memberId: denied.id,
            sessionId: "0",
            reauthAt: new Date().toISOString(),
            locale: "en",
            displayName: "No List Member",
          },
          params: new URLSearchParams(),
          pluginsGeneration: 1,
          colourScheme: "system",
          cache,
          tagVersions: versions,
        });
        expect(result.status).toBe(403);

        const guest = await renderMemberListRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session: null,
          params: new URLSearchParams(),
          pluginsGeneration: 1,
          colourScheme: "system",
          cache,
          tagVersions: versions,
        });
        expect(guest.status).toBe(200);
        expect(guest.html).toContain("data-member-list");
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("online counts include guests and filter hidden members and locations", async () => {
    await withDb(async (database) => {
      const memberOne = await memberId(database, "member-1");
      const memberTwo = await memberId(database, "member-2");
      const staffRoom = await forumId(database, "staff-room");
      const admin = await session(database, "admin");

      await database.sql`
        UPDATE core.members SET hide_online = true WHERE id = ${memberOne}
      `;
      await database.sql`
        INSERT INTO core.presence (viewer_key, location, last_seen)
        VALUES
          (${`member:${memberOne}`}, ${`forum:${staffRoom}`}, now()),
          (${`member:${memberTwo}`}, ${`forum:${staffRoom}`}, now())
      `;
      // The guest beacon records presence through recordVisit, exactly like a CDN-served page.
      await recordVisit(database.sql, {
        viewerKey: "guest:00000000-0000-4000-8000-000000000001",
        ctx: "board",
      });

      const tree = await loadForumTree(database.sql);
      const guestSnapshot = await loadPermissionSnapshot(database.sql, GUEST_PRINCIPAL, {
        tree,
        sessionId: null,
      });
      const guest = await readOnlineOverview(database.sql, {
        principal: GUEST_PRINCIPAL,
        sessionId: null,
        tree,
        snapshot: guestSnapshot,
        canViewHidden: false,
        withLocations: true,
      });
      expect(guest.memberCount).toBe(1);
      expect(guest.guestCount).toBe(1);
      expect(guest.members[0]?.id).toBe(memberTwo);
      expect(guest.members[0]?.location).toBeNull();

      const adminSnapshot = await loadPermissionSnapshot(database.sql, admin.memberId, {
        tree,
        sessionId: admin.sessionId,
      });
      const staff = await readOnlineOverview(database.sql, {
        principal: admin.memberId,
        sessionId: admin.sessionId,
        tree,
        snapshot: adminSnapshot,
        canViewHidden: true,
        withLocations: true,
      });
      expect(staff.memberCount).toBe(2);
      expect(staff.members.find((member) => member.id === memberOne)?.location).toBe("Staff Room");
    });
  }, 30_000);

  test("records board statistics and a new online record", async () => {
    await withDb(async (database) => {
      const first = await readBoardStatistics(database.sql);
      expect(first.topics).toBeGreaterThan(0);
      expect(first.posts).toBeGreaterThan(0);
      expect(first.members).toBeGreaterThan(0);

      await database.sql`
        INSERT INTO core.presence (viewer_key, location, last_seen)
        VALUES
          ('member:9001', 'board', now()),
          ('guest:00000000-0000-4000-8000-000000000002', 'board', now())
      `;

      expect(await updateOnlineRecord(database.sql)).toMatchObject({ count: 2, changed: true });
      expect((await readBoardStatistics(database.sql)).recordOnline.count).toBe(2);

      await database.sql`DELETE FROM core.presence`;
      expect(await updateOnlineRecord(database.sql)).toMatchObject({ count: 2, changed: false });
    });
  }, 30_000);

  test("leaderboards exclude private content and react to a forum becoming private", async () => {
    await withDb(async (database) => {
      const publicForum = await forumId(database, "off-topic");
      const staffForum = await forumId(database, "staff-room");
      const member = await memberId(database, "member-1");

      const [hiddenMember] = (await database.sql`
        INSERT INTO core.members (display_name, name_skeleton)
        VALUES ('Hidden Poster', 'hidden poster')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;
      const [visibleMember] = (await database.sql`
        INSERT INTO core.members (display_name, name_skeleton)
        VALUES ('Visible Poster', 'visible poster')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;
      const [isolatedMember] = (await database.sql`
        INSERT INTO core.members (display_name, name_skeleton)
        VALUES ('Isolated Poster', 'isolated poster')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (
        hiddenMember === undefined ||
        visibleMember === undefined ||
        isolatedMember === undefined
      ) {
        throw new Error("Could not create the leaderboard members");
      }

      const [topic] = (await database.sql`
        INSERT INTO core.topics (forum_id, title, slug, starter_id)
        VALUES (${staffForum}, 'Hidden leaderboard topic', 'hidden-leaderboard-topic', ${hiddenMember.id})
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (topic === undefined) {
        throw new Error("Could not create the hidden topic");
      }

      await database.sql`
        INSERT INTO core.posts (
          topic_id, author_id, body_md, body_html, body_text, render_version, sanitiser_version, position
        )
        VALUES (${topic.id}, ${hiddenMember.id}, 'Body.', '<p>Body.</p>', 'Body.', 1, 1, 1)
      `;

      // A public post from member-1 makes the guest leaderboard non-empty.
      const [publicTopic] = (await database.sql`
        INSERT INTO core.topics (forum_id, title, slug, starter_id)
        VALUES (${publicForum}, 'Public leaderboard topic', 'public-leaderboard-topic', ${member})
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (publicTopic === undefined) {
        throw new Error("Could not create the public topic");
      }

      await database.sql`
        INSERT INTO core.posts (
          topic_id, author_id, body_md, body_html, body_text, render_version, sanitiser_version, position
        )
        VALUES (${publicTopic.id}, ${member}, 'Body.', '<p>Body.</p>', 'Body.', 1, 1, 1)
      `;

      for (let index = 0; index < 5; index += 1) {
        const [visibleTopic] = (await database.sql`
          INSERT INTO core.topics (forum_id, title, slug, starter_id)
          VALUES (${publicForum}, ${`Visible leaderboard topic ${index}`}, ${`visible-leaderboard-topic-${index}`}, ${visibleMember.id})
          RETURNING id::text AS id
        `) as Array<{ id: string }>;

        if (visibleTopic !== undefined) {
          await database.sql`
            INSERT INTO core.posts (
              topic_id, author_id, body_md, body_html, body_text, render_version, sanitiser_version, position
            )
            VALUES (${visibleTopic.id}, ${visibleMember.id}, 'Body.', '<p>Body.</p>', 'Body.', 1, 1, 1)
          `;
        }
      }

      for (let index = 0; index < 3; index += 1) {
        const [isolatedTopic] = (await database.sql`
          INSERT INTO core.topics (forum_id, title, slug, starter_id)
          VALUES (${publicForum}, ${`Isolated leaderboard topic ${index}`}, ${`isolated-leaderboard-topic-${index}`}, ${isolatedMember.id})
          RETURNING id::text AS id
        `) as Array<{ id: string }>;

        if (isolatedTopic !== undefined) {
          await database.sql`
            INSERT INTO core.posts (
              topic_id, author_id, body_md, body_html, body_text, render_version, sanitiser_version, position
            )
            VALUES (${isolatedTopic.id}, ${isolatedMember.id}, 'Body.', '<p>Body.</p>', 'Body.', 1, 1, 1)
          `;
        }
      }

      await recomputeLeaderboards(database.sql);

      const tree = await loadForumTree(database.sql);
      const snapshot = await loadPermissionSnapshot(database.sql, GUEST_PRINCIPAL, {
        tree,
        sessionId: null,
      });
      const before = await readLeaderboard(database.sql, {
        period: "all",
        metric: "posts",
        tree,
        snapshot,
      });
      expect(before.some((entry) => entry.memberId === member)).toBe(true);
      expect(before.some((entry) => entry.memberId === hiddenMember.id)).toBe(false);
      expect(before.some((entry) => entry.memberId === visibleMember.id)).toBe(true);
      expect(before.some((entry) => entry.memberId === isolatedMember.id)).toBe(true);

      const today = await readTodayTopPoster(database.sql, { tree, snapshot });
      expect(today).not.toBeNull();
      expect(today?.memberId).not.toBe(hiddenMember.id);
      const todayBoard = await readLeaderboard(database.sql, {
        period: "today",
        metric: "posts",
        tree,
        snapshot,
        limit: 50,
      });
      expect(todayBoard.some((entry) => entry.memberId === visibleMember.id)).toBe(true);

      // Remove Guests' read permission on the community root: contribution disappears without
      // a recompute because reads filter by the current permission snapshot (task 4.5).
      const community = await forumId(database, "community");
      await database.sql`
        DELETE FROM core.forum_permissions
        WHERE forum_id = ${community}
          AND mask_id = (SELECT id FROM core.masks WHERE key = 'guest')
      `;
      await bumpPermVersion(database.sql);
      const treeAfter = await loadForumTree(database.sql);
      const snapshotAfter = await loadPermissionSnapshot(database.sql, GUEST_PRINCIPAL, {
        tree: treeAfter,
        sessionId: null,
      });
      const after = await readLeaderboard(database.sql, {
        period: "all",
        metric: "posts",
        tree: treeAfter,
        snapshot: snapshotAfter,
      });
      expect(after.some((entry) => entry.memberId === isolatedMember.id)).toBe(false);
      expect(await guestReadableForumIds(database.sql, treeAfter, snapshotAfter)).not.toContain(
        publicForum,
      );
    });
  }, 30_000);

  test("member list, online and leaderboard routes produce distinct permission variants", async () => {
    await withDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const guest = null;
        const admin = await session(database, "admin");
        const renderList = (sessionValue: UserAppSessionContext | null) =>
          renderMemberListRoute({
            sql: database.sql,
            locale: "en",
            translate,
            session: sessionValue,
            params: new URLSearchParams(),
            pluginsGeneration: 1,
            colourScheme: "system",
            cache,
            tagVersions: versions,
          });
        const renderOnline = (sessionValue: UserAppSessionContext | null) =>
          renderOnlineRoute({
            sql: database.sql,
            locale: "en",
            translate,
            session: sessionValue,
            pluginsGeneration: 1,
            colourScheme: "system",
            cache,
            tagVersions: versions,
          });
        const listCases: readonly VariantCase[] = [
          {
            name: "guest",
            render: async () => {
              const result = await renderList(guest);
              return {
                variant: result.variant,
                html: result.html,
                cache: result.cache ?? undefined,
              };
            },
          },
          {
            name: "admin",
            render: async () => {
              const result = await renderList(admin);
              return {
                variant: result.variant,
                html: result.html,
                cache: result.cache ?? undefined,
              };
            },
          },
        ];
        await assertCacheVariants({ route: "/members", cases: listCases, cache });

        // Hidden member visibility changes the list variant.
        const memberTwo = await memberId(database, "member-2");
        const onlineCases: readonly VariantCase[] = [
          {
            name: "guest",
            render: async () => {
              const result = await renderOnline(guest);
              return {
                variant: result.variant,
                html: result.html,
                cache: result.cache ?? undefined,
              };
            },
          },
          {
            name: "admin",
            render: async () => {
              const result = await renderOnline(admin);
              return {
                variant: result.variant,
                html: result.html,
                cache: result.cache ?? undefined,
              };
            },
          },
        ];
        await assertCacheVariants({ route: "/members/online", cases: onlineCases, cache });
        expect(memberTwo).toMatch(/^\d+$/);
      } finally {
        await versions.close();
      }
    });
  }, 45_000);

  test("the leaderboard route gets a new variant when a forum stops being guest-readable", async () => {
    await withDb(async (database) => {
      const publicForum = await forumId(database, "off-topic");
      const community = await forumId(database, "community");
      const [member] = (await database.sql`
        INSERT INTO core.members (display_name, name_skeleton)
        VALUES ('Variant Poster', 'variant poster')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (member === undefined) {
        throw new Error("Could not create the variant member");
      }

      const [topic] = (await database.sql`
        INSERT INTO core.topics (forum_id, title, slug, starter_id)
        VALUES (${publicForum}, 'Variant leaderboard topic', 'variant-leaderboard-topic', ${member.id})
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (topic === undefined) {
        throw new Error("Could not create the variant topic");
      }

      await database.sql`
        INSERT INTO core.posts (
          topic_id, author_id, body_md, body_html, body_text, render_version, sanitiser_version, position
        )
        VALUES (${topic.id}, ${member.id}, 'Body.', '<p>Body.</p>', 'Body.', 1, 1, 1)
      `;
      await recomputeLeaderboards(database.sql);

      const [guestPermission] = (await database.sql`
        SELECT actions
        FROM core.forum_permissions
        WHERE forum_id = ${community}
          AND mask_id = (SELECT id FROM core.masks WHERE key = 'guest')
      `) as Array<{ actions: number }>;
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const render = () =>
          renderLeaderboardRoute({
            sql: database.sql,
            locale: "en",
            translate,
            session: null,
            pluginsGeneration: 1,
            colourScheme: "system",
            cache,
            tagVersions: versions,
          });
        const cases: readonly VariantCase[] = [
          {
            name: "public",
            render: async () => {
              const result = await render();
              return {
                variant: result.variant,
                html: result.html,
                cache: result.cache ?? undefined,
              };
            },
          },
          {
            name: "private",
            setup: async () => {
              await database.sql`
                DELETE FROM core.forum_permissions
                WHERE forum_id = ${community}
                  AND mask_id = (SELECT id FROM core.masks WHERE key = 'guest')
              `;
              await bumpPermVersion(database.sql);
            },
            teardown: async () => {
              if (guestPermission !== undefined) {
                await database.sql`
                  INSERT INTO core.forum_permissions (forum_id, mask_id, actions, inherits)
                  VALUES (
                    ${community},
                    (SELECT id FROM core.masks WHERE key = 'guest'),
                    ${guestPermission.actions},
                    false
                  )
                  ON CONFLICT (forum_id, mask_id) DO UPDATE SET actions = EXCLUDED.actions
                `;
                await bumpPermVersion(database.sql);
              }
            },
            render: async () => {
              const result = await render();
              return {
                variant: result.variant,
                html: result.html,
                cache: result.cache ?? undefined,
              };
            },
          },
        ];
        await assertCacheVariants({
          route: "/leaderboards",
          cases,
          cache,
          leaks: [
            {
              description: "private leaderboard contribution",
              markers: ["Variant Poster"],
              absentFrom: ["private"],
            },
          ],
        });
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("the member list route shows cards and the online route filters locations", async () => {
    await withDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const list = await renderMemberListRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session: null,
          params: new URLSearchParams({ q: "Regular Member" }),
          pluginsGeneration: 1,
          colourScheme: "system",
          cache,
          tagVersions: versions,
        });
        expect(await htmlOf(list)).toContain("data-member-card");
        expect(await htmlOf(list)).toContain("Regular Member One");

        const online = await renderOnlineRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session: null,
          pluginsGeneration: 1,
          colourScheme: "system",
          cache,
          tagVersions: versions,
        });
        expect(await htmlOf(online)).toContain("data-online-page");
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("privacy changes invalidate warmed directory and online caches", async () => {
    await withDb(async (database) => {
      const memberTwo = await memberId(database, "member-2");
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const renderList = () =>
          renderMemberListRoute({
            sql: database.sql,
            locale: "en",
            translate,
            session: null,
            params: new URLSearchParams(),
            pluginsGeneration: 1,
            colourScheme: "system",
            cache,
            tagVersions: versions,
          });
        const before = await renderList();
        expect(before.cache).toBe("miss");
        expect(before.html).toContain("Regular Member Two");

        expect(
          await saveMemberProfile(database.sql, {
            memberId: memberTwo,
            aboutMd: "",
            hideOnline: false,
            hideFromMemberList: true,
            values: {},
            fields: [],
          }),
        ).toEqual({ ok: true });
        await versions.refresh();

        const after = await renderList();
        expect(after.cache).toBe("miss");
        expect(after.html).not.toContain("Regular Member Two");

        await database.sql`
          INSERT INTO core.presence (viewer_key, location, last_seen)
          VALUES (${`member:${memberTwo}`}, 'board', now())
          ON CONFLICT (viewer_key) DO UPDATE SET last_seen = now()
        `;
        const renderOnline = () =>
          renderOnlineRoute({
            sql: database.sql,
            locale: "en",
            translate,
            session: null,
            pluginsGeneration: 1,
            colourScheme: "system",
            cache,
            tagVersions: versions,
          });
        const onlineBefore = await renderOnline();
        expect(onlineBefore.html).toContain("Regular Member Two");

        expect(
          await saveMemberProfile(database.sql, {
            memberId: memberTwo,
            aboutMd: "",
            hideOnline: true,
            hideFromMemberList: true,
            values: {},
            fields: [],
          }),
        ).toEqual({ ok: true });
        await versions.refresh();

        const onlineAfter = await renderOnline();
        expect(onlineAfter.cache).toBe("miss");
        expect(onlineAfter.html).not.toContain("Regular Member Two");
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("ascending and descending sorts get distinct cache variants", async () => {
    await withDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const render = (direction: "asc" | "desc") =>
          renderMemberListRoute({
            sql: database.sql,
            locale: "en",
            translate,
            session: null,
            params: new URLSearchParams({ sort: "name", direction }),
            pluginsGeneration: 1,
            colourScheme: "system",
            cache,
            tagVersions: versions,
          });
        const ascending = await render("asc");
        const descending = await render("desc");

        expect(ascending.variant).not.toBe(descending.variant);
        expect(ascending.html).not.toBe(descending.html);
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("presence changes produce fresh ETags after the 60s TTL", async () => {
    await withDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });
      let clock = Date.now();

      try {
        const cache = createRenderCache({ tags: versions, now: () => clock });
        const common = {
          sql: database.sql,
          locale: "en" as const,
          translate,
          session: null,
          pluginsGeneration: 1,
          colourScheme: "system" as const,
          cache,
          tagVersions: versions,
        };
        const firstOnline = await renderOnlineRoute(common);
        const firstHome = await renderHomeRoute(common);

        await database.sql`
          INSERT INTO core.presence (viewer_key, location, last_seen)
          VALUES ('guest:00000000-0000-4000-8000-0000000000aa', 'board', now())
        `;
        clock += 61_000;

        const secondOnline = await renderOnlineRoute(common);
        const secondHome = await renderHomeRoute(common);

        expect(secondOnline.etag).not.toBe(firstOnline.etag);
        expect(secondHome.etag).not.toBe(firstHome.etag);
        expect(isNotModified(firstOnline.etag, secondOnline.etag)).toBe(false);
        expect(isNotModified(firstHome.etag, secondHome.etag)).toBe(false);
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("home variants follow Guests' read bits for the top poster", async () => {
    await withDb(async (database) => {
      const community = await forumId(database, "community");
      const offTopic = await forumId(database, "off-topic");
      const viewer = await session(database, "member-1");
      const [poster] = (await database.sql`
        INSERT INTO core.members (display_name, name_skeleton)
        VALUES ('Home Top Poster', 'home top poster')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (poster === undefined) {
        throw new Error("Could not create the top poster");
      }

      // Keep them out of the "newest member" line, which would otherwise also contain the name.
      await database.sql`
        UPDATE core.members SET joined_at = now() - interval '1 year' WHERE id = ${poster.id}
      `;

      for (let index = 0; index < 30; index += 1) {
        const [topic] = (await database.sql`
          INSERT INTO core.topics (forum_id, title, slug, starter_id)
          VALUES (${offTopic}, ${`Home top topic ${index}`}, ${`home-top-topic-${index}`}, ${poster.id})
          RETURNING id::text AS id
        `) as Array<{ id: string }>;

        if (topic !== undefined) {
          await database.sql`
            INSERT INTO core.posts (
              topic_id, author_id, body_md, body_html, body_text, render_version, sanitiser_version, position
            )
            VALUES (${topic.id}, ${poster.id}, 'Body.', '<p>Body.</p>', 'Body.', 1, 1, 1)
          `;
        }
      }

      await recomputeLeaderboards(database.sql);
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const common = {
          sql: database.sql,
          locale: "en" as const,
          translate,
          session: viewer,
          pluginsGeneration: 1,
          colourScheme: "system" as const,
          cache,
          tagVersions: versions,
        };
        const before = await renderHomeRoute(common);
        expect(before.html).toContain("Home Top Poster");

        await database.sql`
          DELETE FROM core.forum_permissions
          WHERE forum_id = ${community}
            AND mask_id = (SELECT id FROM core.masks WHERE key = 'guest')
        `;
        await bumpPermVersion(database.sql);
        await versions.refresh();

        const after = await renderHomeRoute(common);
        expect(after.variant).not.toBe(before.variant);
        expect(after.html).not.toContain("Home Top Poster");
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("board totals exclude forums the viewer cannot read", async () => {
    await withDb(async (database) => {
      const staffRoom = await forumId(database, "staff-room");
      const tree = await loadForumTree(database.sql);
      const guestSnapshot = await loadPermissionSnapshot(database.sql, GUEST_PRINCIPAL, {
        tree,
        sessionId: null,
      });
      const admin = await session(database, "admin");
      const adminSnapshot = await loadPermissionSnapshot(database.sql, admin.memberId, {
        tree,
        sessionId: admin.sessionId,
      });
      const guestScope = {
        principal: GUEST_PRINCIPAL,
        sessionId: null,
        tree,
        snapshot: guestSnapshot,
      };
      const adminScope = {
        principal: admin.memberId,
        sessionId: admin.sessionId,
        tree,
        snapshot: adminSnapshot,
      };
      const guestBefore = await readBoardStatistics(database.sql, guestScope);
      const adminBefore = await readBoardStatistics(database.sql, adminScope);

      await database.sql`
        UPDATE core.forums SET topic_count = topic_count + 5, post_count = post_count + 5
        WHERE id = ${staffRoom}
      `;

      const guestAfter = await readBoardStatistics(database.sql, guestScope);
      const adminAfter = await readBoardStatistics(database.sql, adminScope);
      expect(guestAfter.topics).toBe(guestBefore.topics);
      expect(guestAfter.posts).toBe(guestBefore.posts);
      expect(adminAfter.topics).toBe(adminBefore.topics + 5);
      expect(adminAfter.posts).toBe(adminBefore.posts + 5);
    });
  }, 30_000);
});
