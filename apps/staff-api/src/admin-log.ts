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
  readonly limit?: number;
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

export async function listAdminLog(
  sql: SQL,
  filter: AdminLogFilter = {},
): Promise<AdminLogEntry[]> {
  const actor = filter.actor?.trim() ?? "";
  const action = filter.action?.trim() ?? "";
  const from = dateOrNull(filter.from);
  const to = dateOrNull(filter.to);
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1_000);

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
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ${limit}
  `) as Array<{
    id: string;
    actor: string | null;
    action: string;
    target_type: string | null;
    target_id: string | null;
    summary: unknown;
    created_at: Date;
  }>;

  return rows.map((row) => ({
    id: String(row.id),
    actor: row.actor,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id === null ? null : String(row.target_id),
    summary: parseSummary(row.summary),
    createdAt: row.created_at.toISOString(),
  }));
}
