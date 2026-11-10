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
import { type ForumAction, forumActionMask } from "@bulletin/domain/permissions";
import { createServerT } from "@bulletin/i18n";
import { assertCacheVariants, type VariantCase } from "@bulletin/test-utils/cache-variants";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { buildBoardIndex } from "../../apps/user-app/src/forums/index.ts";
import { renderHomeRoute } from "../../apps/user-app/src/home/route.ts";
import type { UserAppSessionContext } from "../../apps/user-app/src/session.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "forum_index" }, async (database) => {
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

async function forumIdByTitle(database: TestDatabase, title: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT id FROM core.forums WHERE title = ${title}
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing forum ${title}`);
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

async function setStandardActions(
  database: TestDatabase,
  forumId: string,
  actions: readonly ForumAction[],
): Promise<void> {
  await database.sql`
    INSERT INTO core.forum_permissions (forum_id, mask_id, actions, inherits)
    VALUES (
      ${forumId}, (SELECT id FROM core.masks WHERE key = 'standard'),
      ${forumActionMask(actions)}, false
    )
    ON CONFLICT (forum_id, mask_id) DO UPDATE
      SET actions = EXCLUDED.actions, inherits = false
  `;
}

function allForumIds(viewModel: { categories: readonly { forums: readonly { id: string }[] }[] }) {
  return viewModel.categories.flatMap((category) => category.forums.map((forum) => forum.id));
}

integrationDescribe("board index view model", () => {
  test("omits hidden forums and their sub-forums and shows only readable latest posts", async () => {
    await withSeededDb(async (database) => {
      const category = await forumIdByTitle(database, "Community");
      const announcements = await forumIdByTitle(database, "Announcements");
      const general = await forumIdByTitle(database, "General Discussion");
      const [member] = (await database.sql`
        SELECT i.member_id::text AS id
        FROM pii.identities i
        WHERE i.sub = 'member-1'
      `) as Array<{ id: string }>;

      if (member === undefined) {
        throw new Error("Missing seeded member");
      }

      await database.sql`
        INSERT INTO core.forums (parent_id, title, slug, topic_count, post_count)
        VALUES (${announcements}, 'Archive', 'archive', 4, 9)
      `;
      await database.sql`
        UPDATE core.forums
        SET topic_count = 4,
            post_count = 9,
            last_post_at = now() - interval '5 minutes',
            last_post_id = 99,
            last_post_member_id = ${member.id}
        WHERE id = ${announcements}
      `;

      const guest = await buildBoardIndex({
        sql: database.sql,
        locale: "en",
        translate,
        session: null,
      });
      const asMember = await buildBoardIndex({
        sql: database.sql,
        locale: "en",
        translate,
        session: await memberSession(database, "member-1"),
      });

      // Guests see Community and Support; members also see the public Archive category.
      expect(guest.viewModel.categories).toHaveLength(2);
      expect(asMember.viewModel.categories).toHaveLength(3);
      expect(asMember.viewModel.categories[0]?.id).toBe(category);

      const announcementsView = asMember.viewModel.categories[0]?.forums.find(
        (forum) => forum.id === announcements,
      );

      expect(announcementsView?.topicCount).toBe("4 topics");
      expect(announcementsView?.postCount).toBe("9 posts");
      expect(announcementsView?.subforums.map((forum) => forum.title)).toEqual(["Archive"]);
      expect(announcementsView?.lastPost?.memberName).toBe("Regular Member One");

      // `show` without `read` keeps the forum in the list but hides the latest post.
      await setStandardActions(database, announcements, ["show"]);
      const showOnly = await buildBoardIndex({
        sql: database.sql,
        locale: "en",
        translate,
        session: await memberSession(database, "member-1"),
      });
      const showOnlyView = showOnly.viewModel.categories[0]?.forums.find(
        (forum) => forum.id === announcements,
      );

      expect(showOnlyView?.id).toBe(announcements);
      expect(showOnlyView?.lastPost).toBeNull();

      // Hiding the parent removes both it and its sub-forum; the other forum stays.
      await setStandardActions(database, announcements, []);
      const hidden = await buildBoardIndex({
        sql: database.sql,
        locale: "en",
        translate,
        session: await memberSession(database, "member-1"),
      });
      const hiddenIds = allForumIds(hidden.viewModel);

      expect(hiddenIds).not.toContain(announcements);
      expect(hiddenIds).not.toContain(await forumIdByTitle(database, "Archive"));
      expect(hiddenIds).toContain(general);
    });
  }, 30_000);

  test("registers guest, member and hidden-permission variants without leaking forums", async () => {
    await withSeededDb(async (database) => {
      const member = await memberSession(database, "member-1");
      const announcements = await forumIdByTitle(database, "Announcements");
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });

        const render = (session: UserAppSessionContext | null) =>
          renderHomeRoute({
            sql: database.sql,
            locale: "en",
            translate,
            session,
            pluginsGeneration: 1,
            colourScheme: "system",
            cache,
            tagVersions: versions,
          });

        let originalActions = 0;

        const readOriginal = async (): Promise<number> => {
          const [row] = (await database.sql`
            SELECT actions FROM core.forum_permissions
            WHERE forum_id = ${announcements}
              AND mask_id = (SELECT id FROM core.masks WHERE key = 'standard')
          `) as Array<{ actions: number }>;
          return row?.actions ?? 0;
        };

        const restore = async (): Promise<void> => {
          await database.sql`
            INSERT INTO core.forum_permissions (forum_id, mask_id, actions, inherits)
            VALUES (
              ${announcements}, (SELECT id FROM core.masks WHERE key = 'standard'),
              ${originalActions}, false
            )
            ON CONFLICT (forum_id, mask_id) DO UPDATE
              SET actions = EXCLUDED.actions, inherits = false
          `;
        };

        const caseFor = (name: string, actions: readonly ForumAction[] | null): VariantCase => ({
          name,
          setup: async () => {
            originalActions = await readOriginal();

            if (actions !== null) {
              await setStandardActions(database, announcements, actions);
            }
          },
          teardown: restore,
          render: async () => {
            const result = await render(member);

            return {
              variant: result.variant,
              html: result.html,
              ...(result.cache === null ? {} : { cache: result.cache }),
            };
          },
        });

        const cases: VariantCase[] = [
          caseFor("member", null),
          caseFor("announcements without read", ["show"]),
          caseFor("announcements hidden", []),
        ];

        const report = await assertCacheVariants({
          route: "/",
          cases,
          cache,
          leaks: [
            {
              description: "a hidden forum's row and title never reach the hidden variant",
              markers: [`data-forum-link="${announcements}"`],
              absentFrom: ["announcements hidden"],
            },
          ],
        });

        expect(report.variants.size).toBe(3);
        expect(report.variants.get("member")).not.toBe(
          report.variants.get("announcements without read"),
        );
        expect(report.variants.get("member")).not.toBe(report.variants.get("announcements hidden"));
      } finally {
        await versions.close();
      }
    });
  }, 30_000);
});
