import type { Logger } from "@bulletin/config";
import { SQL } from "bun";
import type { PluginMigration } from "./manifest.ts";
import { type AllowedStatement, applyResultLimit } from "./sql.ts";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,48}$/;
const DEFAULT_MAX_ROWS = 1_000;

export interface PluginIdentifiers {
  readonly pluginId: string;
  readonly schema: string;
  readonly runtimeRole: string;
  readonly ownerRole: string;
}

export interface PluginDatabaseOptions {
  /** The installer/control connection, used only during provisioning. */
  readonly adminUrl: string;
  readonly pluginId: string;
  readonly migrations: readonly PluginMigration[];
  readonly logger: Logger;
  readonly maxRows?: number;
}

export interface QueryResult {
  readonly rows: unknown[];
  readonly rowCount: number;
  readonly command: string;
}

export class QueryLimitError extends Error {
  constructor(maxRows: number) {
    super(`Query returned more than ${maxRows} rows`);
    this.name = "QueryLimitError";
  }
}

/** Identifier mapping shared by the installer, the broker and the tests. */
export function pluginIdentifiers(pluginId: string): PluginIdentifiers {
  if (!ID_PATTERN.test(pluginId)) {
    throw new TypeError("Plugin id must be 1-49 lowercase letters, digits or hyphens");
  }

  const normalized = pluginId.replaceAll("-", "_");
  return {
    pluginId,
    schema: `plugin_${normalized}`,
    runtimeRole: `plugin_${normalized}`,
    ownerRole: `plugin_${normalized}_owner`,
  };
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function ensureRole(sql: SQL, name: string, login: boolean): Promise<void> {
  const rows = (await sql`SELECT 1 FROM pg_roles WHERE rolname = ${name}`) as unknown[];

  if (rows.length === 0) {
    await sql.unsafe(`CREATE ROLE ${quote(name)} ${login ? "LOGIN" : "NOLOGIN"}`);
  }
}

/**
 * Provisions the two roles and the schema from ADR 0009, runs the plugin's migrations as the
 * owner, then opens the DML-only runtime pool. In the real installer this runs from
 * `plugin_migrator`; the spike uses the local Postgres administrator.
 */
export class PluginDatabase {
  readonly identifiers: PluginIdentifiers;
  readonly #sql: SQL;
  readonly #maxRows: number;
  readonly #functions: ReadonlySet<string>;

  private constructor(
    identifiers: PluginIdentifiers,
    sql: SQL,
    functions: ReadonlySet<string>,
    maxRows: number,
  ) {
    this.identifiers = identifiers;
    this.#sql = sql;
    this.#functions = functions;
    this.#maxRows = maxRows;
  }

  get schema(): string {
    return this.identifiers.schema;
  }

  get functions(): ReadonlySet<string> {
    return this.#functions;
  }

  get ready(): boolean {
    return true;
  }

  static async open(options: PluginDatabaseOptions): Promise<PluginDatabase> {
    const identifiers = pluginIdentifiers(options.pluginId);
    const admin = new SQL(options.adminUrl, { max: 1, connectionTimeout: 5 });
    let runtime: SQL | undefined;

    try {
      await ensureRole(admin, identifiers.ownerRole, false);
      await ensureRole(admin, identifiers.runtimeRole, true);

      await admin.unsafe(`
        ALTER ROLE ${quote(identifiers.ownerRole)}
          NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
        ALTER ROLE ${quote(identifiers.runtimeRole)}
          LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT
          CONNECTION LIMIT 2;
        ALTER ROLE ${quote(identifiers.runtimeRole)}
          SET statement_timeout = '2s';
        ALTER ROLE ${quote(identifiers.runtimeRole)}
          SET idle_in_transaction_session_timeout = '5s';
        ALTER ROLE ${quote(identifiers.runtimeRole)}
          SET work_mem = '8MB';
        ALTER ROLE ${quote(identifiers.runtimeRole)}
          SET temp_file_limit = '64MB';
        ALTER ROLE ${quote(identifiers.runtimeRole)}
          SET maintenance_work_mem = '16MB';
        ALTER ROLE ${quote(identifiers.ownerRole)}
          SET search_path = ${quote(identifiers.schema)};
        ALTER ROLE ${quote(identifiers.runtimeRole)}
          SET search_path = ${quote(identifiers.schema)};
      `);

      await admin.unsafe(`
        CREATE SCHEMA IF NOT EXISTS ${quote(identifiers.schema)}
          AUTHORIZATION ${quote(identifiers.ownerRole)};
        ALTER SCHEMA ${quote(identifiers.schema)}
          OWNER TO ${quote(identifiers.ownerRole)};
        REVOKE ALL ON SCHEMA ${quote(identifiers.schema)} FROM PUBLIC;
        GRANT USAGE ON SCHEMA ${quote(identifiers.schema)} TO ${quote(identifiers.runtimeRole)};
      `);

      if (options.migrations.length > 0) {
        await admin.begin(async (transaction) => {
          await transaction.unsafe(`SET LOCAL ROLE ${quote(identifiers.ownerRole)}`);
          await transaction.unsafe(`SET LOCAL search_path = ${quote(identifiers.schema)}`);

          for (const migration of options.migrations) {
            options.logger.debug("plugin.migration", { name: migration.name });
            await transaction.unsafe(migration.sql);
          }
        });
      }

      await admin.unsafe(`
        GRANT SELECT, INSERT, UPDATE, DELETE
          ON ALL TABLES IN SCHEMA ${quote(identifiers.schema)}
          TO ${quote(identifiers.runtimeRole)};
        GRANT USAGE, SELECT
          ON ALL SEQUENCES IN SCHEMA ${quote(identifiers.schema)}
          TO ${quote(identifiers.runtimeRole)};
        GRANT EXECUTE
          ON ALL FUNCTIONS IN SCHEMA ${quote(identifiers.schema)}
          TO ${quote(identifiers.runtimeRole)};
        ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(identifiers.ownerRole)}
          IN SCHEMA ${quote(identifiers.schema)}
          GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${quote(identifiers.runtimeRole)};
        ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(identifiers.ownerRole)}
          IN SCHEMA ${quote(identifiers.schema)}
          GRANT USAGE, SELECT ON SEQUENCES TO ${quote(identifiers.runtimeRole)};
        ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(identifiers.ownerRole)}
          IN SCHEMA ${quote(identifiers.schema)}
          GRANT EXECUTE ON FUNCTIONS TO ${quote(identifiers.runtimeRole)};
        REVOKE ALL ON SCHEMA core FROM ${quote(identifiers.runtimeRole)};
        REVOKE ALL ON SCHEMA pii FROM ${quote(identifiers.runtimeRole)};
        REVOKE ALL ON SCHEMA public FROM ${quote(identifiers.runtimeRole)};
      `);

      const functionRows = (await admin`
        SELECT p.proname AS name
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = ${identifiers.schema}
      `) as Array<{ name: string }>;
      const functions = new Set(functionRows.map((row) => row.name));

      runtime = new SQL(runtimeUrl(options.adminUrl, identifiers.runtimeRole), {
        max: 2,
        connectionTimeout: 5,
      });

      await runtime`SELECT 1`;

      options.logger.info("plugin.database_ready", {
        schema: identifiers.schema,
        functions: functions.size,
      });

      return new PluginDatabase(
        identifiers,
        runtime,
        functions,
        options.maxRows ?? DEFAULT_MAX_ROWS,
      );
    } catch (error) {
      await runtime?.close().catch(() => undefined);
      throw error;
    } finally {
      await admin.close().catch(() => undefined);
    }
  }

  /** Runs a validated statement with the result-row cap applied. */
  async query(
    sql: string,
    params: readonly unknown[],
    statement: AllowedStatement,
  ): Promise<QueryResult> {
    const text = applyResultLimit(sql, statement, this.#maxRows);
    const result = await this.#sql.unsafe(text, params as unknown[]);
    const rows = Array.from(result as unknown[]);

    if (rows.length > this.#maxRows) {
      throw new QueryLimitError(this.#maxRows);
    }

    const meta = result as { count?: number; command?: string };
    return {
      rows,
      rowCount: typeof meta.count === "number" ? meta.count : rows.length,
      command: statement.command,
    };
  }

  async close(): Promise<void> {
    await this.#sql.close();
  }
}

function runtimeUrl(adminUrl: string, role: string): string {
  const url = new URL(adminUrl);
  url.username = role;
  // Local development uses trust authentication. `plugin-platform` supplies broker-held
  // credentials for production.
  url.password = "";
  return url.toString();
}

/** Removes a plugin's schema and roles. Used by tests and, later, uninstall. */
export async function dropPlugin(options: {
  readonly adminUrl: string;
  readonly pluginId: string;
}): Promise<void> {
  const identifiers = pluginIdentifiers(options.pluginId);
  const sql = new SQL(options.adminUrl, { max: 1, connectionTimeout: 5 });

  try {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${quote(identifiers.schema)} CASCADE`);
    await sql.unsafe(
      `DROP OWNED BY ${quote(identifiers.runtimeRole)}, ${quote(identifiers.ownerRole)}`,
    );
    await sql.unsafe(`DROP ROLE IF EXISTS ${quote(identifiers.runtimeRole)}`);
    await sql.unsafe(`DROP ROLE IF EXISTS ${quote(identifiers.ownerRole)}`);
  } finally {
    await sql.close();
  }
}
