import type { SQL } from "bun";
import { type AcpPermission, isAcpPermission } from "./acp.ts";

/**
 * The minimal permission seam for this change. The full capability matrix replaces the
 * implementation in `groups-permissions`; callers keep using `can()` (ADR 0005).
 */
export type PermissionAction =
  | AcpPermission
  | "board.view_offline"
  | "sessions.revoke"
  | "members.view_name_history";

export async function can(sql: SQL, memberId: string, action: PermissionAction): Promise<boolean> {
  if (isAcpPermission(action) || action === "board.view_offline") {
    const rows = (await sql`
      SELECT 1
      FROM core.member_groups mg
      JOIN core.group_acp_permissions p ON p.group_id = mg.group_id
      WHERE mg.member_id = ${memberId} AND p.permission = ${action}
      LIMIT 1
    `) as unknown[];

    return rows.length > 0;
  }

  if (action !== "sessions.revoke" && action !== "members.view_name_history") {
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
