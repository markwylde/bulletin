import { describe, expect, test } from "bun:test";
import { pluginSeedModule, runSeeds, SeedRegistry } from "@bulletin/db/seed";
import { withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

integrationDescribe("sample plugin seed", () => {
  test("seeds hide-post-count disabled and welcome-bot/tip-jar active", async () => {
    await withTestDatabase(
      { adminUrl: adminUrl as string, prefix: "plugin_seed" },
      async ({ sql }) => {
        const result = await runSeeds({
          sql,
          registry: new SeedRegistry([pluginSeedModule]),
        });
        expect(result.ran).toBe(true);

        const plugins = (await sql`
        SELECT plugin_id, state, enabled FROM core.plugins ORDER BY plugin_id
      `) as Array<{ plugin_id: string; state: string; enabled: boolean }>;
        expect(plugins).toEqual([
          { plugin_id: "hide-post-count", state: "disabled", enabled: false },
          { plugin_id: "tip-jar", state: "active", enabled: true },
          { plugin_id: "welcome-bot", state: "active", enabled: true },
        ]);

        const registry = (await sql`
        SELECT plugin_id, kind, key FROM core.plugin_registry
        ORDER BY plugin_id, kind, key
      `) as Array<{ plugin_id: string; kind: string; key: string }>;
        expect(registry).toEqual(
          expect.arrayContaining([
            { plugin_id: "tip-jar", kind: "flag", key: "plugin.tip-jar.tip_jar" },
            { plugin_id: "tip-jar", kind: "forum_action", key: "can_tip" },
            { plugin_id: "tip-jar", kind: "setting", key: "tip-jar" },
            { plugin_id: "welcome-bot", kind: "job", key: "digest" },
            { plugin_id: "welcome-bot", kind: "setting", key: "welcome-bot" },
          ]),
        );

        const fragments = (await sql`
        SELECT name, plugin_id FROM core.hook_fragments WHERE plugin_id IS NOT NULL
      `) as Array<{ name: string; plugin_id: string }>;
        expect(fragments).toEqual([{ name: "post.after.body", plugin_id: "tip-jar" }]);

        const personal = (await sql`
        SELECT plugin_id, table_name FROM core.plugin_personal_data ORDER BY plugin_id
      `) as Array<{ plugin_id: string; table_name: string }>;
        expect(personal).toEqual([
          { plugin_id: "tip-jar", table_name: "tips" },
          { plugin_id: "welcome-bot", table_name: "greetings" },
        ]);

        const events = (await sql`
        SELECT plugin_id, event_type FROM core.plugin_event_subscriptions
      `) as Array<{ plugin_id: string; event_type: string }>;
        expect(events).toEqual([{ plugin_id: "welcome-bot", event_type: "member.created" }]);
      },
    );
  }, 30_000);
});
