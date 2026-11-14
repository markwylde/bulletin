import { poolApplicationName } from "@bulletin/config/server";
import type { SQL } from "bun";

let pool: SQL | undefined;

/** The read pool's size; pool saturation is reported against it. */
export const READ_POOL_MAX = 1;

/** The user-app read pool (ADR 0001); it never writes content. */
export function readSql(): SQL {
  pool ??= new Bun.SQL(process.env.DATABASE_URL ?? "postgres://user_app@localhost:5432/bulletin", {
    max: READ_POOL_MAX,
    connectionTimeout: 5,
    // Saturation counts this process's pool by name, not every replica of the role.
    connection: { application_name: poolApplicationName("user-app") },
  });
  return pool;
}

export async function closeReadSql(): Promise<void> {
  if (pool !== undefined) {
    await pool.close();
    pool = undefined;
  }
}
