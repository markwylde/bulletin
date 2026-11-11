import { describe, expect, test } from "bun:test";
import { createRenderCache, createTagVersions } from "@bulletin/cache";
import {
  baseSeedModule,
  flagsSeedModule,
  groupsSeedModule,
  membersSeedModule,
  moderatorAssignmentsSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import {
  announcementMutation,
  forumSettingsMutation,
  forumTreeMutation,
  runMutation,
} from "@bulletin/domain/mutations";
import { createServerT } from "@bulletin/i18n";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { saveForumSettings } from "../../apps/staff-api/src/forums.ts";
import { deleteModerator, saveModerator } from "../../apps/staff-api/src/moderators.ts";
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

  await withTestDatabase({ adminUrl, prefix: "forum_mutations" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        flagsSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
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
    FROM pii.identities i
    JOIN core.members m ON m.id = i.member_id
    WHERE i.sub = ${sub}
  `) as Array<{ member_id: string; display_name: string | null }>;

  if (row === undefined) {
    throw new Error(`No seeded member ${sub}`);
  }

  return {
    memberId: row.member_id,
    sessionId: "0",
    reauthAt: new Date().toISOString(),
    locale: "en",
    displayName: row.display_name,
  };
}

async function forumCache(pages: ReturnType<typeof harness>, ref: string): Promise<string | null> {
  const result = await pages.forum(ref);

  expect(result.kind).toBe("page");

  return result.kind === "page" ? result.cache : null;
}

function harness(
  database: TestDatabase,
  member: UserAppSessionContext,
  versions: Awaited<ReturnType<typeof createTagVersions>>,
) {
  const cache = createRenderCache({ tags: versions });
  const index = () =>
    renderHomeRoute({
      sql: database.sql,
      locale: "en",
      translate,
      session: member,
      pluginsGeneration: 1,
      colourScheme: "system",
      cache,
      tagVersions: versions,
    });
  const forum = (ref: string) =>
    renderForumRoute({
      sql: database.sql,
      locale: "en",
      translate,
      session: member,
      ref,
      pluginsGeneration: 1,
      colourScheme: "system",
      cache,
      tagVersions: versions,
    });

  return { index, forum };
}

integrationDescribe("forum mutations invalidate the index and affected pages", () => {
  test("a tree move invalidates the index and the moved forum", async () => {
    await withSeededDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const member = await memberSession(database, "member-1");
        const pages = harness(database, member, versions);
        const firstIndex = await pages.index();
        const firstForum = await pages.forum("/forum/2-announcements");
        const warmIndex = await pages.index();
        const warmForum = await pages.forum("/forum/2-announcements");

        expect(firstIndex.cache).toBe("miss");
        expect(firstForum.kind).toBe("page");
        expect(warmIndex.cache).toBe("hit");
        expect(warmForum.kind).toBe("page");

        await runMutation({
          sql: database.sql,
          mutation: forumTreeMutation,
          input: { affectedForumIds: ["1", "2", "3"] },
          apply: async (tx) => {
            await tx`UPDATE core.forums SET parent_id = 3 WHERE id = 2`;
            return {};
          },
        });
        await versions.refresh();

        expect((await pages.index()).cache).toBe("miss");
        expect(await forumCache(pages, "/forum/2-announcements")).toBe("miss");
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("settings and forum-scoped announcements invalidate only what they declare", async () => {
    await withSeededDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const member = await memberSession(database, "member-1");
        const pages = harness(database, member, versions);

        await pages.index();
        await pages.forum("/forum/2-announcements");
        await pages.forum("/forum/3-general-discussion");

        // A settings save on forum 2 invalidates the index and the forum; the board tag is
        // declared because the index shows the forum name.
        await runMutation({
          sql: database.sql,
          mutation: forumSettingsMutation,
          input: { affectedForumIds: ["1", "2"] },
          apply: async (tx) => {
            await tx`UPDATE core.forums SET description = 'Changed' WHERE id = 2`;
          },
        });
        await versions.refresh();

        expect((await pages.index()).cache).toBe("miss");
        expect(await forumCache(pages, "/forum/2-announcements")).toBe("miss");

        // Warm forum 3 again, then add a VIP-targeted announcement to forum 2. member-1 is not
        // VIP, so its index and forum-3 variant keys are unchanged and only forum 2's block
        // tag is bumped.
        await pages.forum("/forum/3-general-discussion");
        const [vip] = (await database.sql`
          SELECT id FROM core.groups WHERE key = 'vip'
        `) as Array<{ id: string }>;

        if (vip === undefined) {
          throw new Error("Missing VIP group");
        }

        await runMutation({
          sql: database.sql,
          mutation: announcementMutation,
          input: { announcementId: "0", scope: "forums", forumIds: ["2"] },
          apply: async (tx) => {
            const [announcement] = (await tx`
              INSERT INTO core.announcements (title, body, scope)
              VALUES ('VIP only', 'Members only notice', 'forums')
              RETURNING id
            `) as Array<{ id: string }>;

            if (announcement === undefined) {
              throw new Error("Could not create announcement");
            }

            await tx`
              INSERT INTO core.announcement_targets (announcement_id, forum_id)
              VALUES (${announcement.id}, 2)
            `;
            await tx`
              INSERT INTO core.announcement_groups (announcement_id, group_id)
              VALUES (${announcement.id}, ${vip.id})
            `;
          },
        });
        await versions.refresh();

        expect((await pages.index()).cache).toBe("hit");
        expect(await forumCache(pages, "/forum/3-general-discussion")).toBe("hit");
        expect(await forumCache(pages, "/forum/2-announcements")).toBe("miss");
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("a global announcement invalidates the shared announcement block everywhere", async () => {
    await withSeededDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const member = await memberSession(database, "member-1");
        const pages = harness(database, member, versions);

        await pages.index();
        await pages.forum("/forum/2-announcements");

        await runMutation({
          sql: database.sql,
          mutation: announcementMutation,
          input: { announcementId: "0", scope: "global", forumIds: [] },
          apply: async (tx) => {
            await tx`
              INSERT INTO core.announcements (title, body, scope, starts_at)
              VALUES ('Board notice', 'Everyone sees this', 'global', now() - interval '1 minute')
            `;
          },
        });
        await versions.refresh();

        expect((await pages.index()).cache).toBe("miss");

        const forum = await pages.forum("/forum/2-announcements");

        expect(forum.kind).toBe("page");

        if (forum.kind === "page") {
          expect(forum.cache).toBe("miss");
          expect(forum.html).toContain("Board notice");
        }
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("moderator assignment and removal invalidate warm forum pages and descendants", async () => {
    await withSeededDb(async (database) => {
      const [admin] = (await database.sql`
        SELECT member_id::text AS id FROM pii.identities WHERE sub = 'admin'
      `) as Array<{ id: string }>;

      if (admin === undefined) {
        throw new Error("Missing admin");
      }

      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const viewer = await memberSession(database, "member-1");
        const moderator = await memberSession(database, "member-2");
        const pages = harness(database, viewer, versions);
        const forumRef = "/forum/8-help-questions";
        const childRef = "/forum/9-resolved-topics";
        const siblingRef = "/forum/10-bug-reports";

        await pages.forum(forumRef);
        await pages.forum(childRef);
        await pages.forum(siblingRef);
        expect(await forumCache(pages, forumRef)).toBe("hit");
        expect(await forumCache(pages, childRef)).toBe("hit");
        expect(await forumCache(pages, siblingRef)).toBe("hit");

        const saved = await saveModerator(database.sql, admin.id, {
          forumId: "8",
          assigneeKind: "member",
          assigneeId: moderator.memberId,
          powers: ["see_unapproved"],
          thisForumOnly: false,
        });
        expect(saved.ok).toBe(true);
        await versions.refresh();

        // The assignment is rendered on the forum and its inheriting child, not on a sibling.
        const assignedForum = await pages.forum(forumRef);
        const assignedChild = await pages.forum(childRef);

        expect(assignedForum.kind).toBe("page");
        expect(assignedChild.kind).toBe("page");
        expect(await forumCache(pages, siblingRef)).toBe("hit");

        if (assignedForum.kind === "page") {
          expect(assignedForum.cache).toBe("miss");
          expect(assignedForum.html).toContain("Regular Member Two");
        }

        if (assignedChild.kind === "page") {
          expect(assignedChild.cache).toBe("miss");
          expect(assignedChild.html).toContain("Regular Member Two");
        }

        const [assignment] = (await database.sql`
          SELECT id::text AS id
          FROM core.moderators
          WHERE forum_id = 8 AND member_id = ${moderator.memberId}
        `) as Array<{ id: string }>;

        if (assignment === undefined) {
          throw new Error("Moderator assignment was not stored");
        }

        const removed = await deleteModerator(database.sql, admin.id, { id: assignment.id });
        expect(removed.ok).toBe(true);
        await versions.refresh();

        const removedForum = await pages.forum(forumRef);
        const removedChild = await pages.forum(childRef);

        expect(removedForum.kind).toBe("page");
        expect(removedChild.kind).toBe("page");

        if (removedForum.kind === "page") {
          expect(removedForum.cache).toBe("miss");
          expect(removedForum.html).not.toContain("Regular Member Two");
        }

        if (removedChild.kind === "page") {
          expect(removedChild.cache).toBe("miss");
          expect(removedChild.html).not.toContain("Regular Member Two");
        }
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("moving a moderator assignment invalidates both the old and new forum pages", async () => {
    await withSeededDb(async (database) => {
      const [admin] = (await database.sql`
        SELECT member_id::text AS id FROM pii.identities WHERE sub = 'admin'
      `) as Array<{ id: string }>;

      if (admin === undefined) {
        throw new Error("Missing admin");
      }

      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const viewer = await memberSession(database, "member-1");
        const moderator = await memberSession(database, "member-2");
        const pages = harness(database, viewer, versions);
        const oldRef = "/forum/10-bug-reports";
        const newRef = "/forum/8-help-questions";

        const created = await saveModerator(database.sql, admin.id, {
          forumId: "10",
          assigneeKind: "member",
          assigneeId: moderator.memberId,
          powers: ["see_unapproved"],
          thisForumOnly: true,
        });
        expect(created.ok).toBe(true);
        await versions.refresh();

        const [assignment] = (await database.sql`
          SELECT id::text AS id
          FROM core.moderators
          WHERE forum_id = 10 AND member_id = ${moderator.memberId}
        `) as Array<{ id: string }>;

        if (assignment === undefined) {
          throw new Error("Moderator assignment was not stored");
        }

        const warmOld = await pages.forum(oldRef);
        await pages.forum(newRef);
        expect(await forumCache(pages, oldRef)).toBe("hit");
        expect(await forumCache(pages, newRef)).toBe("hit");

        if (warmOld.kind === "page") {
          expect(warmOld.html).toContain("Regular Member Two");
        }

        const moved = await saveModerator(database.sql, admin.id, {
          id: assignment.id,
          forumId: "8",
          assigneeKind: "member",
          assigneeId: moderator.memberId,
          powers: ["see_unapproved"],
          thisForumOnly: true,
        });
        expect(moved.ok).toBe(true);
        await versions.refresh();

        const oldForum = await pages.forum(oldRef);
        const newForum = await pages.forum(newRef);

        expect(oldForum.kind).toBe("page");
        expect(newForum.kind).toBe("page");

        if (oldForum.kind === "page") {
          expect(oldForum.cache).toBe("miss");
          expect(oldForum.html).not.toContain("Regular Member Two");
        }

        if (newForum.kind === "page") {
          expect(newForum.cache).toBe("miss");
          expect(newForum.html).toContain("Regular Member Two");
        }
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("reloads forum settings after the cache captures tag versions", async () => {
    await withSeededDb(async (database) => {
      const [admin] = (await database.sql`
        SELECT member_id::text AS id FROM pii.identities WHERE sub = 'admin'
      `) as Array<{ id: string }>;

      if (admin === undefined) {
        throw new Error("Missing admin");
      }

      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const member = await memberSession(database, "member-1");
        const realCache = createRenderCache({ tags: versions });
        const racingCache = {
          ...realCache,
          async getOrRender(request: Parameters<typeof realCache.getOrRender>[0]) {
            const saved = await saveForumSettings(database.sql, admin.id, {
              id: "2",
              description: "Raced settings",
              rules: "Raced rules",
              showModerators: true,
              language: null,
              defaultSort: "last_post",
              prefixMode: "optional",
              prefixIds: [],
            });

            expect(saved.ok).toBe(true);
            await versions.refresh();

            return realCache.getOrRender(request);
          },
        };
        const input = {
          sql: database.sql,
          locale: "en" as const,
          translate,
          session: member,
          ref: "/forum/2-announcements",
          pluginsGeneration: 1,
          colourScheme: "system" as const,
          tagVersions: versions,
        };
        const raced = await renderForumRoute({ ...input, cache: racingCache });

        expect(raced.kind).toBe("page");

        if (raced.kind !== "page") {
          return;
        }

        expect(raced.cache).toBe("miss");
        expect(raced.html).toContain("Raced rules");

        const stored = await renderForumRoute({ ...input, cache: realCache });

        expect(stored.kind).toBe("page");

        if (stored.kind === "page") {
          expect(stored.cache).toBe("hit");
          expect(stored.html).toContain("Raced rules");
        }
      } finally {
        await versions.close();
      }
    });
  }, 30_000);
});
