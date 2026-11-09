import {
  type AuthNodeEnv,
  loadSession,
  parseCookieHeader,
  sessionCookieName,
} from "@bulletin/domain/auth";
import { SQL } from "bun";

const nodeEnv: AuthNodeEnv = process.env.NODE_ENV === "production" ? "production" : "development";

let pool: SQL | undefined;

function sessionSql(): SQL {
  pool ??= new SQL(process.env.DATABASE_URL ?? "postgres://user_app@localhost:5432/bulletin", {
    max: 1,
    connectionTimeout: 5,
  });
  return pool;
}

/** Read-only session lookup for user-app middleware; never touches activity. */
export async function readSessionReauthAt(
  sql: SQL,
  cookieHeader: string | null,
  env: AuthNodeEnv = nodeEnv,
): Promise<string | null> {
  const token = parseCookieHeader(cookieHeader)[sessionCookieName("user", env)];

  if (token === undefined || token === "") {
    return null;
  }

  const session = await loadSession(sql, "user", token, new Date());
  return session === null ? null : session.reauthAt.toISOString();
}

export async function currentSessionReauthAt(cookieHeader: string | null): Promise<string | null> {
  return readSessionReauthAt(sessionSql(), cookieHeader);
}

export async function closeSessionReadPool(): Promise<void> {
  if (pool !== undefined) {
    await pool.close();
    pool = undefined;
  }
}
