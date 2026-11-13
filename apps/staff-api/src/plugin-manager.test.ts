import { describe, expect, test } from "bun:test";
import { withTestDatabase } from "@bulletin/test-utils/database";
import type { SQL } from "bun";
import {
  disablePlugin,
  extensionSections,
  listPlugins,
  pluginSettings,
  pluginsEnabled,
  savePluginSettings,
  uninstallPlugin,
} from "./plugin-manager.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

const DEFINITION = {
  id: "demo",
  extensionPoint: "acp.groups.settings",
  sections: [
    {
      id: "main",
      titleKey: "plugin.demo.settings.title",
      fields: [
        {
          id: "greeting",
          type: "text",
          labelKey: "plugin.demo.greeting",
          required: true,
          maxLength: 40,
        },
      ],
    },
  ],
};

async function seed(sql: SQL): Promise<void> {
  await sql`
    INSERT INTO core.plugins (
      plugin_id, name, version, sdk_version, state, enabled, generation, capabilities,
      timings, service_principal_group
    ) VALUES (
      'sandbox-demo', 'Sandbox demo', '1.0.0', '^2.0.0', 'active', true, 3,
      '["events","core.read"]'::jsonb, '{"activationMs":30}'::jsonb, 'Guests'
    )
  `;
  await sql`
    INSERT INTO core.plugin_registry (plugin_id, kind, key, definition)
    VALUES ('sandbox-demo', 'setting', 'sandbox-demo', (${JSON.stringify(DEFINITION)}::text)::jsonb)
  `;
  await sql`
    INSERT INTO core.plugin_breaker (plugin_id, hook, failures, last_error)
    VALUES ('sandbox-demo', 'home.view', 7, 'timeout')
  `;
  await sql`
    INSERT INTO core.plugin_operations (plugin_id, kind, step, state, error)
    VALUES ('sandbox-demo', 'upgrade', 'migrate', 'failed', 'second migration failed')
  `;
}

describe("uninstall identifier validation", () => {
  test("rejects a malicious plugin id before building DDL", async () => {
    await expect(
      uninstallPlugin(
        (async () => []) as never,
        'x"; DROP TABLE core.members; --',
        "admin",
        "drop",
      ),
    ).rejects.toThrow("Invalid plugin id");
  });
});

integrationDescribe("staff plugin manager", () => {
  test("the global plugins flag gates the staff plugin API", async () => {
    await withTestDatabase(
      { adminUrl: adminUrl as string, prefix: "staff_plugin_flag" },
      async (db) => {
        await db.sql`
        INSERT INTO core.feature_flags (key, description, owner, default_value)
        VALUES ('plugins', 'test', 'test', false)
      `;
        expect(await pluginsEnabled(db.sql)).toBe(false);
        await db.sql`UPDATE core.feature_flags SET default_value = true WHERE key = 'plugins'`;
        expect(await pluginsEnabled(db.sql)).toBe(true);
      },
    );
  }, 20_000);

  test("lists state, capabilities, timings, breaker, errors and fixed page types", async () => {
    await withTestDatabase(
      { adminUrl: adminUrl as string, prefix: "staff_plugins" },
      async (db) => {
        await seed(db.sql);
        const [plugin] = await listPlugins(db.sql);

        expect(plugin).toMatchObject({
          id: "sandbox-demo",
          name: "Sandbox demo",
          version: "1.0.0",
          state: "active",
          enabled: true,
          generation: 3,
          timings: { activationMs: 30 },
        });
        expect(plugin?.capabilities.map((entry) => entry.capability)).toEqual([
          "events",
          "core.read",
        ]);
        expect(plugin?.breaker).toEqual([{ hook: "home.view", failures: 7, disabledAt: null }]);
        expect(plugin?.errors[0]).toMatchObject({
          step: "migrate",
          error: "second migration failed",
        });
        expect(plugin?.pages.map((page) => page.kind)).toEqual(["form", "table", "log"]);
      },
    );
  }, 20_000);

  test("validates settings and never touches core group settings", async () => {
    await withTestDatabase(
      { adminUrl: adminUrl as string, prefix: "staff_settings" },
      async (db) => {
        await seed(db.sql);
        const before = (await db.sql`
        SELECT count(*)::int AS count FROM core.group_settings
      `) as Array<{ count: number }>;

        const invalid = await savePluginSettings(
          db.sql,
          "sandbox-demo",
          { greeting: "" },
          "admin-1",
        );
        expect(invalid.ok).toBe(false);
        expect(invalid.errors?.greeting?.code).toBe("required");

        const valid = await savePluginSettings(
          db.sql,
          "sandbox-demo",
          { greeting: "Hello" },
          "admin-1",
        );
        expect(valid).toEqual({ ok: true });
        expect(await pluginSettings(db.sql, "sandbox-demo")).toMatchObject({
          values: { greeting: "Hello" },
        });

        const after = (await db.sql`
        SELECT count(*)::int AS count FROM core.group_settings
      `) as Array<{ count: number }>;
        expect(after[0]?.count).toBe(before[0]?.count);
      },
    );
  }, 20_000);

  test("exposes extension sections and disables a plugin with a generation bump", async () => {
    await withTestDatabase(
      { adminUrl: adminUrl as string, prefix: "staff_extensions" },
      async (db) => {
        await seed(db.sql);
        expect(await extensionSections(db.sql, "acp.groups.settings")).toEqual([
          { pluginId: "sandbox-demo", definition: DEFINITION as never },
        ]);
        expect(await extensionSections(db.sql, "acp.forums.edit")).toEqual([]);

        const before = (await db.sql`SELECT generation FROM core.plugin_generation`) as Array<{
          generation: number;
        }>;
        await disablePlugin(db.sql, "sandbox-demo", "admin-1");
        const [plugin] = await listPlugins(db.sql);
        expect(plugin).toMatchObject({ state: "disabled", enabled: false });
        const after = (await db.sql`SELECT generation FROM core.plugin_generation`) as Array<{
          generation: number;
        }>;
        expect(after[0]?.generation ?? 0).toBeGreaterThan(before[0]?.generation ?? 0);
      },
    );
  }, 20_000);
});
