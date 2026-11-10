import type { SQL } from "bun";

export const DRAFT_MAX_LENGTH = 100_000;
export const DRAFT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const DRAFT_CONTEXT = /^[a-z0-9][a-z0-9:._-]{0,119}$/;

export interface Draft {
  readonly contextKey: string;
  readonly bodyMd: string;
  readonly updatedAt: Date;
}

interface DraftRow {
  readonly context_key: string;
  readonly body_md: string;
  readonly updated_at: Date;
}

function toDraft(row: DraftRow): Draft {
  return {
    contextKey: row.context_key,
    bodyMd: row.body_md,
    updatedAt: row.updated_at,
  };
}

export function validDraftContext(value: unknown): value is string {
  return typeof value === "string" && DRAFT_CONTEXT.test(value);
}

export function validDraftBody(value: unknown): value is string {
  return typeof value === "string" && value.length <= DRAFT_MAX_LENGTH;
}

/** Reads one member's draft; never accepts a member id from the caller's body. */
export async function readDraft(
  sql: SQL,
  memberId: string,
  contextKey: string,
): Promise<Draft | null> {
  if (!validDraftContext(contextKey)) {
    return null;
  }

  const rows = (await sql`
    SELECT context_key, body_md, updated_at
    FROM core.drafts
    WHERE member_id = ${memberId} AND context_key = ${contextKey}
  `) as DraftRow[];

  const row = rows[0];
  return row === undefined ? null : toDraft(row);
}

/** An empty body clears the draft instead of storing an empty row. */
export async function saveDraft(
  sql: SQL,
  memberId: string,
  contextKey: string,
  bodyMd: string,
  now: Date = new Date(),
): Promise<Draft | null> {
  if (!validDraftContext(contextKey) || !validDraftBody(bodyMd)) {
    return null;
  }

  if (bodyMd.trim() === "") {
    await deleteDraft(sql, memberId, contextKey);
    return null;
  }

  const rows = (await sql`
    INSERT INTO core.drafts (member_id, context_key, body_md, updated_at)
    VALUES (${memberId}, ${contextKey}, ${bodyMd}, ${now})
    ON CONFLICT (member_id, context_key) DO UPDATE
      SET body_md = EXCLUDED.body_md, updated_at = EXCLUDED.updated_at
    RETURNING context_key, body_md, updated_at
  `) as DraftRow[];

  const row = rows[0];
  return row === undefined ? null : toDraft(row);
}

export async function deleteDraft(sql: SQL, memberId: string, contextKey: string): Promise<void> {
  if (!validDraftContext(contextKey)) {
    return;
  }

  await sql`
    DELETE FROM core.drafts
    WHERE member_id = ${memberId} AND context_key = ${contextKey}
  `;
}

/** Retention sweep: drafts untouched for 30 days are deleted (ADR 0012). */
export async function purgeExpiredDrafts(sql: SQL, now: Date = new Date()): Promise<number> {
  const before = new Date(now.getTime() - DRAFT_RETENTION_MS);
  const rows = (await sql`
    DELETE FROM core.drafts
    WHERE updated_at < ${before}
    RETURNING member_id
  `) as Array<{ member_id: string }>;

  return rows.length;
}
