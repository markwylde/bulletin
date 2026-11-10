import type { SQL } from "bun";
import {
  type ForumAction,
  isForumAction,
  isModeratorPower,
  type ModeratorPower,
} from "./actions.ts";
import { isPermissionKey, type PermissionKey } from "./registry.ts";
import { capabilityAnswer, loadPermissionSnapshot, type PermissionSnapshot } from "./snapshot.ts";
import type { ForumTree } from "./tree.ts";

/**
 * A permission key, forum action or moderator power, plus the forum scope the forum-level
 * checks need. A view that already holds a compiled snapshot passes it to keep checks O(1).
 */
export type PermissionAction = PermissionKey | ModeratorPower | ForumAction;

export interface PermissionScope {
  readonly forumId: string;
  readonly tree: ForumTree;
  /** Loads the session layer (password unlocks) when no snapshot is supplied. */
  readonly sessionId?: string | null;
  readonly snapshot?: PermissionSnapshot;
}

/**
 * The single authorisation entry point (ADR 0005). Callers never inspect groups or masks.
 * Forum-level checks without a scope are denied.
 */
export async function can(
  sql: SQL,
  memberId: string,
  action: PermissionAction,
  scope?: PermissionScope,
): Promise<boolean> {
  if (isModeratorPower(action)) {
    if (scope === undefined) {
      return false;
    }

    const snapshot =
      scope.snapshot ??
      (await loadPermissionSnapshot(sql, memberId, {
        tree: scope.tree,
        sessionId: scope.sessionId ?? null,
      }));

    return capabilityAnswer(snapshot, scope.forumId, action);
  }

  if (isForumAction(action)) {
    if (scope === undefined) {
      return false;
    }

    const snapshot =
      scope.snapshot ??
      (await loadPermissionSnapshot(sql, memberId, {
        tree: scope.tree,
        sessionId: scope.sessionId ?? null,
      }));

    return capabilityAnswer(snapshot, scope.forumId, action);
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
