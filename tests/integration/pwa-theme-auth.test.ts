import { describe, expect, test } from "bun:test";
import {
  baseSeedModule,
  demoThemesSeedModule,
  forumSeedModule,
  groupsSeedModule,
  membersSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { resolvePwaTheme } from "../../apps/user-app/src/pwa/theme.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "pwa_theme_auth" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        forumSeedModule,
        groupsSeedModule,
        themesSeedModule,
        demoThemesSeedModule,
        membersSeedModule,
      ]),
    });
    await run(database);
  });
}

async function themeId(database: TestDatabase, name: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT id::text AS id FROM core.themes WHERE name = ${name}
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing theme ${name}`);
  }

  return row.id;
}

async function memberCookie(database: TestDatabase, token: string): Promise<string> {
  const [member] = (await database.sql`
    SELECT member_id::text AS id FROM pii.identities WHERE sub = 'member-1'
  `) as Array<{ id: string }>;

  if (member === undefined) {
    throw new Error("Missing member-1");
  }

  await database.sql`
    INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
    VALUES (
      ${member.id}, 'user', sha256(convert_to(${token}, 'UTF8')), now() + interval '24 hours'
    )
  `;

  return `bl_session=${token}`;
}

integrationDescribe("PWA explicit theme authorization", () => {
  test("a guest can use an open theme but not a restricted one", async () => {
    await withDb(async (database) => {
      const sunset = await themeId(database, "sunset");
      const vip = await themeId(database, "vip-gold");
      const fallback = await themeId(database, "default");

      const allowed = await resolvePwaTheme(database.sql, null, { id: sunset, version: 1 });
      expect(allowed.manifest.id).toBe(sunset);
      expect(allowed.manifest.tokens.accent).toBe("#5b3fa8");

      const denied = await resolvePwaTheme(database.sql, null, { id: vip, version: 1 });
      expect(denied.manifest.id).toBe(fallback);
      expect(denied.manifest.tokens.accent).toBe("#3157c7");
    });
  }, 60_000);

  test("a member without the theme's group is denied the explicit reference", async () => {
    await withDb(async (database) => {
      const sunset = await themeId(database, "sunset");
      const vip = await themeId(database, "vip-gold");
      const fallback = await themeId(database, "default");
      const cookie = await memberCookie(database, "theme-member-session");

      const allowed = await resolvePwaTheme(database.sql, cookie, { id: sunset, version: 1 });
      expect(allowed.manifest.id).toBe(sunset);

      const denied = await resolvePwaTheme(database.sql, cookie, { id: vip, version: 1 });
      expect(denied.manifest.id).toBe(fallback);
      expect(denied.manifest.tokens.accent).toBe("#3157c7");
    });
  }, 60_000);
});
