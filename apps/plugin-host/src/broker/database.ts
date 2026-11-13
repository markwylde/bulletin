import { randomBytes } from "node:crypto";
import type { Logger } from "@bulletin/config";
import { SQL } from "bun";
import type { PluginConnectionManager } from "./connections.ts";
import type { PluginMigration } from "./manifest.ts";
import { assertAllowedMigration } from "./migration.ts";
import { type AllowedStatement, buildBoundedQuery } from "./sql.ts";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,48}$/;
const DEFAULT_MAX_ROWS = 1_000;
/** Binary row-size budget enforced by Postgres before rows reach plugin-host. */
const DEFAULT_MAX_RESULT_BYTES = 256 * 1024;

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
  /** Login URL for `plugin_migrator`; defaults to the admin URL with that role. */
  readonly migratorUrl?: string;
  /** Statement deadline enforced by cancelling from the broker's control connection. */
  readonly statementTimeoutMs?: number;
  /** Broker-held runtime password; generated per open when omitted (production credentials). */
  readonly runtimePassword?: string;
  readonly migratorPassword?: string;
  /** Shared lazy connection budget; when set, no per-plugin pool is opened at provision time. */
  readonly connections?: PluginConnectionManager;
}

export interface QueryResult {
  readonly rows: unknown[];
  readonly rowCount: number;
  readonly command: string;
}

export class QueryLimitError extends Error {
  constructor() {
    super("Query result is too large");
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
 * owner, then opens the DML-only runtime pool. Until the installer lands (task 2.5) this
 * runs from the local Postgres administrator; production uses `plugin_migrator`.
 */
export class PluginDatabase {
  readonly identifiers: PluginIdentifiers;
  readonly #sql: SQL | undefined;
  readonly #control: SQL;
  readonly #connections: PluginConnectionManager | undefined;
  readonly #maxRows: number;
  readonly #maxBytes: number;
  readonly #functions: ReadonlySet<string>;
  readonly #statementTimeoutMs: number;
  readonly #logger: Logger;

  private constructor(
    identifiers: PluginIdentifiers,
    sql: SQL | undefined,
    control: SQL,
    connections: PluginConnectionManager | undefined,
    functions: ReadonlySet<string>,
    maxRows: number,
    maxBytes: number,
    statementTimeoutMs: number,
    logger: Logger,
  ) {
    this.identifiers = identifiers;
    this.#sql = sql;
    this.#control = control;
    this.#connections = connections;
    this.#functions = functions;
    this.#maxRows = maxRows;
    this.#maxBytes = maxBytes;
    this.#statementTimeoutMs = statementTimeoutMs;
    this.#logger = logger;
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

    // Validate every migration before touching the cluster; a rejected migration changes
    // nothing (not even an empty schema).
    for (const migration of options.migrations) {
      await assertAllowedMigration(migration.sql, {
        schema: identifiers.schema,
        pluginFunctions: new Set<string>(),
        runtimeRole: identifiers.runtimeRole,
        ownerRole: identifiers.ownerRole,
      });
    }

    const runtimePassword = options.runtimePassword ?? randomBytes(24).toString("base64url");
    const migratorPassword = options.migratorPassword ?? randomBytes(24).toString("base64url");
    const admin = new SQL(options.adminUrl, { max: 1, connectionTimeout: 5 });
    let runtime: SQL | undefined;
    let control: SQL | undefined;
    let migrator: SQL | undefined;

    try {
      await ensureRole(admin, identifiers.ownerRole, false);
      await ensureRole(admin, identifiers.runtimeRole, true);
      await ensureRole(admin, "plugin_migrator", true);

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
        ALTER ROLE ${quote("plugin_migrator")}
          LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT
          PASSWORD '${migratorPassword}';
        ALTER ROLE ${quote(identifiers.runtimeRole)}
          PASSWORD '${runtimePassword}';
      `);

      await admin.unsafe(`
        CREATE SCHEMA IF NOT EXISTS ${quote(identifiers.schema)}
          AUTHORIZATION ${quote(identifiers.ownerRole)};
        ALTER SCHEMA ${quote(identifiers.schema)}
          OWNER TO ${quote(identifiers.ownerRole)};
        REVOKE ALL ON SCHEMA ${quote(identifiers.schema)} FROM PUBLIC;
        GRANT USAGE ON SCHEMA ${quote(identifiers.schema)} TO ${quote(identifiers.runtimeRole)};
      `);

      // Migrations run as plugin_migrator (NOINHERIT, member of this plugin's owner only),
      // never from the admin or owner session, so a migration cannot `RESET ROLE` upward.
      await admin.unsafe(`GRANT ${quote(identifiers.ownerRole)} TO ${quote("plugin_migrator")}`);

      if (options.migrations.length > 0) {
        migrator = new SQL(
          pluginRoleUrl(
            options.migratorUrl ?? options.adminUrl,
            "plugin_migrator",
            migratorPassword,
          ),
          { max: 1, connectionTimeout: 5 },
        );
        await migrator.begin(async (transaction) => {
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
      `);

      // Revoke PUBLIC's default reachability from the plugin role. On a fresh volume the
      // core/pii schemas may not exist yet (the API services migrate them), so only touch
      // schemas that are present. The plugin role has no grants on them either way.
      for (const schema of ["core", "pii", "public"] as const) {
        const exists = (await admin`
          SELECT 1 FROM pg_namespace WHERE nspname = ${schema}
        `) as unknown[];

        if (exists.length > 0) {
          await admin.unsafe(
            `REVOKE ALL ON SCHEMA ${quote(schema)} FROM ${quote(identifiers.runtimeRole)}`,
          );
        }
      }

      const functionRows = (await admin`
        SELECT p.proname AS name
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = ${identifiers.schema}
      `) as Array<{ name: string }>;
      const functions = new Set(functionRows.map((row) => row.name));

      if (options.connections === undefined) {
        runtime = new SQL(
          pluginRoleUrl(options.adminUrl, identifiers.runtimeRole, runtimePassword),
          {
            max: 2,
            connectionTimeout: 5,
          },
        );
        await runtime`SELECT 1`;
      }

      control = new SQL(options.adminUrl, { max: 1, connectionTimeout: 5, idleTimeout: 0 });

      options.logger.info("plugin.database_ready", {
        schema: identifiers.schema,
        functions: functions.size,
      });

      return new PluginDatabase(
        identifiers,
        runtime,
        control,
        options.connections,
        functions,
        options.maxRows ?? DEFAULT_MAX_ROWS,
        DEFAULT_MAX_RESULT_BYTES,
        options.statementTimeoutMs ?? 2_000,
        options.logger,
      );
    } catch (error) {
      await runtime?.close().catch(() => undefined);
      await control?.close().catch(() => undefined);
      throw error;
    } finally {
      await migrator?.close().catch(() => undefined);
      await admin.close().catch(() => undefined);
    }
  }

  /** Runs a validated statement with a Postgres-enforced result budget. */
  async query(
    sql: string,
    params: readonly unknown[],
    statement: AllowedStatement,
  ): Promise<QueryResult> {
    if (this.#connections !== undefined) {
      return this.#connections.withConnection(this.identifiers.pluginId, (pool) =>
        this.#execute(pool, sql, params, statement),
      );
    }

    if (this.#sql === undefined) {
      throw new Error("Plugin database has no connection pool");
    }

    return this.#execute(this.#sql, sql, params, statement);
  }

