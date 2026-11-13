import { describe, expect, test } from "bun:test";
import { withTestDatabase } from "@bulletin/test-utils/database";
import { PluginCircuitBreaker } from "./breaker.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function plugin(db: { sql: import("bun").SQL }): Promise<void> {
  await db.sql`
    INSERT INTO core.plugins (plugin_id, version, sdk_version, state, enabled)
    VALUES ('welcome-bot', '1.0.0', '^2.0.0', 'active', true)
  `;
}

integrationDescribe("plugin circuit breaker", () => {
  test("auto-disables at the threshold and writes an admin notification", async () => {
    await withTestDatabase(
      { adminUrl: adminUrl as string, prefix: "plugin_breaker" },
      async (db) => {
        await plugin(db);
        let disabled = 0;
        const breaker = new PluginCircuitBreaker({
          sql: db.sql,
          threshold: 3,
          disable: async (pluginId) => {
            disabled += 1;
            await db.sql`
            UPDATE core.plugins SET state = 'disabled', enabled = false
            WHERE plugin_id = ${pluginId}
          `;
          },
        });

        expect(
          await breaker.recordFailure("welcome-bot", "home.view", new Error("timeout")),
        ).toEqual({
          failures: 1,
          disabled: false,
        });
        await breaker.recordSuccess("welcome-bot", "home.view");
        expect(await breaker.recordFailure("welcome-bot", "home.view", "timeout")).toEqual({
          failures: 1,
          disabled: false,
        });
        await breaker.recordFailure("welcome-bot", "home.view", "timeout");
        expect(await breaker.recordFailure("welcome-bot", "home.view", "timeout")).toEqual({
          failures: 3,
          disabled: true,
        });
        expect(disabled).toBe(1);

        const state = (await db.sql`
        SELECT state, enabled FROM core.plugins WHERE plugin_id = 'welcome-bot'
      `) as Array<{ state: string; enabled: boolean }>;
        expect(state[0]).toEqual({ state: "disabled", enabled: false });
        const audit = (await db.sql`
        SELECT summary FROM core.system_audit_buffer WHERE action = 'plugin.auto_disabled'
      `) as Array<{ summary: { pluginId: string; hook: string; failures: number } }>;
        expect(audit[0]?.summary).toMatchObject({
          pluginId: "welcome-bot",
          hook: "home.view",
          failures: 3,
        });

        expect(await breaker.status("welcome-bot")).toEqual([
          { hook: "home.view", failures: 3, disabledAt: expect.any(String) },
        ]);
      },
    );
  }, 20_000);
});
