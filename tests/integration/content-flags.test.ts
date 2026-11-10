import { describe, expect, test } from "bun:test";
import { bumpFlagTag, loadStoredFlags, syncFlagDefinitions } from "@bulletin/db/flags";
import {
  baseSeedModule,
  emoticonSeedModule,
  flagsSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import { CODE_FLAG_DEFINITIONS } from "@bulletin/flags";
import { createTemplateEngine, loadDefaultThemeTemplates, safeHtml } from "@bulletin/templates";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { SERVER_ISLANDS } from "@bulletin/ui/islands/server";
import { createUserApiFlags } from "../../apps/user-api/src/flag-guard.ts";
import { loadViewerFlags } from "../../apps/user-app/src/flags.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "content_flags" }, run);
}

integrationDescribe("content feature flags", () => {
  test("declares both flags off, seeds them on, and changes the render variant when toggled", async () => {
    await withDb(async (database) => {
      await syncFlagDefinitions(database.sql, CODE_FLAG_DEFINITIONS);
      const stored = await loadStoredFlags(database.sql);

      expect(stored.find((flag) => flag.key === "unfurls")).toMatchObject({
        defaultValue: false,
        affectsRender: true,
      });
      expect(stored.find((flag) => flag.key === "mentions")).toMatchObject({
        defaultValue: false,
        affectsRender: true,
        clientVisible: true,
      });

      const off = await loadViewerFlags(database.sql, null);

      await database.sql`
        UPDATE core.feature_flags
        SET default_value = true, rules = '[]'::jsonb, updated_at = now()
        WHERE key IN ('unfurls', 'mentions')
      `;
      await bumpFlagTag(database.sql);
      const on = await loadViewerFlags(database.sql, null);

      expect(on.values.mentions).toBe(true);
      expect(on.values.unfurls).toBe(true);
      expect(on.hash).not.toBe(off.hash);
    });
  });

  test("seeds both flags on for local development", async () => {
    await withDb(async (database) => {
      await runSeeds({
        sql: database.sql,
        registry: new SeedRegistry([
          baseSeedModule,
          emoticonSeedModule,
          flagsSeedModule,
          themesSeedModule,
        ]),
      });

      const stored = await loadStoredFlags(database.sql);
      expect(stored.find((flag) => flag.key === "mentions")?.defaultValue).toBe(true);
      expect(stored.find((flag) => flag.key === "unfurls")?.defaultValue).toBe(true);
    });
  });

  test("requireFlag hides the mention route when the flag is off", async () => {
    await withDb(async (database) => {
      await syncFlagDefinitions(database.sql, CODE_FLAG_DEFINITIONS);
      const flags = createUserApiFlags(database.sql);
      const request = new Request("http://api.test/api/members/suggest?q=jo");
      const next = () => Response.json({ ok: true });

      expect((await flags.guard("mentions", null)(request, next)).status).toBe(404);

      await database.sql`
        UPDATE core.feature_flags
        SET default_value = true, rules = '[]'::jsonb, updated_at = now()
        WHERE key = 'mentions'
      `;
      await bumpFlagTag(database.sql);

      expect((await flags.guard("mentions", null)(request, next)).status).toBe(200);
    });
  });

  test("templates gate the mentions and unfurls markers on their flags", async () => {
    const templates = await loadDefaultThemeTemplates();
    const engine = createTemplateEngine({ islands: SERVER_ISLANDS });
    const runtime = {
      translate: (key: string) => key,
      hooks: {},
    };
    const render = async (flags: { mentions: boolean; unfurls: boolean }): Promise<string> => {
      const html = await engine.render(
        engine.compile(templates.demo ?? ""),
        {
          header: safeHtml(""),
          footer: safeHtml(""),
          breadcrumbs: safeHtml(""),
          emptyState: safeHtml(""),
          forumId: "1",
          forumTitle: "Editor",
          isCategory: false,
          locked: false,
          topics: [],
          children: [],
          showModTools: false,
          showDeleted: false,
          editor: null,
          flags,
          clientFlagsJson: "{}",
        },
        runtime,
      );

      return html;
    };

    const off = await render({ mentions: false, unfurls: false });
    const on = await render({ mentions: true, unfurls: true });

    expect(off).not.toContain("data-mentions-enabled");
    expect(off).not.toContain("data-unfurls-enabled");
    expect(on).toContain("data-mentions-enabled");
    expect(on).toContain("data-unfurls-enabled");
  });
});
