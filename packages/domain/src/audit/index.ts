import type { SQL } from "bun";

/** A service-originated audit event: the actor is the system, never a member. */
export interface SystemAuditEntry {
  readonly action: string;
  readonly targetType: string | null;
  readonly summary: Readonly<Record<string, unknown>>;
}

/**
 * Appends a system event to the admin log (ADR 0012). The staff app already lists these rows,
 * so failures that happen without a session (a template fallback, an omitted island) become
 * visible to admins without a separate reporting service.
 */
export async function writeSystemAudit(sql: SQL, entry: SystemAuditEntry): Promise<void> {
  await sql`
    INSERT INTO core.admin_log (actor_member_id, action, target_type, target_id, summary)
    VALUES (NULL, ${entry.action}, ${entry.targetType}, NULL, ${entry.summary}::jsonb)
  `;
}
