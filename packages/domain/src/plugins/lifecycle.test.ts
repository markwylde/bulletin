import { describe, expect, test } from "bun:test";
import { type PluginManifest, parsePluginManifest } from "@bulletin/plugin-sdk/manifest";
import { withTestDatabase } from "@bulletin/test-utils/database";
import {
  type GdprResult,
  loadPlugin,
  PluginLifecycle,
  type PluginRecord,
  type PluginRuntime,
} from "./lifecycle.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
function manifest(overrides: Record<string, unknown> = {}): PluginManifest {
  return parsePluginManifest({
    id: "welcome-bot",
    name: "Welcome bot",
    version: "1.0.0",
    sdkVersion: "^2.0.0",
    entry: "server.ts",
    capabilities: ["events", "core.read"],
    migrations: ["migrations/0001.sql"],
    personalData: [{ table: "greetings", memberColumn: "member_id" }],
    ...overrides,
  });
}

class FakeRuntime implements PluginRuntime {
  readonly calls: string[] = [];
  readonly migrations = new Map<string, string>();
  failMigrate = false;
  failActivate = false;
  gdprResult: GdprResult = { ok: true, data: {} };
  generation = 2;

  async provision(record: PluginRecord): Promise<void> {
    this.calls.push(`provision:${record.pluginId}`);
  }

  async migrate(_record: PluginRecord, value: PluginManifest): Promise<void> {
    this.calls.push(`migrate:${value.version}`);
    this.migrations.set(value.version, "applied");

    if (this.failMigrate) {
      this.migrations.delete(value.version);
      throw new Error("second migration failed");
    }
  }

  async activate(record: PluginRecord, _value: PluginManifest): Promise<boolean> {
    this.calls.push(`activate:${record.version}`);
    return !this.failActivate;
  }

  async quiesce(record: PluginRecord): Promise<void> {
    this.calls.push(`quiesce:${record.pluginId}`);
  }

  async deactivate(record: PluginRecord): Promise<void> {
    this.calls.push(`deactivate:${record.pluginId}`);
  }

  async drop(record: PluginRecord): Promise<void> {
    this.calls.push(`drop:${record.pluginId}`);
  }

  async maintenance(_record: PluginRecord, operation: "export" | "erase"): Promise<GdprResult> {
    this.calls.push(`maintenance:${operation}`);
    return this.gdprResult;
  }

  async gdpr(_record: PluginRecord, operation: "export" | "erase"): Promise<GdprResult> {
    this.calls.push(`active-gdpr:${operation}`);
    return this.gdprResult;
  }

  async refreshGeneration(): Promise<number> {
    this.calls.push("refresh");
    return this.generation;
  }
}

function installInput(value = manifest()) {
  return {
    manifest: value,
    bundle: new TextEncoder().encode("bundle"),
    checksum: "c".repeat(64),
    signature: "sig",
    approved: true,
    stepUpAt: new Date(),
    actorId: "admin-1",
  };
}

