import {
  type AuthNodeEnv,
  loadSession,
  parseCookieHeader,
  type SessionRecord,
  sessionCookieName,
} from "@bulletin/domain/auth";
import { resolveMemberLocale } from "@bulletin/domain/member";
import type { Locale } from "@bulletin/i18n";
import type { SQL } from "bun";

const nodeEnv: AuthNodeEnv = process.env.NODE_ENV === "production" ? "production" : "development";

let pool: SQL | undefined;

function sessionSql(): SQL {
  pool ??= new Bun.SQL(process.env.DATABASE_URL ?? "postgres://user_app@localhost:5432/bulletin", {
    max: 1,
    connectionTimeout: 5,
  });
  return pool;
}

async function readSession(
  sql: SQL,
  cookieHeader: string | null,
  env: AuthNodeEnv,
): Promise<SessionRecord | null> {
  const token = parseCookieHeader(cookieHeader)[sessionCookieName("user", env)];

  if (token === undefined || token === "") {
    return null;
  }

  return loadSession(sql, "user", token, new Date());
}

/** Read-only session lookup for user-app middleware; never touches activity. */
export async function readSessionReauthAt(
  sql: SQL,
  cookieHeader: string | null,
  env: AuthNodeEnv = nodeEnv,
): Promise<string | null> {
  const session = await readSession(sql, cookieHeader, env);
  return session === null ? null : session.reauthAt.toISOString();
}

export interface UserAppSessionContext {
  readonly memberId: string;
  readonly reauthAt: string;
  readonly locale: Locale;
}

/** The session's re-auth point and its DB-backed request locale, resolved read-only. */
export async function readSessionContext(
  sql: SQL,
  cookieHeader: string | null,
  env: AuthNodeEnv = nodeEnv,
): Promise<UserAppSessionContext | null> {
  const session = await readSession(sql, cookieHeader, env);

  if (session === null) {
    return null;
  }

  return {
    memberId: session.memberId,
    reauthAt: session.reauthAt.toISOString(),
    locale: await resolveMemberLocale(sql, session.memberId),
  };
}

export async function currentSessionReauthAt(cookieHeader: string | null): Promise<string | null> {
  return readSessionReauthAt(sessionSql(), cookieHeader);
}

export async function currentSessionContext(
  cookieHeader: string | null,
): Promise<UserAppSessionContext | null> {
  return readSessionContext(sessionSql(), cookieHeader);
}

export async function closeSessionReadPool(): Promise<void> {
  if (pool !== undefined) {
    await pool.close();
    pool = undefined;
  }
}
