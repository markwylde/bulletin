import { describe, expect, test } from "bun:test";
import { runBaseSeed } from "@bulletin/db/seed";
import { allowedThemesForGroups, guestThemeId, loadThemeResources } from "@bulletin/domain/themes";
import { loadTheme } from "@bulletin/templates";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "theme_seed" }, run);
}

async function theme(database: TestDatabase, name: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT id::text AS id FROM core.themes WHERE name = ${name}
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing seeded theme ${name}`);
  }

  return row.id;
}

integrationDescribe("theme seed data", () => {
  test("seeds a child theme, a VIP theme and distinct tokens", async () => {
    await withDb(async (database) => {
      const first = await runBaseSeed({ databaseUrl: database.url });
      expect(first.ran).toBe(true);

      const defaultId = await theme(database, "default");
      const sunsetId = await theme(database, "sunset");
      const vipId = await theme(database, "vip-gold");
      const [parent] = (await database.sql`
        SELECT parent_id::text AS parent_id FROM core.themes WHERE id = ${sunsetId}
      `) as Array<{ parent_id: string }>;
      expect(parent?.parent_id).toBe(defaultId);

      const sunset = await loadTheme(database.sql, sunsetId);
      expect(sunset?.templates.get("footer")?.[0]?.body).toContain('data-theme-variant="sunset"');
      expect(sunset?.templates.get("header")?.[0]?.themeName).toBe("default");

      const resources = await loadThemeResources(
        database.sql,
        sunset?.chain.map((entry) => entry.id) ?? [],
      );
      expect(resources.tokens.light.accent).toBe("#5b3fa8");
      expect(resources.tokens.dark.accent).toBe("#c4b5fd");
      expect(resources.css).toContain("border-block-start-color");

      const groups = (await database.sql`
        SELECT id::text AS id, key FROM core.groups WHERE key IN ('members', 'vip')
      `) as Array<{ id: string; key: string }>;
      const group = (key: string) => groups.find((entry) => entry.key === key)?.id ?? "";

      expect(
        (await allowedThemesForGroups(database.sql, [group("vip")])).map((entry) => entry.id),
      ).toContain(vipId);
      expect(
        (await allowedThemesForGroups(database.sql, [group("members")])).map((entry) => entry.id),
      ).not.toContain(vipId);
      expect(await guestThemeId(database.sql, vipId)).toBeNull();
      expect((await allowedThemesForGroups(database.sql, [group("vip")])).length).toBeGreaterThan(
        1,
      );

      // A second seed run is a no-op and does not duplicate themes.
      const second = await runBaseSeed({ databaseUrl: database.url });
      expect(second).toMatchObject({ ran: false, modules: [] });
      const [count] = (await database.sql`
        SELECT count(*)::int AS count FROM core.themes WHERE name IN ('sunset', 'vip-gold')
      `) as Array<{ count: number }>;
      expect(count?.count).toBe(2);
    });
  }, 60_000);
});
