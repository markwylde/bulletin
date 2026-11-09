import type { SQL } from "bun";
import { createToken, hashToken, SESSION_LIFETIMES, type SessionKind } from "./tokens.ts";

export interface SessionRecord {
  readonly id: string;
  readonly memberId: string;
  readonly kind: SessionKind;
  readonly displayName: string | null;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly reauthAt: Date;
  readonly lastAuthAt: Date;
  readonly revokedAt: Date | null;
  readonly rotatePending: boolean;
  readonly viaPreviousToken: boolean;
  readonly previousTokenExpiresAt: Date | null;
}

export interface SessionLookup {
  find(kind: SessionKind, token: string): Promise<SessionRecord | null>;
  touch?(session: SessionRecord): Promise<void>;
  revoke?(sessionId: string): Promise<void>;
  invalidate?(): void;
}

export interface SessionStore extends SessionLookup {
  /** Records the request's activity on the session and member. */
  touch(session: SessionRecord): Promise<void>;
  /** Issues a new token for a session marked for rotation, with a 60 s overlap. */
  rotate(session: SessionRecord): Promise<{ readonly token: string } | null>;
  /** Revokes one session and wakes every process's session cache. */
  revoke(sessionId: string): Promise<void>;
  /** Revokes every session of a member; returns how many were active. */
  revokeMemberSessions(memberId: string): Promise<number>;
  /** Marks a member's sessions for rotation on their next response. */
  markMemberSessionsForRotation(memberId: string): Promise<void>;
  invalidate(): void;
  close(): Promise<void>;
}

interface SessionRow {
  id: string;
  member_id: string;
  kind: SessionKind;
  token_hash: string;
  previous_token_hash: string | null;
  previous_token_expires_at: Date | string | null;
  rotate_pending: boolean;
  created_at: Date | string;
  last_seen_at: Date | string;
  reauth_at: Date | string;
  last_auth_at: Date | string;
  revoked_at: Date | string | null;
  display_name: string | null;
}

const CACHE_TTL_MS = 5_000;
const ROTATION_OVERLAP_MS = 60_000;

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function ageMs(now: Date, value: Date): number {
  return now.getTime() - value.getTime();
}

export function isSessionLive(session: SessionRecord, kind: SessionKind, now: Date): boolean {
  if (session.revokedAt !== null || session.kind !== kind) {
    return false;
  }

  if (
    session.viaPreviousToken &&
    (session.previousTokenExpiresAt === null || session.previousTokenExpiresAt <= now)
  ) {
    return false;
  }

  const lifetime = SESSION_LIFETIMES[kind];

  return (
    ageMs(now, session.createdAt) <= lifetime.absoluteMs &&
    ageMs(now, session.lastSeenAt) <= lifetime.idleMs
  );
}

/** Loads a session by raw token, also honouring the 60 s rotation overlap. */
export async function loadSession(
  sql: SQL,
  kind: SessionKind,
  token: string,
  now: Date = new Date(),
): Promise<SessionRecord | null> {
  const hash = hashToken(token);
  const hashHex = Buffer.from(hash).toString("hex");
  const [row] = (await sql`
    SELECT s.id, s.member_id, s.kind,
           encode(s.token_hash, 'hex') AS token_hash,
           encode(s.previous_token_hash, 'hex') AS previous_token_hash,
           s.previous_token_expires_at, s.rotate_pending,
           s.created_at, s.last_seen_at, s.reauth_at, s.last_auth_at, s.revoked_at,
           m.display_name
    FROM core.sessions s
    JOIN core.members m ON m.id = s.member_id
    WHERE s.token_hash = ${hash} OR s.previous_token_hash = ${hash}
  `) as SessionRow[];

  if (row === undefined) {
    return null;
  }

  const session: SessionRecord = {
    id: row.id,
    memberId: row.member_id,
    kind: row.kind,
    displayName: row.display_name,
    createdAt: toDate(row.created_at),
    lastSeenAt: toDate(row.last_seen_at),
    reauthAt: toDate(row.reauth_at),
    lastAuthAt: toDate(row.last_auth_at),
    revokedAt: row.revoked_at === null ? null : toDate(row.revoked_at),
    rotatePending: row.rotate_pending,
    viaPreviousToken: row.token_hash !== hashHex,
    previousTokenExpiresAt:
      row.previous_token_expires_at === null ? null : toDate(row.previous_token_expires_at),
  };

  return isSessionLive(session, kind, now) ? session : null;
}

