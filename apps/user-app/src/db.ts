import type { SQL } from "bun";

let pool: SQL | undefined;

/** The user-app read pool (ADR 0001); it never writes content. */
export function readSql(): SQL {
  pool ??= new Bun.SQL(process.env.DATABASE_URL ?? "postgres://user_app@localhost:5432/bulletin", {
    max: 1,
    connectionTimeout: 5,
  });
  return pool;
}

export async function closeReadSql(): Promise<void> {
  if (pool !== undefined) {
    await pool.close();
    pool = undefined;
  }
}
