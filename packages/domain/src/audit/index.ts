import type { SQL } from "bun";

/** A service-originated audit event: the actor is the system, never a member. */
export interface SystemAuditEntry {
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId?: string | null;
  readonly summary: Readonly<Record<string, unknown>>;
}

/**
 * Queues a system event for the staff app's admin log (ADR 0001, 0012). `user_app` may append
 * to the UNLOGGED buffer only; the workers maintenance job is the authorised writer that moves
 * entries into the durable `core.admin_log`.
 */
export async function queueSystemAudit(sql: SQL, entry: SystemAuditEntry): Promise<void> {
  await sql`
    INSERT INTO core.system_audit_buffer (action, target_type, target_id, summary)
    VALUES (
      ${entry.action}, ${entry.targetType}, ${entry.targetId ?? null}, ${entry.summary}::jsonb
    )
  `;
}

export interface ForwardSystemAuditsOptions {
  /** How many queued entries one drain moves; the maintenance job runs every minute. */
  readonly limit?: number;
}

export interface ForwardSystemAuditsResult {
  readonly forwarded: number;
}

interface BufferedAuditRow {
  readonly action: string;
  readonly target_type: string | null;
  readonly target_id: string | null;
  readonly summary: unknown;
}

/**
 * Moves queued events into `core.admin_log` and removes them from the buffer (ADR 0012). Both
 * steps share a transaction, so a failed insert restores the queue entry; concurrent workers
 * skip each other's locked rows.
 */
export async function forwardSystemAudits(
  sql: SQL,
  options: ForwardSystemAuditsOptions = {},
): Promise<ForwardSystemAuditsResult> {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1_000);

  return sql.begin(async (tx) => {
    const rows = (await tx`
      DELETE FROM core.system_audit_buffer
      WHERE id IN (
        SELECT id
        FROM core.system_audit_buffer
        ORDER BY id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING action, target_type, target_id::text AS target_id, summary
    `) as BufferedAuditRow[];

    for (const row of rows) {
      await tx`
        INSERT INTO core.admin_log (actor_member_id, action, target_type, target_id, summary)
        VALUES (
          NULL, ${row.action}, ${row.target_type}, ${row.target_id}, ${row.summary}::jsonb
        )
      `;
    }

    return { forwarded: rows.length };
  });
}
