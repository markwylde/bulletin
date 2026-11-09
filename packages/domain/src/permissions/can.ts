import type { SQL } from "bun";

/**
 * The minimal permission seam for this change. The full capability matrix replaces the
 * implementation in `groups-permissions`; callers keep using `can()` (ADR 0005).
 */
export type PermissionAction = "sessions.revoke";

export async function can(sql: SQL, memberId: string, action: PermissionAction): Promise<boolean> {
  if (action !== "sessions.revoke") {
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