export function directSessionLookup(sql: SQL, now: () => Date = () => new Date()): SessionLookup {
  return {
    find: (kind, token) => loadSession(sql, kind, token, now()),
  };
}

export interface CreateSessionStoreOptions {
  readonly sql: SQL;
  readonly now?: () => Date;
  /** Tests use 0 to bypass the cache; production keeps the 5 s fail-closed window. */
  readonly cacheTtlMs?: number;
}

/**
 * A 5 s in-process cache, cleared by the `session_revoked` NOTIFY. A missed notification
 * is still fail-closed within 5 s (ADR 0006 listener health).
 */
export async function createSessionStore(
  options: CreateSessionStoreOptions,
): Promise<SessionStore> {
  const now = options.now ?? (() => new Date());
  const ttlMs = options.cacheTtlMs ?? CACHE_TTL_MS;
  const cache = new Map<string, { readonly record: SessionRecord; readonly expiresAt: number }>();
  const subscription = await options.sql.listen("session_revoked", () => {
    cache.clear();
  });

  function keyFor(kind: SessionKind, token: string): string {
    return `${kind}:${Buffer.from(hashToken(token)).toString("hex")}`;
  }

  async function find(kind: SessionKind, token: string): Promise<SessionRecord | null> {
    const key = keyFor(kind, token);
    const cached = cache.get(key);

    if (cached !== undefined) {
      if (cached.expiresAt > Date.now() && isSessionLive(cached.record, kind, now())) {
        return cached.record;
      }

      cache.delete(key);
    }

    const record = await loadSession(options.sql, kind, token, now());

    if (record !== null) {
      cache.set(key, { record, expiresAt: Date.now() + ttlMs });
    }

    return record;
  }

  async function touch(session: SessionRecord): Promise<void> {
    await options.sql`UPDATE core.sessions SET last_seen_at = now() WHERE id = ${session.id}`;
    await options.sql`
      UPDATE core.members
         SET previous_visit_at = CASE
               WHEN last_active_at IS NOT NULL
                AND last_active_at < now() - interval '30 minutes'
               THEN last_active_at
               ELSE previous_visit_at
             END,
             last_active_at = now()
       WHERE id = ${session.memberId}
    `;
  }

  async function rotate(session: SessionRecord): Promise<{ readonly token: string } | null> {
    const token = createToken();
    const rows = (await options.sql`
      UPDATE core.sessions
         SET token_hash = ${hashToken(token)},
             previous_token_hash = token_hash,
             previous_token_expires_at = now() + interval '60 seconds',
             rotate_pending = false
       WHERE id = ${session.id}
         AND rotate_pending = true
         AND revoked_at IS NULL
      RETURNING id
    `) as Array<{ id: string }>;

    if (rows.length === 0) {
      return null;
    }

    cache.clear();
    return { token };
  }

  async function revoke(sessionId: string): Promise<void> {
    const rows = (await options.sql`
      UPDATE core.sessions SET revoked_at = now()
      WHERE id = ${sessionId} AND revoked_at IS NULL
      RETURNING id
    `) as Array<{ id: string }>;

    if (rows.length > 0) {
      await options.sql`SELECT pg_notify('session_revoked', ${sessionId})`;
      cache.clear();
    }
  }

  async function revokeMemberSessions(memberId: string): Promise<number> {
    const rows = (await options.sql`
      UPDATE core.sessions SET revoked_at = now()
      WHERE member_id = ${memberId} AND revoked_at IS NULL
      RETURNING id
    `) as Array<{ id: string }>;

    if (rows.length > 0) {
      await options.sql`SELECT pg_notify('session_revoked', ${memberId})`;
      cache.clear();
    }

    return rows.length;
  }

  async function markMemberSessionsForRotation(memberId: string): Promise<void> {
    await options.sql`
      UPDATE core.sessions SET rotate_pending = true
      WHERE member_id = ${memberId} AND revoked_at IS NULL
    `;
    // The cache carries `rotate_pending`; wake it so the next response rotates promptly.
    await options.sql`SELECT pg_notify('session_revoked', ${memberId})`;
    cache.clear();
  }

  return {
    find,
    touch,
    rotate,
    revoke,
    revokeMemberSessions,
    markMemberSessionsForRotation,
    invalidate: () => cache.clear(),
    async close() {
      cache.clear();
      await subscription.unlisten();
    },
  };
}

export const SESSION_ROTATION_OVERLAP_MS = ROTATION_OVERLAP_MS;
