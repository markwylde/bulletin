import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SQL } from "bun";

const MIGRATION_NAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));
const ADVISORY_LOCK = "bulletin.migrate";

export interface Migration {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export type MigrationErrorCode =
  | "invalid_name"
  | "duplicate_name"
  | "missing_file"
  | "checksum_mismatch";

export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  readonly migration: string;

  constructor(
    code: MigrationErrorCode,
    migration: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MigrationError";
    this.code = code;
    this.migration = migration;
  }
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

export interface RunMigrationsOptions {
  readonly sql?: SQL;
  readonly databaseUrl?: string;
  readonly migrationsDir?: string;
  readonly logger?: (line: string) => void;
}

interface AppliedRow {
  readonly name: string;
  readonly sha256: string;
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

/** Loads, names and checksums migrations in filename order. */
export async function loadMigrations(
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
): Promise<readonly Migration[]> {
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  const seen = new Set<string>();
  const migrations: Migration[] = [];

  for (const file of files) {
    const match = MIGRATION_NAME.exec(file);

    if (match === null) {
      throw new MigrationError("invalid_name", file, `Migration ${file} must match NNNN_name.sql`);
    }

    const name = match[0];

    if (seen.has(name)) {
      throw new MigrationError("duplicate_name", name, `Duplicate migration ${name}`);
    }

    seen.add(name);
    const sql = await readFile(`${migrationsDir}/${file}`, "utf8");
    migrations.push({ name, sql, checksum: checksum(sql) });
  }

  return migrations;
}

async function appliedMigrations(reserved: SQL): Promise<readonly AppliedRow[]> {
  const [table] = (await reserved`
    SELECT to_regclass('core.schema_migrations') AS name
  `) as Array<{ name: string | null }>;

  if (table?.name === null || table === undefined) {
    return [];
  }

  return (await reserved`
    SELECT name, sha256
    FROM core.schema_migrations
    ORDER BY name
  `) as AppliedRow[];
}

/**
 * Applies pending migrations under a session advisory lock. Every file runs in its own
 * transaction; an edited applied file aborts before anything is applied.
 */
export async function runMigrations(options: RunMigrationsOptions = {}): Promise<MigrationResult> {
  const migrations = await loadMigrations(options.migrationsDir);
  const ownsSql = options.sql === undefined;
  const sql =
    options.sql ??
    new SQL(
      options.databaseUrl ??
        Bun.env.MIGRATION_DATABASE_URL ??
        Bun.env.DATABASE_URL ??
        "postgres://bulletin:bulletin@localhost:5432/bulletin",
    );

  const reserved = await sql.reserve();

  try {
    await reserved`SELECT pg_advisory_lock(hashtext(${ADVISORY_LOCK}))`;

    const existing = await appliedMigrations(reserved);
    const byName = new Map(migrations.map((migration) => [migration.name, migration]));

    for (const row of existing) {
      if (!byName.has(row.name)) {
        throw new MigrationError(
          "missing_file",
          row.name,
          `Applied migration ${row.name} is missing from disk`,
        );
      }
    }

    for (const row of existing) {
      const migration = byName.get(row.name);

      if (migration !== undefined && migration.checksum !== row.sha256) {
        throw new MigrationError(
          "checksum_mismatch",
          row.name,
          `Checksum mismatch for applied migration ${row.name}: expected ${row.sha256}, found ${migration.checksum}`,
        );
      }
    }

    const appliedNames = new Set(existing.map((row) => row.name));
    const applied: string[] = [];
    const skipped: string[] = [];

    for (const migration of migrations) {
      if (appliedNames.has(migration.name)) {
        skipped.push(migration.name);
        continue;
      }

      await reserved.begin(async (tx) => {
        await tx.unsafe(migration.sql);
        await tx`
          INSERT INTO core.schema_migrations (name, sha256)
          VALUES (${migration.name}, ${migration.checksum})
        `;
      });

      applied.push(migration.name);
      options.logger?.(`applied migration ${migration.name}`);
    }

    return { applied, skipped };
  } finally {
    try {
      await reserved`SELECT pg_advisory_unlock(hashtext(${ADVISORY_LOCK}))`;
    } finally {
      await reserved.release();
      if (ownsSql) {
        await sql.close();
      }
    }
  }
}

export { DEFAULT_MIGRATIONS_DIR };
