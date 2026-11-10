import { describe, expect, test } from "bun:test";
import { runBaseSeed } from "@bulletin/db/seed";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  return withTestDatabase({ adminUrl, prefix: "forum_seed" }, run);
}

integrationDescribe("forum seed", () => {
  test("seeds four categories, fifteen forums, three levels and the special forums", async () => {
    await withDb(async (database) => {
      await runBaseSeed({ databaseUrl: database.url });

      const [counts] = (await database.sql`
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE type = 'category')::int AS categories,
          count(*) FILTER (WHERE type = 'forum')::int AS forums,
          count(*) FILTER (WHERE type = 'redirect')::int AS redirects,
          count(*) FILTER (WHERE password_hash IS NOT NULL)::int AS passwords,
          max(nlevel(path))::int AS depth
        FROM core.forums
      `) as Array<{
        total: number;
        categories: number;
        forums: number;
        redirects: number;
        passwords: number;
        depth: number;
      }>;

      expect(counts).toEqual({
        total: 19,
        categories: 4,
        // Fourteen normal forums plus the redirect forum make the task's fifteen forums.
        forums: 14,
        redirects: 1,
        passwords: 1,
        depth: 3,
      });

      const [redirect] = (await database.sql`
        SELECT title, redirect_url FROM core.forums WHERE type = 'redirect'
      `) as Array<{ title: string; redirect_url: string }>;
      expect(redirect?.title).toBe("Community Handbook");
      expect(redirect?.redirect_url).toBe("https://example.com/handbook");

      const [staffOnly] = (await database.sql`
        SELECT f.id::text AS id
        FROM core.forums f
        WHERE f.slug = 'staff-room'
      `) as Array<{ id: string }>;
      const [member] = (await database.sql`
        SELECT member_id::text AS id FROM pii.identities WHERE sub = 'member-1'
      `) as Array<{ id: string }>;
      const [admin] = (await database.sql`
        SELECT member_id::text AS id FROM pii.identities WHERE sub = 'admin'
      `) as Array<{ id: string }>;

      if (staffOnly === undefined || member === undefined || admin === undefined) {
        throw new Error("Missing seeded forum or member");
      }

      const [flag] = (await database.sql`
        SELECT default_value, affects_render FROM core.feature_flags WHERE key = 'announcements'
      `) as Array<{ default_value: boolean; affects_render: boolean }>;
      expect(flag).toEqual({ default_value: true, affects_render: true });

      const [visibility] = (await database.sql`
        SELECT
          core.can_read_forum(${member.id}, ${staffOnly.id}) AS member_visible,
          core.can_read_forum(${admin.id}, ${staffOnly.id}) AS admin_visible
      `) as Array<{ member_visible: boolean; admin_visible: boolean }>;

      expect(visibility).toEqual({ member_visible: false, admin_visible: true });
    });
  }, 30_000);

  test("seeds prefixes, per-forum prefix sets and announcements", async () => {
    await withDb(async (database) => {
      await runBaseSeed({ databaseUrl: database.url });

      const [prefixes] = (await database.sql`
        SELECT
          count(*)::int AS total,
          (SELECT count(*)::int FROM core.prefix_labels) AS labels,
          (SELECT count(*)::int FROM core.prefix_groups) AS groups,
          (SELECT count(*)::int FROM core.forum_prefixes) AS forum_links
        FROM core.prefixes
      `) as Array<{ total: number; labels: number; groups: number; forum_links: number }>;

      expect(prefixes).toEqual({ total: 4, labels: 12, groups: 3, forum_links: 10 });

      const labels = (await database.sql`
        SELECT p.key, pl.locale, pl.label
        FROM core.prefix_labels pl
        JOIN core.prefixes p ON p.id = pl.prefix_id
        WHERE p.key = 'solved'
        ORDER BY pl.locale
      `) as Array<{ key: string; locale: string; label: string }>;

      expect(labels.map((row) => row.label)).toEqual(["Solved", "Resuelto", "Résolu"]);

      const [required] = (await database.sql`
        SELECT prefix_mode FROM core.forums WHERE slug = 'help-questions'
      `) as Array<{ prefix_mode: string }>;
      expect(required?.prefix_mode).toBe("required");

      const [announcements] = (await database.sql`
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE scope = 'global')::int AS global,
          count(*) FILTER (WHERE scope = 'forums')::int AS forums,
          count(*) FILTER (WHERE dismissible)::int AS dismissible
        FROM core.announcements
      `) as Array<{ total: number; global: number; forums: number; dismissible: number }>;

      expect(announcements).toMatchObject({ total: 5, global: 2, forums: 3, dismissible: 4 });

      const [supportTarget] = (await database.sql`
        SELECT include_subforums
        FROM core.announcement_targets t
        JOIN core.announcements a ON a.id = t.announcement_id
        WHERE a.title = 'How to ask for help'
      `) as Array<{ include_subforums: boolean }>;
      expect(supportTarget?.include_subforums).toBe(true);

      const groupTargets = (await database.sql`
        SELECT a.title, g.key
        FROM core.announcement_groups ag
        JOIN core.announcements a ON a.id = ag.announcement_id
        JOIN core.groups g ON g.id = ag.group_id
        ORDER BY a.title, g.key
      `) as Array<{ title: string; key: string }>;

      expect(groupTargets).toContainEqual({ title: "Staff briefing", key: "administrators" });
      expect(groupTargets).toContainEqual({ title: "Staff briefing", key: "super_moderators" });
      expect(groupTargets).toContainEqual({ title: "VIP update", key: "vip" });
    });
  }, 30_000);

  test("is a no-op once the database is seeded", async () => {
    await withDb(async (database) => {
      const first = await runBaseSeed({ databaseUrl: database.url });
      const second = await runBaseSeed({ databaseUrl: database.url });

      expect(first.ran).toBe(true);
      expect(second.ran).toBe(false);
    });
  }, 30_000);
});
