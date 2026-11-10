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
import { closeReadSql, readSql } from "./db.ts";

const nodeEnv: AuthNodeEnv = process.env.NODE_ENV === "production" ? "production" : "development";

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
  readonly sessionId: string;
  readonly reauthAt: string;
  readonly locale: Locale;
  /** Null until the member chooses one; middleware redirects them to the step page. */
  readonly displayName: string | null;
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
    sessionId: session.id,
    reauthAt: session.reauthAt.toISOString(),
    locale: await resolveMemberLocale(sql, session.memberId),
    displayName: session.displayName,
  };
}

export async function currentSessionReauthAt(cookieHeader: string | null): Promise<string | null> {
  return readSessionReauthAt(readSql(), cookieHeader);
}

export async function currentSessionContext(
  cookieHeader: string | null,
): Promise<UserAppSessionContext | null> {
  return readSessionContext(readSql(), cookieHeader);
}

export async function closeSessionReadPool(): Promise<void> {
  await closeReadSql();
}