  async #execute(
    pool: SQL,
    sql: string,
    params: readonly unknown[],
    statement: AllowedStatement,
  ): Promise<QueryResult> {
    const trimmed = sql.trim().replace(/;\s*$/, "");
    const reserved = await pool.reserve();
    let deadline: ReturnType<typeof setTimeout> | undefined;

    try {
      const pidRows = (await reserved`SELECT pg_backend_pid() AS pid`) as Array<{ pid: number }>;
      const pid = pidRows[0]?.pid;

      if (pid !== undefined) {
        // The role's statement_timeout is the first line; this cancels from a separate
        // connection so SET LOCAL inside the plugin session cannot extend the deadline.
        deadline = setTimeout(() => {
          this.#logger.warn("plugin.statement_deadline", {
            schema: this.schema,
            timeoutMs: this.#statementTimeoutMs,
          });
          void this.#control
            .unsafe(`SELECT pg_cancel_backend(${String(pid)})`)
            .catch((error: unknown) => {
              this.#logger.error("plugin.statement_cancel_failed", { error });
            });
        }, this.#statementTimeoutMs);
        deadline.unref?.();
      }

      if (statement.command !== "select" && !statement.hasReturning) {
        const result = await reserved.unsafe(trimmed, params as unknown[]);
        const meta = result as { count?: number };
        return {
          rows: [],
          rowCount: typeof meta.count === "number" ? meta.count : 0,
          command: statement.command,
        };
      }

      const text = buildBoundedQuery(trimmed, statement, this.#maxRows, this.#maxBytes);
      const result = (await reserved.unsafe(text, params as unknown[])) as Array<{
        broker_too_large?: boolean;
        broker_rows?: unknown;
      }>;
      const row = result[0];

      if (row?.broker_too_large === true) {
        throw new QueryLimitError();
      }

      const rows = Array.isArray(row?.broker_rows) ? row.broker_rows : [];
      return { rows, rowCount: rows.length, command: statement.command };
    } finally {
      if (deadline !== undefined) {
        clearTimeout(deadline);
      }

      reserved.release();
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.#sql?.close(), this.#control.close()]);
  }
}

export function pluginRoleUrl(adminUrl: string, role: string, password?: string): string {
  const url = new URL(adminUrl);
  url.username = role;
  url.password = password ?? "";
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
