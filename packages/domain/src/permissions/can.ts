import type { SQL } from "bun";
import { isModeratorPower, type ModeratorPower } from "./actions.ts";
import { moderatorPowerAllowed } from "./moderator.ts";
import { isPermissionKey, type PermissionKey } from "./registry.ts";
import { loadModeratorContext } from "./store.ts";
import type { ForumTree } from "./tree.ts";

/**
 * A permission key plus the forum scope moderator powers need. Forum actions are evaluated by
 * the snapshot compiler in task group 2; group and staff permissions and moderator powers are
 * available here.
 */
export type PermissionAction = PermissionKey | ModeratorPower;

export interface PermissionScope {
  readonly forumId: string;
  readonly tree: ForumTree;
}

/**
 * The single authorisation entry point (ADR 0005). Callers never inspect groups or masks.
 * A moderator power without a forum scope is denied.
 */
export async function can(
  sql: SQL,
  memberId: string,
  action: PermissionAction,
  scope?: PermissionScope,
): Promise<boolean> {
  if (isModeratorPower(action)) {
    return scope === undefined ? false : canModerate(sql, memberId, action, scope);
  }

  if (!isPermissionKey(action)) {
    return false;
  }

  const rows = (await sql`
    SELECT 1
    FROM core.member_groups mg
    JOIN core.group_settings s ON s.group_id = mg.group_id
    WHERE mg.member_id = ${memberId}
      AND s.key = ${action}
      AND s.value = 'true'::jsonb
    LIMIT 1
  `) as unknown[];

  return rows.length > 0;
}

/** Moderator powers for one forum, sharing the SQL mirror's semantics (ADR 0005, 0012). */
export async function canModerate(
  sql: SQL,
  memberId: string,
  power: ModeratorPower,
  scope: PermissionScope,
): Promise<boolean> {
  const context = await loadModeratorContext(sql, memberId, scope.tree);
  return moderatorPowerAllowed(context, scope.forumId, power);
}
