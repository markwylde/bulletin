import type { StaffLocaleChange } from "@bulletin/domain/auth";
import type { SQL } from "bun";

export interface AdminLogWrite {
  readonly actorMemberId: string;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly summary: Readonly<Record<string, unknown>>;
}

export interface AdminLogEntry {
  readonly id: string;
  readonly actor: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly summary: unknown;
  readonly createdAt: string;
}

export interface AdminLogFilter {
  readonly actor?: string;
  readonly action?: string;
  /** Inclusive `YYYY-MM-DD`. */
  readonly from?: string;
  /** Inclusive `YYYY-MM-DD`. */
  readonly to?: string;
  /** Return entries older than this audit id. */
  readonly cursor?: string;
  readonly limit?: number;
}

export interface AdminLogPage {
  readonly entries: readonly AdminLogEntry[];
  readonly nextCursor: string | null;
}

function dateOrNull(value: string | undefined): string | null {
  return value === undefined || value.trim() === "" ? null : value;
}

function parseSummary(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Writes one audit row. Callers pass their transaction so the audit commits with the change. */
export async function writeAdminLog(sql: SQL, entry: AdminLogWrite): Promise<void> {
  await sql`
    INSERT INTO core.admin_log (actor_member_id, action, target_type, target_id, summary)
    VALUES (
      ${entry.actorMemberId}, ${entry.action}, ${entry.targetType}, ${entry.targetId},
      ${entry.summary}::jsonb
    )
  `;
}

/** Staff locale preferences are staff writes, so they share the audit trail. */
export async function auditStaffLocaleChange(sql: SQL, change: StaffLocaleChange): Promise<void> {
  await writeAdminLog(sql, {
    actorMemberId: change.memberId,
    action: "staff.locale.update",
    targetType: "staff_locale",
    targetId: change.memberId,
    summary: {
      before: { locale: change.before },
      after: { locale: change.after },
    },
  });
}

export async function listAdminLog(sql: SQL, filter: AdminLogFilter = {}): Promise<AdminLogPage> {
  const actor = filter.actor?.trim() ?? "";
  const action = filter.action?.trim() ?? "";
  const from = dateOrNull(filter.from);
  const to = dateOrNull(filter.to);
  const cursor = filter.cursor?.trim() === "" ? null : (filter.cursor ?? null);
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 100);

  const rows = (await sql`
    SELECT
      a.id,
      m.display_name AS actor,
      a.action,
      a.target_type,
      a.target_id,
      a.summary,
      a.created_at
    FROM core.admin_log a
    LEFT JOIN core.members m ON m.id = a.actor_member_id
    WHERE (${actor} = '' OR m.display_name ILIKE ${`%${actor}%`})
      AND (${action} = '' OR a.action = ${action})
      AND (${from}::date IS NULL OR a.created_at >= ${from}::date)
      AND (${to}::date IS NULL OR a.created_at < ${to}::date + interval '1 day')
      AND (${cursor}::bigint IS NULL OR a.id < ${cursor}::bigint)
    ORDER BY a.id DESC
    LIMIT ${limit + 1}
  `) as Array<{
    id: string;
    actor: string | null;
    action: string;
    target_type: string | null;
    target_id: string | null;
    summary: unknown;
    created_at: Date;
  }>;

  const entries = rows.slice(0, limit).map((row) => ({
    id: String(row.id),
    actor: row.actor,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id === null ? null : String(row.target_id),
    summary: parseSummary(row.summary),
    createdAt: row.created_at.toISOString(),
  }));

  return {
    entries,
    nextCursor: rows.length > limit ? (entries.at(-1)?.id ?? null) : null,
  };
}
