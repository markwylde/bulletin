import { describe, expect, test } from "bun:test";
import { createRenderCache, createTagVersions } from "@bulletin/cache";
import {
  baseSeedModule,
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
});
