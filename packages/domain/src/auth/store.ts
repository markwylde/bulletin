import type { SQL } from "bun";
import type { IdTokenClaims } from "./jwt.ts";
import { createToken, hashToken, SESSION_LIFETIMES, type SessionKind } from "./tokens.ts";

export interface CreatedChallenge {
  readonly id: string;
  readonly state: string;
  readonly nonce: string;
}

export interface StoredChallenge {
  readonly id: string;
  readonly nonce: string;
  readonly expired: boolean;
  readonly used: boolean;
}

export interface ResolvedMember {
  readonly id: string;
  readonly displayName: string | null;
}

export interface IssuedSession {
  readonly id: string;
  readonly token: string;
}

export interface ActiveSession {
  readonly id: string;
  readonly memberId: string;
  readonly displayName: string | null;
}

const CHALLENGE_TTL_MS = 10 * 60 * 1_000;

function newChallengeSecret(): string {
  return createToken();
}

export async function createChallenge(
  sql: SQL,
  kind: SessionKind,
  returnTo: string | null,
): Promise<CreatedChallenge> {
  const state = newChallengeSecret();
  const nonce = newChallengeSecret();
  const [row] = (await sql`
    INSERT INTO core.login_challenges (kind, state, nonce, return_to)
    VALUES (${kind}, ${state}, ${nonce}, ${returnTo})
    RETURNING id
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error("Could not create a login challenge");
  }

  return { id: row.id, state, nonce };
}

export function isChallengeId(value: string): boolean {
  return /^\d+$/.test(value);
}

export async function findChallenge(
  sql: SQL,
  kind: SessionKind,
  id: string,
): Promise<StoredChallenge | null> {
  if (!isChallengeId(id)) {
    return null;
  }

  const [row] = (await sql`
    SELECT id, nonce, expires_at <= now() AS expired, used_at IS NOT NULL AS used
    FROM core.login_challenges
    WHERE id = ${id} AND kind = ${kind}
  `) as Array<{ id: string; nonce: string; expired: boolean; used: boolean }>;

  return row ?? null;
}

/** Marks the challenge used. Zero rows means it was consumed, expired or missing. */
export async function consumeChallenge(tx: SQL, kind: SessionKind, id: string): Promise<boolean> {
  if (!isChallengeId(id)) {
    return false;
  }

  const rows = (await tx`
    UPDATE core.login_challenges
       SET used_at = now()
     WHERE id = ${id}
       AND kind = ${kind}
       AND used_at IS NULL
       AND expires_at > now()
    RETURNING id
  `) as Array<{ id: string }>;

  return rows.length === 1;
}

/**
 * Maps `(issuer, sub)` to a member through the audited definer function (ADR 0012).
 * A first login creates the member with no display name yet.
 */
export async function resolveMember(tx: SQL, identity: IdTokenClaims): Promise<ResolvedMember> {
  const [mapped] = (await tx`
    SELECT pii.resolve_identity(
      ${identity.issuer}, ${identity.sub}, ${identity.email}, ${identity.name}
    ) AS member_id
  `) as Array<{ member_id: string }>;

  if (mapped === undefined) {
    throw new Error("Could not map the external identity");
  }

  const [member] = (await tx`
    SELECT display_name FROM core.members WHERE id = ${mapped.member_id}
  `) as Array<{ display_name: string | null }>;

  return {
    id: mapped.member_id,
    displayName: member?.display_name ?? null,
  };
}

export async function issueSession(
  tx: SQL,
  options: {
    readonly kind: SessionKind;
    readonly memberId: string;
    readonly ip: string | null;
    readonly userAgent: string | null;
  },
): Promise<IssuedSession> {
  const token = createToken();
  const tokenHash = hashToken(token);
  const reauthHours = SESSION_LIFETIMES[options.kind].reauthHours;
  const [row] = (await tx`
    INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
    VALUES (
      ${options.memberId}, ${options.kind}, ${tokenHash},
      now() + make_interval(hours => ${reauthHours})
    )
    RETURNING id
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error("Could not create a session");
  }

  if (options.ip !== null) {
    await tx`
      SELECT pii.record_session_meta(${row.id}, ${options.ip}, ${options.userAgent})
    `;
    await tx`SELECT pii.record_login_ip(${options.memberId}, ${options.ip})`;
  }

  return { id: row.id, token };
}

function ageMs(value: Date | string): number {
  return Date.now() - new Date(value).getTime();
}

/** Looks up a live session by its raw cookie token; the kind is part of the boundary. */
export async function findSession(
  sql: SQL,
  kind: SessionKind,
  token: string,
): Promise<ActiveSession | null> {
  const [row] = (await sql`
    SELECT s.id, s.member_id, s.kind, s.created_at, s.last_seen_at, s.revoked_at,
           m.display_name
    FROM core.sessions s
    JOIN core.members m ON m.id = s.member_id
    WHERE s.token_hash = ${hashToken(token)}
  `) as Array<{
    id: string;
    member_id: string;
    kind: SessionKind;
    created_at: Date | string;
    last_seen_at: Date | string;
    revoked_at: Date | string | null;
    display_name: string | null;
  }>;

  if (row === undefined || row.kind !== kind || row.revoked_at !== null) {
    return null;
  }

  const lifetime = SESSION_LIFETIMES[kind];

  if (ageMs(row.created_at) > lifetime.absoluteMs || ageMs(row.last_seen_at) > lifetime.idleMs) {
    return null;
  }

  return {
    id: row.id,
    memberId: row.member_id,
    displayName: row.display_name,
  };
}

export const CHALLENGE_COOKIE_MAX_AGE = Math.trunc(CHALLENGE_TTL_MS / 1_000);
