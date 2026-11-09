import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createLogger } from "@bulletin/config";
import { withTestDatabase } from "@bulletin/test-utils/database";
import { SQL } from "bun";
import { dropPlugin, PluginDatabase, pluginIdentifiers } from "./database.ts";
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
