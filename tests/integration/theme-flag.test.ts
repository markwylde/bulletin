import { describe, expect, test } from "bun:test";
import { bumpFlagTag } from "@bulletin/db/flags";
import {
  baseSeedModule,
  flagsSeedModule,
  forumSeedModule,
  groupsSeedModule,
  membersSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import { createServerT } from "@bulletin/i18n";
import { loadTheme } from "@bulletin/templates";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { createUserApiFlags } from "../../apps/user-api/src/flag-guard.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { loadViewerFlags } from "../../apps/user-app/src/flags.ts";
import { pageVariant } from "../../apps/user-app/src/theme/cached-route.ts";
import { renderThemedPage, themeChooserView } from "../../apps/user-app/src/theme/render.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "theme_flag" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        forumSeedModule,
        groupsSeedModule,
        membersSeedModule,
        flagsSeedModule,
        themesSeedModule,
      ]),
    });
    await run(database);
  });
}

async function setChooser(sql: TestDatabase["sql"], enabled: boolean): Promise<void> {
  await sql`
    UPDATE core.feature_flags SET default_value = ${enabled} WHERE key = 'theme_chooser'
  `;
  await bumpFlagTag(sql);
}

async function footerFlags(database: TestDatabase, enabled: boolean): Promise<string> {
  const theme = await loadTheme(database.sql, "default");

  if (theme === null) {
    throw new Error("Missing default theme");
  }

  const page = await renderThemedPage({
    sql: database.sql,
    boardName: "Bulletin",
    locale: "en",
    translate,
    template: "footer",
    viewModel: {
      year: 2026,
      flags: { theme_chooser: enabled },
      themeChooser: themeChooserView(translate),
    },
    breadcrumbs: [],
    route: { route: "/", requiredIslands: [] },
    theme,
    regions: [],
  });

  return page.html;
}

integrationDescribe("theme_chooser flag", () => {
  test("is on in the seed and gates the templates, route and cache variant", async () => {
    await withDb(async (database) => {
      const on = await loadViewerFlags(database.sql, null);
      expect(on.values.theme_chooser).toBe(true);
      expect(on.clientFlags.theme_chooser).toBe(true);

      const guard = createUserApiFlags(database.sql);
      const allowed = await guard.guard("theme_chooser", null)(new Request("http://x/"), () =>
        Response.json({ ok: true }),
      );
      expect(allowed.status).toBe(200);

      const enabledFooter = await footerFlags(database, true);
      expect(enabledFooter).toContain('<bl-island data-name="ThemeChooser"');

      await setChooser(database.sql, false);

      const off = await loadViewerFlags(database.sql, null);
      expect(off.values.theme_chooser).toBe(false);
      expect(off.clientFlags.theme_chooser).toBe(false);
      expect(off.hash).not.toBe(on.hash);

      const denied = await guard.guard("theme_chooser", null)(new Request("http://x/"), () =>
        Response.json({ ok: true }),
      );
      expect(denied.status).toBe(404);

      expect(await footerFlags(database, false)).not.toContain("ThemeChooser");

      const theme = await loadTheme(database.sql, "default");
      const base = {
        route: "/",
        visibilityKey: "public",
        theme,
        pluginsGeneration: 1,
        locale: "en" as const,
        colourScheme: "system" as const,
      };
      expect(pageVariant({ ...base, renderFlagsHash: on.hash })).not.toBe(
        pageVariant({ ...base, renderFlagsHash: off.hash }),
      );
    });
  }, 60_000);
});
