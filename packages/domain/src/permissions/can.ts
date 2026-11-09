import type { SQL } from "bun";

/**
 * The minimal permission seam for this change. The full capability matrix replaces the
 * implementation in `groups-permissions`; callers keep using `can()` (ADR 0005).
 */
export type PermissionAction = "acp.access" | "sessions.revoke" | "members.view_name_history";

export async function can(sql: SQL, memberId: string, action: PermissionAction): Promise<boolean> {
  if (
    action !== "acp.access" &&
    action !== "sessions.revoke" &&
    action !== "members.view_name_history"
  ) {
    return false;
  }

  const rows = (await sql`
    SELECT 1
    FROM core.member_groups mg
    JOIN core.groups g ON g.id = mg.group_id
    WHERE mg.member_id = ${memberId} AND g.key = 'administrators'
    LIMIT 1
  `) as unknown[];

  return rows.length > 0;
}
