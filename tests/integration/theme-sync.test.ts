import { describe, expect, test } from "bun:test";
import { defaultThemeSourceHash, syncDefaultTheme } from "@bulletin/db/seed";
import { loadDefaultThemeTemplates, loadDefaultThemeTokens, loadTheme } from "@bulletin/templates";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "theme_sync" }, run);
}

async function sourceHash(database: TestDatabase): Promise<string | null> {
  const [row] = (await database.sql`
    SELECT source_hash FROM core.themes WHERE name = 'default'
  `) as Array<{ source_hash: string | null }>;

  return row?.source_hash ?? null;
}

integrationDescribe("default theme repository sync", () => {
  test("installs the repository copy and records its hash", async () => {
    await withDb(async (database) => {
      const [templates, tokens] = await Promise.all([
        loadDefaultThemeTemplates(),
        loadDefaultThemeTokens(),
      ]);
      const result = await syncDefaultTheme(database.sql);

      expect(result).toEqual({
        changed: true,
        version: 1,
        hash: defaultThemeSourceHash(templates, tokens),
      });
      expect(await sourceHash(database)).toBe(result.hash);

      const theme = await loadTheme(database.sql, "default");

      if (theme === null) {
        throw new Error("Expected the installed default theme");
      }

      expect([...theme.templates.keys()].sort()).toEqual(Object.keys(templates).sort());

      for (const [name, body] of Object.entries(templates)) {
        expect(theme.templates.get(name)?.[0]?.body).toBe(body);
      }

      const [themeRow] = (await database.sql`
        SELECT source, is_active FROM core.themes WHERE name = 'default'
      `) as Array<{ source: string; is_active: boolean }>;
      expect(themeRow).toEqual({ source: "core", is_active: true });

      const tokenRows = (await database.sql`
        SELECT scheme, tokens->>'accent' AS accent FROM core.theme_tokens
        WHERE theme_id = (SELECT id FROM core.themes WHERE name = 'default')
        ORDER BY scheme
      `) as Array<{ scheme: string; accent: string | null }>;
      expect(tokenRows).toHaveLength(2);
      expect(tokenRows[0]?.scheme).toBe("dark");
      expect(tokenRows[1]?.accent).toBe(tokens.light.accent);
    });
  });

  test("an unchanged hash is a no-op and leaves the stored copy alone", async () => {
    await withDb(async (database) => {
      const first = await syncDefaultTheme(database.sql);
      await database.sql`
        UPDATE core.theme_templates SET body = 'locally changed' WHERE name = 'footer'
      `;

      const second = await syncDefaultTheme(database.sql);

      expect(second).toEqual({ changed: false, version: first.version, hash: first.hash });
      expect(await sourceHash(database)).toBe(first.hash);

      const [row] = (await database.sql`
        SELECT body FROM core.theme_templates WHERE name = 'footer'
      `) as Array<{ body: string }>;
      expect(row?.body).toBe("locally changed");
    });
  });

  test("a changed repository hash replaces bodies, adds and removes templates", async () => {
    await withDb(async (database) => {
      const installed = await syncDefaultTheme(database.sql);
      const [repo, tokens] = await Promise.all([
        loadDefaultThemeTemplates(),
        loadDefaultThemeTokens(),
      ]);
      const footer = `${repo.footer ?? ""}\n<!-- repository change -->`;
      const updated = {
        ...repo,
        footer,
        "extra-template": "<p>New in the repository</p>",
      };
      const removed = Object.fromEntries(
        Object.entries(updated).filter(([name]) => name !== "login"),
      );
      const hash = defaultThemeSourceHash(removed);

      const result = await syncDefaultTheme(database.sql, { templates: removed, hash });

      expect(result).toEqual({ changed: true, version: installed.version + 1, hash });
      expect(await sourceHash(database)).toBe(hash);

      const theme = await loadTheme(database.sql, "default");

      if (theme === null) {
        throw new Error("Expected the default theme");
      }

      expect(theme.templates.get("footer")?.[0]?.body).toBe(footer);
      expect(theme.templates.get("extra-template")?.[0]?.body).toContain("New in the repository");
      expect(theme.templates.has("login")).toBe(false);
      expect(theme.templates.get("footer")?.[0]?.version).toBeGreaterThan(1);

      // Restoring the repository files is another hash change and restores every row.
      const restored = await syncDefaultTheme(database.sql);

      expect(restored).toEqual({
        changed: true,
        version: installed.version + 2,
        hash: defaultThemeSourceHash(repo, tokens),
      });

      const after = await loadTheme(database.sql, "default");
      expect(after?.templates.has("login")).toBe(true);
      expect(after?.templates.has("extra-template")).toBe(false);
    });
  });

  test("an upgraded default theme is restored to core and active on sync", async () => {
    await withDb(async (database) => {
      await syncDefaultTheme(database.sql);
      await database.sql`
        UPDATE core.themes SET source = 'custom', is_active = false WHERE name = 'default'
      `;

      await syncDefaultTheme(database.sql);

      const [row] = (await database.sql`
        SELECT source, is_active FROM core.themes WHERE name = 'default'
      `) as Array<{ source: string; is_active: boolean }>;
      expect(row).toEqual({ source: "core", is_active: true });
    });
  }, 60_000);

  test("a token-only repository change bumps the theme and updates storage", async () => {
    await withDb(async (database) => {
      const installed = await syncDefaultTheme(database.sql);
      const [templates, tokens] = await Promise.all([
        loadDefaultThemeTemplates(),
        loadDefaultThemeTokens(),
      ]);
      const changed = {
        light: { ...tokens.light, accent: "#112233" },
        dark: { ...tokens.dark, accent: "#ddeeff" },
      };
      const result = await syncDefaultTheme(database.sql, { templates, tokens: changed });

      expect(result.changed).toBe(true);
      expect(result.version).toBe(installed.version + 1);

      const [row] = (await database.sql`
        SELECT tokens->>'accent' AS accent FROM core.theme_tokens
        WHERE scheme = 'light'
          AND theme_id = (SELECT id FROM core.themes WHERE name = 'default')
      `) as Array<{ accent: string | null }>;
      expect(row?.accent).toBe("#112233");
    });
  }, 60_000);

  test("concurrent startup syncs install the theme once", async () => {
    await withDb(async (database) => {
      const results = await Promise.all([
        syncDefaultTheme(database.sql),
        syncDefaultTheme(database.sql),
        syncDefaultTheme(database.sql),
      ]);

      expect(results.filter((result) => result.changed)).toHaveLength(1);
      expect(new Set(results.map((result) => result.version)).size).toBe(1);

      const [row] = (await database.sql`
        SELECT count(*)::int AS count FROM core.themes WHERE name = 'default'
      `) as Array<{ count: number }>;
      expect(row?.count).toBe(1);
    });
  });
});
