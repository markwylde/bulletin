import { randomUUID } from "node:crypto";
import { runMigrations } from "@bulletin/db/migrate";
import { SQL } from "bun";

const TEMPLATE_NAME = "bulletin_template";

function databaseUrl(adminUrl: string, name: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function safePrefix(prefix: string): string {
  const cleaned = prefix.toLowerCase().replace(/[^a-z0-9_]+/g, "_");

  if (cleaned === "") {
    throw new Error("Test database prefix must contain letters or digits");
  }

  return cleaned.slice(0, 24);
}

async function databaseExists(admin: SQL, name: string): Promise<boolean> {
  const rows = (await admin`
    SELECT 1 FROM pg_database WHERE datname = ${name}
  `) as unknown[];
  return rows.length > 0;
}

async function createDatabase(admin: SQL, name: string, template?: string): Promise<void> {
  const clause = template === undefined ? "" : ` TEMPLATE "${template}"`;

  try {
    await admin.unsafe(`CREATE DATABASE "${name}"${clause}`);
  } catch (error) {
    // Parallel Bun workers may race while creating the template; if it now exists, that is fine.
    if (!(await databaseExists(admin, name))) {
      throw error;
    }
  }
}

/** Creates and migrates `bulletin_template`; safe to run repeatedly. */
export async function ensureTemplateDatabase(options: {
  readonly adminUrl: string;
  readonly migrationsDir?: string;
}): Promise<string> {
  const admin = new SQL(options.adminUrl);
  const templateUrl = databaseUrl(options.adminUrl, TEMPLATE_NAME);

  try {
    if (!(await databaseExists(admin, TEMPLATE_NAME))) {
      await createDatabase(admin, TEMPLATE_NAME);
    }
  } finally {
    await admin.close();
  }

  await runMigrations({
    databaseUrl: templateUrl,
    ...(options.migrationsDir === undefined ? {} : { migrationsDir: options.migrationsDir }),
  });

  return templateUrl;
}

export interface TestDatabase {
  readonly name: string;
  readonly url: string;
  readonly sql: SQL;
  drop(): Promise<void>;
}

export interface CreateTestDatabaseOptions {
  readonly adminUrl: string;
  readonly prefix?: string;
}

/** Clones a fresh database from the migrated template; drop it in a `finally` block. */
export async function createTestDatabase(
  options: CreateTestDatabaseOptions,
): Promise<TestDatabase> {
  const prefix = options.prefix === undefined ? "test" : safePrefix(options.prefix);
  const name = `bulletin_${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const admin = new SQL(options.adminUrl);

  try {
    await createDatabase(admin, name, TEMPLATE_NAME);
  } finally {
    await admin.close();
  }

  const url = databaseUrl(options.adminUrl, name);
  const sql = new SQL(url);
  let dropped = false;

  return {
    name,
    url,
    sql,
    async drop() {
      if (dropped) {
        return;
      }
      dropped = true;
      await sql.close();

      const cleanup = new SQL(options.adminUrl);
      try {
        await cleanup.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await cleanup.close();
      }
    },
  };
}

/** Runs a callback against a fresh per-file database and always drops it. */
export async function withTestDatabase<T>(
  options: CreateTestDatabaseOptions,
  run: (database: TestDatabase) => Promise<T>,
): Promise<T> {
  const database = await createTestDatabase(options);

  try {
    return await run(database);
  } finally {
    await database.drop();
  }
}

export { TEMPLATE_NAME };
