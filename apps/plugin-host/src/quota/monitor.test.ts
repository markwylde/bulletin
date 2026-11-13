import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createLogger } from "@bulletin/config";
import { withTestDatabase } from "@bulletin/test-utils/database";
import { dropPlugin, PluginDatabase } from "../broker/database.ts";
import { assertAllowedSql } from "../broker/sql.ts";
import { PluginQuotaMonitor, usesSharedPluginCluster } from "./monitor.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const logger = createLogger({ service: "quota-test", level: "error", sink: () => {} });

const MIGRATIONS = [
  {
    name: "0001_notes.sql",
    sql: `
      CREATE TABLE IF NOT EXISTS notes (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        body text NOT NULL
      );
    `,
  },
];

function uniquePluginId(): string {
  return `quota-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
}

describe("shared plugin cluster warning", () => {
  test("warns only in production without a separate plugin cluster", () => {
    expect(usesSharedPluginCluster({ nodeEnv: "production" })).toBe(true);
    expect(usesSharedPluginCluster({ nodeEnv: "production", pluginDatabaseUrl: "  " })).toBe(true);
    expect(
      usesSharedPluginCluster({
        nodeEnv: "production",
        pluginDatabaseUrl: "postgres://plugins@plugin-db/bulletin",
      }),
    ).toBe(false);
    expect(usesSharedPluginCluster({ nodeEnv: "development" })).toBe(false);
    expect(usesSharedPluginCluster({ nodeEnv: "test" })).toBe(false);
  });
});

integrationDescribe("plugin storage quota", () => {
  test("revokes writes over quota until an admin restores them", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "plugin_quota" }, async (database) => {
      const pluginId = uniquePluginId();
      const plugin = await PluginDatabase.open({
        adminUrl: database.url,
        pluginId,
        migrations: MIGRATIONS,
        logger,
      });
      const run = async (sql: string) => {
        const statement = await assertAllowedSql(sql, {
          schema: plugin.schema,
          pluginFunctions: plugin.functions,
        });
        return plugin.query(sql, [], statement);
      };

      try {
        await run("INSERT INTO notes (body) VALUES ('before')");

        const monitor = new PluginQuotaMonitor({
          adminUrl: database.url,
          pluginId,
          logger,
          quotaBytes: 1,
          intervalMs: 60_000,
        });

        const status = await monitor.check();
        expect(status.exceeded).toBe(true);
        expect(status.writesRevoked).toBe(true);
        expect(status.usedBytes).toBeGreaterThan(1);
        expect(status.checkedAt).not.toBeNull();

        const audit = (await database.sql`
          SELECT action, target_type, summary->>'pluginId' AS plugin_id
          FROM core.system_audit_buffer
          WHERE action = 'plugin.quota_exceeded' AND summary->>'pluginId' = ${pluginId}
        `) as Array<{ action: string; target_type: string; plugin_id: string }>;
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({
          action: "plugin.quota_exceeded",
          target_type: "plugin",
          plugin_id: pluginId,
        });

        await expect(run("INSERT INTO notes (body) VALUES ('after')")).rejects.toThrow(
          /permission denied/i,
        );
        await expect(run("UPDATE notes SET body = 'changed'")).rejects.toThrow(
          /permission denied/i,
        );

        // Reads and deletes still work so an admin can inspect and clean up.
        const rows = await run("SELECT count(*)::int AS count FROM notes");
        expect(rows.rows[0]).toEqual({ count: 1 });
        await run("DELETE FROM notes WHERE body = 'before'");

        const revokedAgain = await monitor.check();
        expect(revokedAgain.writesRevoked).toBe(true);

        await monitor.restoreWrites();
        await run("INSERT INTO notes (body) VALUES ('restored')");
        expect(monitor.status().writesRevoked).toBe(false);
      } finally {
        await plugin.close().catch(() => undefined);
        await dropPlugin({ adminUrl: database.url, pluginId }).catch(() => undefined);
      }
    });
  }, 30_000);

  test("keeps writes revoked after a broker restart", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "plugin_quota_restart" }, async (database) => {
      const pluginId = uniquePluginId();
      let plugin = await PluginDatabase.open({
        adminUrl: database.url,
        pluginId,
        migrations: MIGRATIONS,
        logger,
      });
      let restarted: PluginDatabase | undefined;

      const run = async (target: PluginDatabase, sql: string) => {
        const statement = await assertAllowedSql(sql, {
          schema: target.schema,
          pluginFunctions: target.functions,
        });
        return target.query(sql, [], statement);
      };

      try {
        await run(plugin, "INSERT INTO notes (body) VALUES ('before')");

        const monitor = new PluginQuotaMonitor({
          adminUrl: database.url,
          pluginId,
          logger,
          quotaBytes: 1,
          intervalMs: 60_000,
        });
        expect((await monitor.check()).writesRevoked).toBe(true);

        const persisted = (await database.sql`
          SELECT writes_revoked FROM core.plugin_quota WHERE plugin_id = ${pluginId}
        `) as Array<{ writes_revoked: boolean }>;
        expect(persisted[0]?.writes_revoked).toBe(true);

        // Restart: provisioning must honour the persisted revocation instead of re-granting
        // INSERT/UPDATE on startup.
        await plugin.close();
        restarted = await PluginDatabase.open({
          adminUrl: database.url,
          pluginId,
          migrations: MIGRATIONS,
          logger,
        });

        await expect(run(restarted, "INSERT INTO notes (body) VALUES ('after')")).rejects.toThrow(
          /permission denied/i,
        );
        await expect(run(restarted, "UPDATE notes SET body = 'changed'")).rejects.toThrow(
          /permission denied/i,
        );
        expect((await run(restarted, "SELECT count(*)::int AS count FROM notes")).rows[0]).toEqual({
          count: 1,
        });

        // A restarted monitor reports the persisted state without repeating the revocation.
        const restartedMonitor = new PluginQuotaMonitor({
          adminUrl: database.url,
          pluginId,
          logger,
          quotaBytes: 1,
          intervalMs: 60_000,
        });
        const status = await restartedMonitor.check();
        expect(status.writesRevoked).toBe(true);

        const audits = (await database.sql`
          SELECT count(*)::int AS count
          FROM core.system_audit_buffer
          WHERE action = 'plugin.quota_exceeded' AND summary->>'pluginId' = ${pluginId}
        `) as Array<{ count: number }>;
        expect(audits[0]?.count).toBe(1);

        await restartedMonitor.restoreWrites();
        await run(restarted, "INSERT INTO notes (body) VALUES ('restored')");
      } finally {
        await plugin.close().catch(() => undefined);
        await restarted?.close().catch(() => undefined);
        await dropPlugin({ adminUrl: database.url, pluginId }).catch(() => undefined);
      }
    });
  }, 30_000);
});
