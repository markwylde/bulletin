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
});
