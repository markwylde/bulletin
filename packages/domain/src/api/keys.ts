import type { SQL } from "bun";
import { displayNameSkeleton, validateDisplayName } from "../member/names.ts";
import { type ApiScope, canonicalApiScopes, parseApiScopes } from "./scopes.ts";

/** ADR 0016: `blt_<8-char prefix>_<32 random bytes base64url>`. */
const KEY_PATTERN = /^blt_([a-z0-9]{8})_([A-Za-z0-9_-]{43})$/;
const PREFIX_BYTES = 4;
const SECRET_BYTES = 32;
const LAST_USED_INTERVAL_MS = 60 * 1_000;

export type ApiKeyKind = "personal" | "integration";

/** Metadata that is safe to show after creation; the key itself is never stored or listed. */
export interface ApiKeyMetadata {
  readonly id: string;
  readonly prefix: string;
  readonly label: string;
  readonly kind: ApiKeyKind;
  readonly scopes: readonly ApiScope[];
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly lastUsedAt: Date | null;
}

export interface CreatedApiKey {
  /** The full secret. Callers may show it once and must never persist it. */
  readonly key: string;
  readonly metadata: ApiKeyMetadata;
}

/** What authentication gives a route: the key narrows the member, it never replaces `can()`. */
export interface ApiKeyPrincipal {
  readonly kind: "key";
  readonly keyId: string;
  readonly prefix: string;
  readonly memberId: string;
  readonly keyKind: ApiKeyKind;
  readonly scopes: readonly ApiScope[];
}

interface ApiKeyRow {
  readonly id: string;
  readonly prefix: string;
  readonly label: string;
  readonly kind: string;
  readonly scopes: unknown;
  readonly created_at: Date | string;
  readonly expires_at: Date | string | null;
  readonly revoked_at: Date | string | null;
  readonly last_used_at: Date | string | null;
}

function toDate(value: Date | string | null): Date | null {
  return value === null ? null : new Date(value);
}

function metadataOf(row: ApiKeyRow): ApiKeyMetadata {
  return {
    id: row.id,
    prefix: row.prefix,
    label: row.label,
    kind: row.kind === "integration" ? "integration" : "personal",
    scopes: parseApiScopes(row.scopes),
    createdAt: new Date(row.created_at),
    expiresAt: toDate(row.expires_at),
    revokedAt: toDate(row.revoked_at),
    lastUsedAt: toDate(row.last_used_at),
  };
}

function randomPrefix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(PREFIX_BYTES));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomSecret(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(SECRET_BYTES))).toString("base64url");
}

/** sha256(pepper || key), as required by ADR 0016. */
export function hashApiKey(pepper: string, key: string): Uint8Array {
  return new Bun.CryptoHasher("sha256").update(pepper).update(key).digest();
}

/** Returns the lookup prefix, or null for anything that is not a Bulletin API key. */
export function parseApiKey(value: string): { readonly prefix: string } | null {
  const match = KEY_PATTERN.exec(value.trim());
  return match === null ? null : { prefix: match[1] ?? "" };
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as { readonly code?: string; readonly errno?: string };
  return (
    candidate.code === "23505" ||
    candidate.errno === "23505" ||
    (error instanceof Error && /duplicate key/i.test(error.message))
  );
}

interface InsertApiKeyInput {
  readonly memberId: string;
  readonly kind: ApiKeyKind;
  readonly label: string;
  readonly scopes: readonly ApiScope[];
  readonly expiresAt: Date | null;
  readonly pepper: string;
}

async function insertApiKey(sql: SQL, input: InsertApiKeyInput): Promise<CreatedApiKey> {
  const label = input.label.trim().slice(0, 100);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const prefix = randomPrefix();
    const key = `blt_${prefix}_${randomSecret()}`;
    const hash = hashApiKey(input.pepper, key);

    try {
      const [row] = (await sql`
        INSERT INTO core.api_keys (
          prefix, hash, principal_member_id, kind, label, scopes, expires_at
        )
        VALUES (
          ${prefix}, ${hash}, ${input.memberId}, ${input.kind}, ${label},
          ${`{${input.scopes.join(",")}}`}::text[], ${input.expiresAt}
        )
        RETURNING id::text AS id, prefix, label, kind, scopes, created_at, expires_at,
          revoked_at, last_used_at
      `) as ApiKeyRow[];

      if (row === undefined) {
        throw new Error("Could not create the API key");
      }

      return { key, metadata: metadataOf(row) };
    } catch (error) {
      // A prefix collision is astronomically unlikely, but retrying keeps the unique index as
      // the source of truth instead of a read-then-insert race.
      if (!isUniqueViolation(error) || attempt === 3) {
        throw error;
      }
    }
  }

  throw new Error("Could not create the API key");
}

export interface CreatePersonalApiKeyInput {
  readonly memberId: string;
  readonly label: string;
  readonly scopes: readonly ApiScope[];
  readonly expiresAt?: Date | null;
  readonly pepper: string;
}

/** Creates a key that acts as its creator, exactly like their session would (ADR 0016). */
export async function createPersonalApiKey(
  sql: SQL,
  input: CreatePersonalApiKeyInput,
): Promise<CreatedApiKey> {
  return insertApiKey(sql, {
    memberId: input.memberId,
    kind: "personal",
    label: input.label,
    scopes: canonicalApiScopes(input.scopes),
    expiresAt: input.expiresAt ?? null,
    pepper: input.pepper,
  });
}

