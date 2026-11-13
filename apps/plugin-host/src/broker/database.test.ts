import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createLogger } from "@bulletin/config";
import { withTestDatabase } from "@bulletin/test-utils/database";
import { SQL } from "bun";
import { PluginConnectionManager } from "./connections.ts";
import {
  dropPlugin,
  PluginDatabase,
  PluginNamespaceCollisionError,
  pluginIdentifiers,
  pluginRoleUrl,
} from "./database.ts";
import { MigrationDeniedError } from "./migration.ts";
import { assertAllowedSql } from "./sql.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const logger = createLogger({ service: "plugin-db-test", level: "error", sink: () => {} });

const MIGRATIONS = [
  {
    name: "0001_notes.sql",
    sql: `
      CREATE TABLE IF NOT EXISTS notes (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        body text NOT NULL
      );
      CREATE OR REPLACE FUNCTION note_count() RETURNS bigint
      LANGUAGE sql STABLE AS $$ SELECT count(*) FROM notes $$;
    `,
  },
];

function uniquePluginId(): string {
  return `broker-db-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
}

function runtimeUrl(databaseUrl: string, role: string): string {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = "";
  return url.toString();
}

describe("plugin role URLs", () => {
  test("keeps broker-held runtime passwords", () => {
    expect(pluginRoleUrl("postgres://admin@db:5432/bulletin", "plugin_x", "secret-token")).toBe(
      "postgres://plugin_x:secret-token@db:5432/bulletin",
    );
    expect(pluginRoleUrl("postgres://admin@db:5432/bulletin", "plugin_migrator", "migrator")).toBe(
      "postgres://plugin_migrator:migrator@db:5432/bulletin",
    );
  });
});

integrationDescribe("plugin database roles", () => {
  test("provisions owner and runtime roles and runs migrations as the owner", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "plugin_roles" }, async (database) => {
      const pluginId = uniquePluginId();
      const identifiers = pluginIdentifiers(pluginId);
      let plugin: PluginDatabase | undefined;

      try {
        plugin = await PluginDatabase.open({
          adminUrl: database.url,
          pluginId,
          migrations: MIGRATIONS,
          logger,
        });

        expect(plugin.schema).toBe(identifiers.schema);
        expect([...plugin.functions]).toEqual(["note_count"]);

        const roles = (await database.sql`
          SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolconnlimit, rolconfig
          FROM pg_roles
          WHERE rolname IN (${identifiers.runtimeRole}, ${identifiers.ownerRole})
          ORDER BY rolname
        `) as Array<{
          rolname: string;
          rolcanlogin: boolean;
          rolsuper: boolean;
          rolcreatedb: boolean;
          rolcreaterole: boolean;
          rolconnlimit: number;
          rolconfig: string[] | null;
        }>;

        const owner = roles.find((role) => role.rolname === identifiers.ownerRole);
        const runtime = roles.find((role) => role.rolname === identifiers.runtimeRole);

        expect(owner).toMatchObject({
          rolcanlogin: false,
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
        });
        expect(runtime).toMatchObject({
          rolcanlogin: true,
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolconnlimit: 2,
        });
        expect(runtime?.rolconfig).toContain(`search_path=${identifiers.schema}`);
        expect(owner?.rolconfig).toContain(`search_path=${identifiers.schema}`);

        const ownership = (await database.sql`
          SELECT
            (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = ${identifiers.schema}) AS schema_owner,
            (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relnamespace = (
              SELECT oid FROM pg_namespace WHERE nspname = ${identifiers.schema}
            ) AND relname = 'notes') AS table_owner
        `) as Array<{ schema_owner: string; table_owner: string }>;

        expect(ownership[0]).toEqual({
          schema_owner: identifiers.ownerRole,
          table_owner: identifiers.ownerRole,
        });

        // The role has CONNECTION LIMIT 2; close the plugin pool before borrowing a slot.
        await plugin.close();
        plugin = undefined;

        const runtimeConnection = new SQL(runtimeUrl(database.url, identifiers.runtimeRole), {
          max: 2,
          connectionTimeout: 5,
        });

        try {
          const settings = (await runtimeConnection`
            SELECT
              current_user AS user_name,
              current_setting('statement_timeout') AS statement_timeout,
              current_setting('idle_in_transaction_session_timeout') AS idle_timeout,
              current_setting('search_path') AS search_path
          `) as Array<{
            user_name: string;
            statement_timeout: string;
            idle_timeout: string;
            search_path: string;
          }>;

          expect(settings[0]).toEqual({
            user_name: identifiers.runtimeRole,
            statement_timeout: "2s",
            idle_timeout: "5s",
            search_path: identifiers.schema,
          });
        } finally {
          await runtimeConnection.close();
        }
      } finally {
        await plugin?.close();
        await dropPlugin({ adminUrl: database.url, pluginId });
      }
    });
  }, 20_000);

  test("runtime role can use DML and its functions but no DDL or other schemas", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "plugin_dml" }, async (database) => {
      const pluginId = uniquePluginId();
      const identifiers = pluginIdentifiers(pluginId);
      let plugin: PluginDatabase | undefined;

      try {
        plugin = await PluginDatabase.open({
          adminUrl: database.url,
          pluginId,
          migrations: MIGRATIONS,
          logger,
        });
        const policy = { schema: plugin.schema, pluginFunctions: plugin.functions };

        const insert = await assertAllowedSql(
          "INSERT INTO notes (body) VALUES ($1) RETURNING id",
          policy,
        );
        const inserted = await plugin.query(
          "INSERT INTO notes (body) VALUES ($1) RETURNING id",
          ["first"],
          insert,
        );
        expect(inserted.rows).toHaveLength(1);
        expect(inserted.command).toBe("insert");

        const select = await assertAllowedSql("SELECT body FROM notes", policy);
        const selected = await plugin.query("SELECT body FROM notes", [], select);
        expect(selected.rows).toEqual([{ body: "first" }]);

        const count = await assertAllowedSql("SELECT note_count()", policy);
        expect(await plugin.query("SELECT note_count()", [], count)).toMatchObject({
          rows: [{ note_count: 1 }],
        });

        const huge = await assertAllowedSql("SELECT repeat('x', 4194304) AS body", policy);
        await expect(plugin.query("SELECT repeat('x', 4194304) AS body", [], huge)).rejects.toThrow(
          "too large",
        );

        // Compressible values can have a small pg_column_size; the budget must measure the
        // expanded JSON instead.
        const insertCompressed = await assertAllowedSql(
          "INSERT INTO notes (body) VALUES (repeat('a', 2097152))",
          policy,
        );
        await plugin.query(
          "INSERT INTO notes (body) VALUES (repeat('a', 2097152))",
          [],
          insertCompressed,
        );
        const compressed = await assertAllowedSql("SELECT body FROM notes", policy);
        await expect(plugin.query("SELECT body FROM notes", [], compressed)).rejects.toThrow(
          "too large",
        );

        const recovered = await assertAllowedSql("SELECT 1 AS ok", policy);
        expect(await plugin.query("SELECT 1 AS ok", [], recovered)).toMatchObject({
          rows: [{ ok: 1 }],
        });

        // The role has CONNECTION LIMIT 2, so run the denial checks on the admin pool with
        // SET LOCAL ROLE instead of opening a second pool for the same role.
        const asRuntime = async (run: (transaction: SQL) => Promise<unknown>): Promise<unknown> =>
          database.sql.begin(async (transaction) => {
            await transaction.unsafe(`SET LOCAL ROLE ${identifiers.runtimeRole}`);
            return run(transaction);
          });

        await expect(
          asRuntime((transaction) =>
            transaction.unsafe(`CREATE TABLE ${identifiers.schema}.evil (id int)`),
          ),
        ).rejects.toThrow(/permission denied/i);
        await expect(
          asRuntime((transaction) => transaction`SELECT * FROM core.cache_tags`),
        ).rejects.toThrow(/permission denied/i);
        await expect(
          asRuntime((transaction) => transaction`SELECT * FROM pii.sessions`),
        ).rejects.toThrow(/permission denied/i);

        const adminView = (await database.sql`
          SELECT count(*)::int AS count
          FROM pg_tables
          WHERE schemaname = ${identifiers.schema} AND tablename = 'evil'
        `) as Array<{ count: number }>;
        expect(adminView[0]?.count).toBe(0);
      } finally {
        await plugin?.close();
        await dropPlugin({ adminUrl: database.url, pluginId });
      }
    });
  }, 20_000);

  test("runs migrations through the NOINHERIT plugin_migrator role", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "plugin_migrator" }, async (database) => {
      const pluginId = uniquePluginId();
      const identifiers = pluginIdentifiers(pluginId);
      let plugin: PluginDatabase | undefined;

      try {
        plugin = await PluginDatabase.open({
          adminUrl: database.url,
          pluginId,
          migrations: MIGRATIONS,
          logger,
        });

        const rows = (await database.sql`
          SELECT rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole
          FROM pg_roles WHERE rolname = 'plugin_migrator'
        `) as Array<{
          rolcanlogin: boolean;
          rolinherit: boolean;
          rolsuper: boolean;
          rolcreatedb: boolean;
          rolcreaterole: boolean;
        }>;
        expect(rows[0]).toEqual({
          rolcanlogin: true,
          rolinherit: false,
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
        });

        const membership = (await database.sql`
          SELECT count(*)::int AS count
          FROM pg_auth_members m
          JOIN pg_roles member ON member.oid = m.member
          JOIN pg_roles granted ON granted.oid = m.roleid
          WHERE member.rolname = 'plugin_migrator' AND granted.rolname = ${identifiers.ownerRole}
        `) as Array<{ count: number }>;
        expect(membership[0]?.count).toBe(1);
      } finally {
        await plugin?.close();
        await dropPlugin({ adminUrl: database.url, pluginId });
      }
    });
  }, 20_000);

  test("rejects a migration that tries to reset the role", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "plugin_bad_migration" }, async (database) => {
      const pluginId = uniquePluginId();
      const identifiers = pluginIdentifiers(pluginId);

      await expect(
        PluginDatabase.open({
          adminUrl: database.url,
          pluginId,
          migrations: [
            {
              name: "0001_evil.sql",
              sql: `
                CREATE TABLE notes (body text);
                RESET ROLE;
                CREATE TABLE core.evil (id int);
              `,
            },
          ],
          logger,
        }),
      ).rejects.toBeInstanceOf(MigrationDeniedError);

      const rows = (await database.sql`
        SELECT
          (SELECT count(*)::int FROM pg_namespace WHERE nspname = ${identifiers.schema}) AS schemas,
          (SELECT count(*)::int FROM pg_roles
            WHERE rolname IN (${identifiers.runtimeRole}, ${identifiers.ownerRole})) AS roles
      `) as Array<{ schemas: number; roles: number }>;
      expect(rows[0]).toEqual({ schemas: 0, roles: 0 });

      await dropPlugin({ adminUrl: database.url, pluginId }).catch(() => undefined);
    });
  }, 20_000);

  test("rejects a plpgsql function that calls a revoked built-in", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "plugin_bad_function" }, async (database) => {
      const pluginId = uniquePluginId();

      await expect(
        PluginDatabase.open({
          adminUrl: database.url,
          pluginId,
          migrations: [
            {
              name: "0001_evil.sql",
              sql: `
                CREATE FUNCTION notify_evil() RETURNS void
                LANGUAGE plpgsql AS $$
                BEGIN
                  PERFORM pg_notify('session_revoked', '1');
                END
                $$;
              `,
            },
          ],
          logger,
        }),
      ).rejects.toThrow(/pg_notify/);

      await dropPlugin({ adminUrl: database.url, pluginId }).catch(() => undefined);
    });
  }, 20_000);

  test("revokes side-effecting built-ins from the runtime role", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "plugin_revokes" }, async (database) => {
      const pluginId = uniquePluginId();
      const identifiers = pluginIdentifiers(pluginId);
      let plugin: PluginDatabase | undefined;

      try {
        plugin = await PluginDatabase.open({
          adminUrl: database.url,
          pluginId,
          migrations: MIGRATIONS,
          logger,
        });

        const asRuntime = async (sql: string): Promise<unknown> =>
          database.sql.begin(async (transaction) => {
            await transaction.unsafe(`SET LOCAL ROLE ${identifiers.runtimeRole}`);
            return transaction.unsafe(sql);
          });

        for (const sql of [
          "SELECT set_config('search_path', 'core', false)",
          "SELECT pg_notify('session_revoked', '1')",
          "SELECT pg_advisory_lock(1)",
          "SELECT pg_sleep(0.1)",
        ]) {
          await expect(asRuntime(sql)).rejects.toThrow(/permission denied/i);
        }

        // The plugin owner is not a core role either: migration functions get no private
        // back door to the revoked built-ins.
        await expect(
          database.sql.begin(async (transaction) => {
            await transaction.unsafe(`SET LOCAL ROLE ${identifiers.ownerRole}`);
            return transaction`SELECT pg_advisory_xact_lock(42)`;
          }),
        ).rejects.toThrow(/permission denied/i);
      } finally {
        await plugin?.close();
        await dropPlugin({ adminUrl: database.url, pluginId });
      }
    });
  }, 20_000);

  test("cancels a statement past its deadline from the control connection", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "plugin_deadline" }, async (database) => {
      const pluginId = uniquePluginId();
      let plugin: PluginDatabase | undefined;

      try {
        plugin = await PluginDatabase.open({
          adminUrl: database.url,
          pluginId,
          migrations: MIGRATIONS,
          logger,
          statementTimeoutMs: 150,
        });
        const statement = await assertAllowedSql(
          "SELECT count(*) FROM generate_series(1, 1000000000)",
          { schema: plugin.schema, pluginFunctions: plugin.functions },
        );
        const started = performance.now();

        await expect(
          plugin.query("SELECT count(*) FROM generate_series(1, 1000000000)", [], statement),
        ).rejects.toThrow();

        expect(performance.now() - started).toBeLessThan(1_500);
      } finally {
        await plugin?.close();
        await dropPlugin({ adminUrl: database.url, pluginId });
      }
    });
  }, 20_000);

  test("uses the shared lazy connection budget and closes idle plugin pools", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "plugin_lazy" }, async (database) => {
      const ids = [uniquePluginId(), uniquePluginId()];
      const connections = new PluginConnectionManager({
        adminUrl: database.url,
        idleTimeoutMs: 20,
      });
      const plugins: PluginDatabase[] = [];

      try {
        for (const pluginId of ids) {
          plugins.push(
            await PluginDatabase.open({
              adminUrl: database.url,
              pluginId,
              migrations: MIGRATIONS,
              logger,
              connections,
            }),
          );
        }

        for (const plugin of plugins) {
          const statement = await assertAllowedSql("SELECT 1 AS ok", {
            schema: plugin.schema,
            pluginFunctions: plugin.functions,
          });
          expect(await plugin.query("SELECT 1 AS ok", [], statement)).toMatchObject({
            rows: [{ ok: 1 }],
          });
        }

        expect(connections.stats().open).toBe(2);
        await Bun.sleep(60);
        expect(connections.stats()).toMatchObject({ open: 0, closed: 2 });

        // The next call reopens lazily and still works.
        const statement = await assertAllowedSql("SELECT 1 AS ok", {
          schema: plugins[0]?.schema ?? "",
          pluginFunctions: plugins[0]?.functions ?? new Set(),
        });
        expect(await plugins[0]?.query("SELECT 1 AS ok", [], statement)).toMatchObject({
          rows: [{ ok: 1 }],
        });
      } finally {
        await Promise.all(plugins.map((plugin) => plugin.close().catch(() => undefined)));
        await connections.close();
        for (const pluginId of ids) {
          await dropPlugin({ adminUrl: database.url, pluginId }).catch(() => undefined);
        }
      }
    });
  }, 30_000);

  test("provisioning the same plugin twice is idempotent", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "plugin_idempotent" }, async (database) => {
      const pluginId = uniquePluginId();
      let first: PluginDatabase | undefined;
      let second: PluginDatabase | undefined;

      try {
        first = await PluginDatabase.open({
          adminUrl: database.url,
          pluginId,
          migrations: MIGRATIONS,
          logger,
        });
        const firstSchema = first.schema;
        const firstFunctions = [...first.functions];
        await first.close();
        first = undefined;

        second = await PluginDatabase.open({
          adminUrl: database.url,
          pluginId,
          migrations: MIGRATIONS,
          logger,
        });

        expect(second.schema).toBe(firstSchema);
        expect([...second.functions]).toEqual(firstFunctions);
      } finally {
        await second?.close();
        await first?.close();
        await dropPlugin({ adminUrl: database.url, pluginId });
      }
    });
  }, 20_000);

  test("keeps colliding plugin ids in disjoint roles and uninstalls only its own", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "plugin_collide" }, async (database) => {
      // `demo-owner` used to become `plugin_demo_owner`, which was plugin `demo`'s owner role,
      // and `migrator` used to become the platform's `plugin_migrator` login role.
      const ids = ["demo", "demo-owner", "migrator"] as const;
      const migrations = [
        {
          name: "0001_items.sql",
          sql: `
            CREATE TABLE items (body text NOT NULL);
            INSERT INTO items (body) VALUES ('row');
          `,
        },
      ];
      const plugins = new Map<string, PluginDatabase>();

      try {
        for (const pluginId of ids) {
          // Clean leftovers from an interrupted earlier run of this test.
          await dropPlugin({ adminUrl: database.url, pluginId }).catch(() => undefined);
          plugins.set(
            pluginId,
            await PluginDatabase.open({
              adminUrl: database.url,
              pluginId,
              migrations,
              logger,
            }),
          );
        }

        const namespaces = ids.map((pluginId) => pluginIdentifiers(pluginId));
        const allNames = namespaces.flatMap((entry) => [
          entry.schema,
          entry.runtimeRole,
          entry.ownerRole,
        ]);
        expect(new Set(allNames).size).toBe(allNames.length);

        const migratorRole = (await database.sql`
          SELECT 1 FROM pg_roles WHERE rolname = 'plugin_migrator'
        `) as unknown[];
        expect(migratorRole).toHaveLength(1);

        // Each runtime role sees its own schema only.
        for (const namespace of namespaces) {
          const plugin = plugins.get(namespace.pluginId);

          if (plugin === undefined) {
            throw new Error("Missing provisioned plugin");
          }

          const own = await assertAllowedSql("SELECT body FROM items", {
            schema: plugin.schema,
            pluginFunctions: plugin.functions,
          });
          expect(await plugin.query("SELECT body FROM items", [], own)).toMatchObject({
            rows: [{ body: "row" }],
          });

          for (const sibling of namespaces) {
            if (sibling.pluginId === namespace.pluginId) {
              continue;
            }

            await expect(
              database.sql.begin(async (transaction) => {
                await transaction.unsafe(`SET LOCAL ROLE ${namespace.runtimeRole}`);
                return transaction.unsafe(`SELECT * FROM "${sibling.schema}".items`);
              }),
            ).rejects.toThrow(/permission denied/i);
          }
        }

        // Uninstalling `demo` drops only its own namespace.
        const demo = plugins.get("demo");
        await demo?.close();
        plugins.delete("demo");
        await dropPlugin({ adminUrl: database.url, pluginId: "demo" });

        const demoOwner = plugins.get("demo-owner");

        if (demoOwner === undefined) {
          throw new Error("Missing demo-owner plugin");
        }

        const select = await assertAllowedSql("SELECT count(*)::int AS count FROM items", {
          schema: demoOwner.schema,
          pluginFunctions: demoOwner.functions,
        });
        expect(
          await demoOwner.query("SELECT count(*)::int AS count FROM items", [], select),
        ).toMatchObject({ rows: [{ count: 1 }] });

        const demoRoles = (await database.sql`
          SELECT count(*)::int AS count FROM pg_roles
          WHERE rolname IN (${pluginIdentifiers("demo").runtimeRole}, ${pluginIdentifiers("demo").ownerRole})
        `) as Array<{ count: number }>;
        expect(demoRoles[0]?.count).toBe(0);

        // Uninstalling the plugin called `migrator` must never drop `plugin_migrator`.
        const migrator = plugins.get("migrator");
        await migrator?.close();
        plugins.delete("migrator");
        await dropPlugin({ adminUrl: database.url, pluginId: "migrator" });

        const migratorAfter = (await database.sql`
          SELECT rolcanlogin FROM pg_roles WHERE rolname = 'plugin_migrator'
        `) as Array<{ rolcanlogin: boolean }>;
        expect(migratorAfter).toEqual([{ rolcanlogin: true }]);
      } finally {
        await Promise.all(
          [...plugins.values()].map((plugin) => plugin.close().catch(() => undefined)),
        );

        for (const pluginId of ids) {
          await dropPlugin({ adminUrl: database.url, pluginId }).catch(() => undefined);
        }
      }
    });
  }, 60_000);

  test("refuses a derived role that belongs to another owner", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "plugin_foreign_role" }, async (database) => {
      const pluginId = "demo-owner";
      const identifiers = pluginIdentifiers(pluginId);

      await dropPlugin({ adminUrl: database.url, pluginId }).catch(() => undefined);
      await database.sql.unsafe(`CREATE ROLE ${identifiers.runtimeRole} NOLOGIN`);

      try {
        await expect(
          PluginDatabase.open({
            adminUrl: database.url,
            pluginId,
            migrations: MIGRATIONS,
            logger,
          }),
        ).rejects.toBeInstanceOf(PluginNamespaceCollisionError);

        // The foreign role was not taken over, and no schema was created in its name.
        const rows = (await database.sql`
          SELECT
            (SELECT count(*)::int FROM pg_roles WHERE rolname = ${identifiers.runtimeRole}) AS roles,
            (SELECT count(*)::int FROM pg_namespace WHERE nspname = ${identifiers.schema}) AS schemas
        `) as Array<{ roles: number; schemas: number }>;
        expect(rows[0]).toEqual({ roles: 1, schemas: 0 });

        await expect(dropPlugin({ adminUrl: database.url, pluginId })).rejects.toBeInstanceOf(
          PluginNamespaceCollisionError,
        );
      } finally {
        await database.sql.unsafe(`DROP OWNED BY ${identifiers.runtimeRole}`);
        await database.sql.unsafe(`DROP ROLE IF EXISTS ${identifiers.runtimeRole}`);
        await dropPlugin({ adminUrl: database.url, pluginId }).catch(() => undefined);
      }
    });
  }, 20_000);

  test("drops the schema and both roles", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "plugin_drop" }, async (database) => {
      const pluginId = uniquePluginId();
      const identifiers = pluginIdentifiers(pluginId);
      const plugin = await PluginDatabase.open({
        adminUrl: database.url,
        pluginId,
        migrations: MIGRATIONS,
        logger,
      });

      await plugin.close();
      await dropPlugin({ adminUrl: database.url, pluginId });

      const rows = (await database.sql`
        SELECT
          (SELECT count(*)::int FROM pg_roles
            WHERE rolname IN (${identifiers.runtimeRole}, ${identifiers.ownerRole})) AS roles,
          (SELECT count(*)::int FROM pg_namespace WHERE nspname = ${identifiers.schema}) AS schemas
      `) as Array<{ roles: number; schemas: number }>;

      expect(rows[0]).toEqual({ roles: 0, schemas: 0 });
    });
  }, 20_000);
});
