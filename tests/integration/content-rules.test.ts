import { describe, expect, test } from "bun:test";
import { currentContentVersions } from "@bulletin/content";
import {
  announcementRerenderSource,
  forumRulesRerenderSource,
  runContentRerenderJob,
} from "@bulletin/db/jobs";
import { loadAnnouncements } from "@bulletin/domain/permissions";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { saveAnnouncement } from "../../apps/staff-api/src/announcements.ts";
import { saveForumSettings } from "../../apps/staff-api/src/forums.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "content_rules" }, run);
}

async function createMember(database: TestDatabase, name: string): Promise<string> {
  const [member] = (await database.sql`
    INSERT INTO core.members (display_name, name_skeleton)
    VALUES (${name}, ${name.toLowerCase().replace(/\s+/g, "")})
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (member === undefined) {
    throw new Error("Could not create member");
  }

  return member.id;
}

integrationDescribe("rules and announcements through the pipeline", () => {
  test("saves forum rules as sanitised HTML and plain text", async () => {
    await withDb(async (database) => {
      const actor = await createMember(database, "Rules Admin");
      const [forum] = (await database.sql`
        INSERT INTO core.forums (title, slug, description)
        VALUES ('Rules forum', 'rules-forum', '')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (forum === undefined) {
        throw new Error("Could not create forum");
      }

      expect(
        await saveForumSettings(database.sql, actor, {
          id: forum.id,
          prefixIds: [],
          rules: "**Be kind.** [help](/help)\n\n<script>alert(1)</script>",
        }),
      ).toEqual({ ok: true });

      const [row] = (await database.sql`
        SELECT rules, rules_html, rules_text, rules_render_version, rules_sanitiser_version
        FROM core.forums WHERE id = ${forum.id}
      `) as Array<{
        rules: string;
        rules_html: string;
        rules_text: string;
        rules_render_version: number;
        rules_sanitiser_version: number;
      }>;

      expect(row?.rules).toContain("**Be kind.**");
      expect(row?.rules_html).toContain("<strong>Be kind.</strong>");
      expect(row?.rules_html).toContain('rel="nofollow ugc noopener"');
      expect(row?.rules_html).not.toContain("<script");
      expect(row?.rules_text).toContain("Be kind.");
      expect(row?.rules_render_version).toBeGreaterThan(0);
      expect(row?.rules_sanitiser_version).toBeGreaterThan(0);
    });
  });

  test("backfills rules and announcements that predate the rendered columns", async () => {
    await withDb(async (database) => {
      const versions = currentContentVersions();
      const [forum] = (await database.sql`
        INSERT INTO core.forums (title, slug, description, rules)
        VALUES ('Legacy forum', 'legacy-forum', '', '**Legacy rules**')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;
      const [announcement] = (await database.sql`
        INSERT INTO core.announcements (title, body, scope, starts_at)
        VALUES ('Legacy announcement', '**Legacy news**', 'global', now())
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (forum === undefined || announcement === undefined) {
        throw new Error("Could not create legacy rows");
      }

      await database.sql`
        UPDATE core.forums
        SET rules_render_version = ${versions.renderVersion},
          rules_sanitiser_version = ${versions.sanitiserVersion},
          rules_html = ''
        WHERE id = ${forum.id}
      `;
      await database.sql`
        UPDATE core.announcements
        SET render_version = ${versions.renderVersion},
          sanitiser_version = ${versions.sanitiserVersion},
          body_html = ''
        WHERE id = ${announcement.id}
      `;

      const result = await runContentRerenderJob(database.sql, {
        sources: [forumRulesRerenderSource, announcementRerenderSource],
      });
      expect(result.rerendered).toBe(2);

      const [renderedForum] = (await database.sql`
        SELECT rules_html FROM core.forums WHERE id = ${forum.id}
      `) as Array<{ rules_html: string }>;
      const [renderedAnnouncement] = (await database.sql`
        SELECT body_html FROM core.announcements WHERE id = ${announcement.id}
      `) as Array<{ body_html: string }>;

      expect(renderedForum?.rules_html).toContain("<strong>Legacy rules</strong>");
      expect(renderedAnnouncement?.body_html).toContain("<strong>Legacy news</strong>");
    });
  });

  test("replace-word re-renders persist the derived plain text", async () => {
    await withDb(async (database) => {
      const versions = currentContentVersions();
      const [forum] = (await database.sql`
        INSERT INTO core.forums (title, slug, description, rules)
        VALUES ('Replace forum', 'replace-forum', '', 'A damn rule')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;
      const [announcement] = (await database.sql`
        INSERT INTO core.announcements (title, body, scope, starts_at)
        VALUES ('Replace announcement', 'A damn notice', 'global', now())
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (forum === undefined || announcement === undefined) {
        throw new Error("Could not create rows");
      }

      await database.sql`
        UPDATE core.forums
        SET rules_render_version = ${versions.renderVersion - 7},
          rules_sanitiser_version = ${versions.sanitiserVersion},
          rules_html = ''
        WHERE id = ${forum.id}
      `;
      await database.sql`
        UPDATE core.announcements
        SET render_version = ${versions.renderVersion - 7},
          sanitiser_version = ${versions.sanitiserVersion},
          body_html = ''
        WHERE id = ${announcement.id}
      `;

      const result = await runContentRerenderJob(database.sql, {
        sources: [forumRulesRerenderSource, announcementRerenderSource],
        replaceWords: { version: 7, rules: [{ word: "damn", replacement: "darn" }] },
      });
      expect(result.rerendered).toBe(2);

      const [updatedForum] = (await database.sql`
        SELECT rules_text FROM core.forums WHERE id = ${forum.id}
      `) as Array<{ rules_text: string }>;
      const [updatedAnnouncement] = (await database.sql`
        SELECT body_text FROM core.announcements WHERE id = ${announcement.id}
      `) as Array<{ body_text: string }>;
      expect(updatedForum?.rules_text).toBe("A darn rule");
      expect(updatedAnnouncement?.body_text).toBe("A darn notice");
    });
  });

  test("refuses to overwrite a source row edited while it rendered", async () => {
    await withDb(async (database) => {
      const versions = currentContentVersions();
      const [forum] = (await database.sql`
        INSERT INTO core.forums (title, slug, description, rules, rules_html, rules_text)
        VALUES ('Concurrent forum', 'concurrent-forum', '', 'Old **rules**', '<p>old</p>', 'Old rules')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (forum === undefined) {
        throw new Error("Could not create forum");
      }

      await database.sql`
        UPDATE core.forums
        SET rules_render_version = ${versions.renderVersion - 1},
          rules_sanitiser_version = ${versions.sanitiserVersion}
        WHERE id = ${forum.id}
      `;

      const [stale] = await forumRulesRerenderSource.listStale(database.sql, versions, {
        afterId: "0",
        limit: 10,
      });

      if (stale === undefined) {
        throw new Error("Expected a stale row");
      }

      await database.sql`
        UPDATE core.forums
        SET rules = 'New **rules**', rules_html = '<p>new</p>', rules_text = 'New rules',
          rules_render_version = ${versions.renderVersion},
          rules_sanitiser_version = ${versions.sanitiserVersion}
        WHERE id = ${forum.id}
      `;

      const rendered = await forumRulesRerenderSource.render(stale, {});
      const saved = await forumRulesRerenderSource.save(database.sql, stale, rendered);
      expect(saved).toBe(false);

      const [row] = (await database.sql`
        SELECT rules, rules_html, rules_text FROM core.forums WHERE id = ${forum.id}
      `) as Array<{ rules: string; rules_html: string; rules_text: string }>;
      expect(row).toEqual({
        rules: "New **rules**",
        rules_html: "<p>new</p>",
        rules_text: "New rules",
      });
    });
  });

  test("saves announcements with rendered HTML and quote-free text", async () => {
    await withDb(async (database) => {
      const actor = await createMember(database, "Announcement Admin");

      expect(
        await saveAnnouncement(database.sql, actor, {
          title: "Maintenance",
          body: "**Tonight** we upgrade.\n\n<script>alert(1)</script>",
          scope: "global",
          startsAt: new Date(Date.now() - 60_000).toISOString(),
          endsAt: null,
          dismissible: true,
          targets: [],
          groupIds: [],
        }),
      ).toEqual({ ok: true });

      const [announcement] = await loadAnnouncements(database.sql);

      expect(announcement?.body).toContain("**Tonight**");
      expect(announcement?.bodyHtml).toContain("<strong>Tonight</strong>");
      expect(announcement?.bodyHtml).not.toContain("<script");
      expect(announcement?.bodyText).toContain("Tonight");
      expect(announcement?.renderVersion).toBeGreaterThan(0);
      expect(announcement?.sanitiserVersion).toBeGreaterThan(0);
    });
  });
});
