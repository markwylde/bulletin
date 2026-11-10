import { describe, expect, test } from "bun:test";
import { createRenderCache } from "@bulletin/cache";
import {
  baseSeedModule,
  emoticonSeedModule,
  flagsSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import { createServerT } from "@bulletin/i18n";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { saveAnnouncement } from "../../apps/staff-api/src/announcements.ts";
import { saveForumSettings } from "../../apps/staff-api/src/forums.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { renderForumRoute } from "../../apps/user-app/src/forums/route.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });
const TRUSTED = { version: () => "0", isTrusted: () => true };
const YOUTUBE = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const EMBED_SRC = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ";

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "content_embed_rendering" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        flagsSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        membersSeedModule,
        emoticonSeedModule,
        themesSeedModule,
      ]),
    });
    await run(database);
  });
}

async function adminId(database: TestDatabase): Promise<string> {
  const [row] = (await database.sql`
    SELECT id::text AS id FROM core.members WHERE display_name = 'Admin'
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error("Missing seeded admin");
  }

  return row.id;
}

async function renderAnnouncementsForum(database: TestDatabase) {
  return renderForumRoute({
    sql: database.sql,
    locale: "en",
    translate,
    session: null,
    ref: "/forum/2-announcements",
    pluginsGeneration: 1,
    colourScheme: "system",
    cache: createRenderCache({ tags: TRUSTED }),
    tagVersions: TRUSTED,
  });
}

integrationDescribe("content embeds through page rendering", () => {
  test("announcement and forum-rule players survive theme sanitising but theme frames do not", async () => {
    await withSeededDb(async (database) => {
      const actor = await adminId(database);
      const body = `Watch this:\n\n${YOUTUBE}`;
      const announcement = await saveAnnouncement(database.sql, actor, {
        title: "Player notice",
        body,
        scope: "forums",
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        dismissible: true,
        targets: [{ forumId: "2", includeSubforums: false }],
        groupIds: [],
      });
      const settings = await saveForumSettings(database.sql, actor, {
        id: "2",
        rules: body,
        prefixIds: [],
      });

      expect(announcement).toEqual({ ok: true });
      expect(settings).toEqual({ ok: true });

      // A theme cannot save this markup, but a corrupted theme row must still not frame
      // anything: only the content player's allowlisted origin survives rendering.
      const [theme] = (await database.sql`
        SELECT id::text AS id FROM core.themes WHERE name = 'default'
      `) as Array<{ id: string }>;

      if (theme === undefined) {
        throw new Error("Missing default theme");
      }

      await database.sql`
        UPDATE core.themes SET version = version + 1 WHERE id = ${theme.id}
      `;
      await database.sql`
        UPDATE core.theme_templates
        SET body = ${`{{ header }}<main data-forum-page data-forum-id="{{ forumId }}"><iframe data-bl-embed="youtube" src="https://evil.example/embed/1"></iframe>{{ rules }}{% for announcement in announcements %}{{ announcement.body }}{% endfor %}</main>{{ footer }}`},
            version = version + 1
        WHERE theme_id = ${theme.id} AND name = 'forum'
      `;

      const page = await renderAnnouncementsForum(database);

      expect(page.kind).toBe("page");

      if (page.kind !== "page") {
        return;
      }

      expect(page.html).not.toContain("evil.example");
      expect(page.html).toContain('data-bl-embed="youtube"');
      expect(page.html).toContain(`src="${EMBED_SRC}"`);
      // One player from the forum rules and one from the announcement, both through the
      // real template, view model and theme sanitising path.
      expect(page.html.match(/<iframe/g)).toHaveLength(2);
    });
  }, 30_000);
});