export interface CreateIntegrationApiKeyInput {
  readonly label: string;
  readonly groupIds: readonly string[];
  readonly scopes: readonly ApiScope[];
  readonly expiresAt?: Date | null;
  readonly pepper: string;
}

/**
 * Creates a service member (a real member with no login) in the given groups and a key that
 * acts as it. The member rows make the key subject to the normal permission matrix.
 */
export async function createIntegrationApiKey(
  sql: SQL,
  input: CreateIntegrationApiKeyInput,
): Promise<CreatedApiKey> {
  const name = validateDisplayName(input.label);

  if (!name.ok) {
    throw new Error("An integration key needs a display name of 3-32 characters");
  }

  const groupIds = [...new Set(input.groupIds)];

  if (groupIds.some((id) => !/^\d+$/.test(id))) {
    throw new Error("Integration key groups must be numeric ids");
  }

  return sql.begin(async (tx) => {
    const [member] = (await tx`
      INSERT INTO core.members (display_name, name_skeleton, is_service)
      VALUES (${name.name}, ${displayNameSkeleton(name.name)}, true)
      RETURNING id::text AS id
    `) as Array<{ id: string }>;

    if (member === undefined) {
      throw new Error("Could not create the service member");
    }

    for (const [index, groupId] of groupIds.entries()) {
      const [group] = (await tx`
        INSERT INTO core.member_groups (member_id, group_id, is_primary)
        SELECT ${member.id}, g.id, ${index === 0}
        FROM core.groups g
        WHERE g.id = ${groupId}
        RETURNING group_id::text AS group_id
      `) as Array<{ group_id: string }>;

      if (group === undefined) {
        throw new Error(`Unknown group ${groupId}`);
      }
    }

    return insertApiKey(tx, {
      memberId: member.id,
      kind: "integration",
      label: name.name,
      scopes: canonicalApiScopes(input.scopes),
      expiresAt: input.expiresAt ?? null,
      pepper: input.pepper,
    });
  });
}

export async function listApiKeys(sql: SQL, memberId: string): Promise<readonly ApiKeyMetadata[]> {
  const rows = (await sql`
    SELECT id::text AS id, prefix, label, kind, scopes, created_at, expires_at, revoked_at,
      last_used_at
    FROM core.api_keys
    WHERE principal_member_id = ${memberId}
    ORDER BY created_at DESC, id DESC
  `) as ApiKeyRow[];

  return rows.map(metadataOf);
}

export interface RevokeApiKeyInput {
  readonly keyId: string;
  /** Restrict revocation to a member's own keys; omit for staff/administrative revocation. */
  readonly principalMemberId?: string;
}

/** Revokes a key immediately; an already-revoked key stays revoked. */
export async function revokeApiKey(sql: SQL, input: RevokeApiKeyInput): Promise<boolean> {
  const rows = (await sql`
    UPDATE core.api_keys
    SET revoked_at = coalesce(revoked_at, now())
    WHERE id = ${input.keyId}
      AND (${input.principalMemberId ?? null}::bigint IS NULL
        OR principal_member_id = ${input.principalMemberId ?? null}::bigint)
    RETURNING 1
  `) as unknown[];

  return rows.length > 0;
}

/**
 * Authenticates a bearer key. Revoked, expired and keys whose principal is not active fail
 * closed; the caller responds 401 without revealing which condition matched.
 */
export async function authenticateApiKey(
  sql: SQL,
  input: {
    readonly key: string;
    readonly pepper: string;
    readonly now?: Date;
  },
): Promise<ApiKeyPrincipal | null> {
  const parsed = parseApiKey(input.key);

  if (parsed === null) {
    return null;
  }

  const now = input.now ?? new Date();
  const [row] = (await sql`
    SELECT
      k.id::text AS id,
      k.prefix,
      k.principal_member_id::text AS member_id,
      k.kind,
      k.scopes
    FROM core.api_keys k
    JOIN core.members m ON m.id = k.principal_member_id
    WHERE k.prefix = ${parsed.prefix}
      AND k.hash = ${hashApiKey(input.pepper, input.key.trim())}
      AND k.revoked_at IS NULL
      AND (k.expires_at IS NULL OR k.expires_at > ${now})
      AND m.state = 'active'
    LIMIT 1
  `) as Array<{
    id: string;
    prefix: string;
    member_id: string;
    kind: string;
    scopes: unknown;
  }>;

  if (row === undefined) {
    return null;
  }

  return {
    kind: "key",
    keyId: row.id,
    prefix: row.prefix,
    memberId: row.member_id,
    keyKind: row.kind === "integration" ? "integration" : "personal",
    scopes: parseApiScopes(row.scopes),
  };
}

/**
 * Records a successful use at most once per minute (ADR 0016's detection signal). A failed or
 * revoked key never reaches here, so the column only reflects working integrations.
 */
export async function markApiKeyUsed(
  sql: SQL,
  keyId: string,
  now: Date = new Date(),
): Promise<void> {
  const threshold = new Date(now.getTime() - LAST_USED_INTERVAL_MS);

  await sql`
    UPDATE core.api_keys
    SET last_used_at = ${now}
    WHERE id = ${keyId}
      AND (last_used_at IS NULL OR last_used_at <= ${threshold})
  `;
}