integrationDescribe("plugin lifecycle", () => {
  test("requires approval and recent step-up before writing anything", async () => {
    await withTestDatabase(
      { adminUrl: adminUrl as string, prefix: "plugin_lifecycle" },
      async (db) => {
        const runtime = new FakeRuntime();
        const service = new PluginLifecycle({ sql: db.sql, runtime });
        const old = new Date(Date.now() - 10 * 60 * 1_000);

        await expect(service.install({ ...installInput(), approved: false })).rejects.toMatchObject(
          {
            code: "approval",
          },
        );
        await expect(service.install({ ...installInput(), stepUpAt: old })).rejects.toMatchObject({
          code: "step_up",
        });

        expect(await loadPlugin(db.sql, "welcome-bot")).toBeNull();
        expect(runtime.calls).toEqual([]);
      },
    );
  }, 20_000);

  test("installs, records personal data and activates", async () => {
    await withTestDatabase(
      { adminUrl: adminUrl as string, prefix: "plugin_install" },
      async (db) => {
        const runtime = new FakeRuntime();
        const service = new PluginLifecycle({ sql: db.sql, runtime, now: () => new Date() });
        const installed = await service.install(installInput());

        expect(installed).toMatchObject({
          pluginId: "welcome-bot",
          version: "1.0.0",
          state: "active",
          enabled: true,
        });
        expect(runtime.calls).toEqual([
          "provision:welcome-bot",
          "migrate:1.0.0",
          "activate:1.0.0",
          "refresh",
        ]);

        const personal = (await db.sql`
        SELECT table_name, member_column FROM core.plugin_personal_data
        WHERE plugin_id = 'welcome-bot'
      `) as Array<{ table_name: string; member_column: string }>;
        expect(personal).toEqual([{ table_name: "greetings", member_column: "member_id" }]);

        const audit = (await db.sql`
        SELECT action FROM core.system_audit_buffer WHERE action = 'plugin.installed'
      `) as Array<{ action: string }>;
        expect(audit).toHaveLength(1);
      },
    );
  }, 20_000);

  test("a failed upgrade migration restores the old version", async () => {
    await withTestDatabase(
      { adminUrl: adminUrl as string, prefix: "plugin_upgrade" },
      async (db) => {
        const runtime = new FakeRuntime();
        const service = new PluginLifecycle({ sql: db.sql, runtime });
        await service.install(installInput());
        runtime.calls.length = 0;
        runtime.failMigrate = true;
        const next = manifest({ version: "2.0.0" });

        await expect(service.upgrade("welcome-bot", installInput(next))).rejects.toMatchObject({
          code: "migration",
        });
        const state = await loadPlugin(db.sql, "welcome-bot");
        expect(state).toMatchObject({ state: "active", enabled: true, version: "1.0.0" });
        expect(runtime.calls).toEqual(["quiesce:welcome-bot", "migrate:2.0.0", "activate:1.0.0"]);
        expect(runtime.migrations.get("2.0.0")).toBeUndefined();
      },
    );
  }, 20_000);

  test("a failed new activation marks the plugin failed and disabled", async () => {
    await withTestDatabase(
      { adminUrl: adminUrl as string, prefix: "plugin_activate" },
      async (db) => {
        const runtime = new FakeRuntime();
        const service = new PluginLifecycle({ sql: db.sql, runtime });
        await service.install(installInput());
        runtime.failActivate = true;
        const next = manifest({ version: "2.0.0" });

        await expect(service.upgrade("welcome-bot", installInput(next))).rejects.toMatchObject({
          code: "activation",
        });
        expect(await loadPlugin(db.sql, "welcome-bot")).toMatchObject({
          state: "failed",
          enabled: false,
          version: "2.0.0",
        });
        const audit = (await db.sql`
        SELECT action FROM core.system_audit_buffer WHERE action = 'plugin.upgrade_failed'
      `) as Array<{ action: string }>;
        expect(audit).toHaveLength(1);
      },
    );
  }, 20_000);

  test("disable stops the sandbox, keeps data and bumps the generation", async () => {
    await withTestDatabase(
      { adminUrl: adminUrl as string, prefix: "plugin_disable" },
      async (db) => {
        const runtime = new FakeRuntime();
        const service = new PluginLifecycle({ sql: db.sql, runtime });
        await service.install(installInput());
        const before = (await db.sql`SELECT generation FROM core.plugin_generation`) as Array<{
          generation: number;
        }>;

        const disabled = await service.disable("welcome-bot", "test");
        expect(disabled).toMatchObject({ state: "disabled", enabled: false });
        expect(runtime.calls).toContain("deactivate:welcome-bot");
        const after = (await db.sql`SELECT generation FROM core.plugin_generation`) as Array<{
          generation: number;
        }>;
        expect(after[0]?.generation ?? 0).toBeGreaterThan(before[0]?.generation ?? 0);

        const personal = (await db.sql`
        SELECT count(*)::int AS count FROM core.plugin_personal_data
        WHERE plugin_id = 'welcome-bot'
      `) as Array<{ count: number }>;
        expect(personal[0]?.count).toBe(1);
      },
    );
  }, 20_000);

  test("uninstall keeps data and declarations, or drops the schema when asked", async () => {
    await withTestDatabase(
      { adminUrl: adminUrl as string, prefix: "plugin_uninstall" },
      async (db) => {
        const runtime = new FakeRuntime();
        const service = new PluginLifecycle({ sql: db.sql, runtime });
        await service.install(installInput());
        await db.sql`
        INSERT INTO core.plugin_registry (plugin_id, kind, key, definition)
        VALUES ('welcome-bot', 'flag', 'welcome', '{}'::jsonb)
      `;

        await service.uninstall("welcome-bot", { dataAction: "keep", actorId: "admin-1" });
        expect(await loadPlugin(db.sql, "welcome-bot")).toMatchObject({
          state: "uninstalled",
          enabled: false,
        });
        expect(runtime.calls).not.toContain("drop:welcome-bot");
        const registry = (await db.sql`
        SELECT count(*)::int AS count FROM core.plugin_registry WHERE plugin_id = 'welcome-bot'
      `) as Array<{ count: number }>;
        expect(registry[0]?.count).toBe(0);
        const personal = (await db.sql`
        SELECT count(*)::int AS count FROM core.plugin_personal_data
        WHERE plugin_id = 'welcome-bot'
      `) as Array<{ count: number }>;
        expect(personal[0]?.count).toBe(1);

        runtime.calls.length = 0;
        await service.install(installInput(manifest({ version: "1.1.0" })));
        await service.uninstall("welcome-bot", { dataAction: "drop", actorId: "admin-1" });
        expect(runtime.calls).toContain("drop:welcome-bot");
      },
    );
  }, 30_000);

  test("resumes an interrupted upgrade from the journal and reuses completed steps", async () => {
    await withTestDatabase(
      { adminUrl: adminUrl as string, prefix: "plugin_resume" },
      async (db) => {
        const runtime = new FakeRuntime();
        const service = new PluginLifecycle({ sql: db.sql, runtime });
        await service.install(installInput());
        const next = manifest({ version: "2.0.0" });
        await db.sql`
        UPDATE core.plugins SET state = 'upgrading', enabled = false WHERE plugin_id = 'welcome-bot'
      `;
        await db.sql`
        INSERT INTO core.plugin_operations (plugin_id, kind, step, state)
        VALUES ('welcome-bot', 'upgrade', 'quiesce', 'completed')
      `;

        const resumed = await service.resume("welcome-bot", next);
        expect(resumed).toMatchObject({ state: "active", enabled: true, version: "2.0.0" });
        expect(runtime.calls).toContain("migrate:2.0.0");
      },
    );
  }, 20_000);

  test("a later interrupted upgrade never reuses a previous upgrade's migration step", async () => {
    await withTestDatabase(
      { adminUrl: adminUrl as string, prefix: "plugin_resume_target" },
      async (db) => {
        const runtime = new FakeRuntime();
        const service = new PluginLifecycle({ sql: db.sql, runtime });
        await service.install(installInput());
        await service.upgrade("welcome-bot", installInput(manifest({ version: "2.0.0" })));

        await db.sql`
        UPDATE core.plugins SET state = 'upgrading', enabled = false WHERE plugin_id = 'welcome-bot'
      `;
        await db.sql`
        INSERT INTO core.plugin_operations (plugin_id, kind, step, state, target_version)
        VALUES ('welcome-bot', 'upgrade', 'migrate', 'completed', '2.0.0')
      `;
        runtime.calls.length = 0;

        const resumed = await service.resume("welcome-bot", manifest({ version: "3.0.0" }));
        expect(resumed).toMatchObject({ state: "active", version: "3.0.0" });
        expect(runtime.calls).toContain("migrate:3.0.0");
      },
    );
  }, 30_000);

  test("GDPR uses the active sandbox or a maintenance sandbox and keeps failures open", async () => {
    await withTestDatabase({ adminUrl: adminUrl as string, prefix: "plugin_gdpr" }, async (db) => {
      const runtime = new FakeRuntime();
      const service = new PluginLifecycle({ sql: db.sql, runtime });
      await service.install(installInput());

      await expect(service.gdpr("welcome-bot", "export", "7")).resolves.toEqual({
        ok: true,
        data: {},
      });
      expect(runtime.calls).toContain("active-gdpr:export");

      await service.disable("welcome-bot");
      runtime.calls.length = 0;
      runtime.gdprResult = { ok: true, data: { rows: 1 } };
      await expect(service.gdpr("welcome-bot", "export", "7")).resolves.toEqual({
        ok: true,
        data: { rows: 1 },
      });
      expect(runtime.calls).toContain("maintenance:export");
      // The maintenance sandbox only runs the GDPR handler; it never starts hooks/routes.
      expect(runtime.calls.some((call) => call.startsWith("activate:"))).toBe(false);

      await service.gdpr("welcome-bot", "erase", "7");
      expect(runtime.calls).toContain("maintenance:erase");

      runtime.gdprResult = { ok: false, error: "handler down" };
      const failed = await service.gdpr("welcome-bot", "erase", "7");
      expect(failed).toMatchObject({ ok: false, error: "handler down" });
      const open = (await db.sql`
        SELECT status FROM core.plugin_gdpr_requests
        WHERE plugin_id = 'welcome-bot' ORDER BY id DESC LIMIT 1
      `) as Array<{ status: string }>;
      expect(open[0]?.status).toBe("failed");
    });
  }, 20_000);
});
