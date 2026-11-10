import type { SQL } from "bun";
import {
  type ForumAction,
  isForumAction,
  isModeratorPower,
  type ModeratorPower,
} from "./actions.ts";
import { isGuestPrincipal, type ViewerPrincipal } from "./principal.ts";
import { isPermissionKey, type PermissionKey } from "./registry.ts";
import { capabilityAnswer, loadPermissionSnapshot, type PermissionSnapshot } from "./snapshot.ts";
import { loadMemberGroups } from "./store.ts";
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

/** A prefix restriction is evaluated against the same compiled group set as forum actions. */
export interface PrefixScope {
  readonly prefixId: string;
}

async function canViewPrefix(
  sql: SQL,
  principal: ViewerPrincipal,
  prefixId: string,
): Promise<boolean> {
  const groups = await loadMemberGroups(sql, principal);
  const groupIds = new Set(groups.map((group) => group.groupId));
  const restricted = (await sql`
    SELECT group_id FROM core.prefix_groups WHERE prefix_id = ${prefixId}
  `) as Array<{ group_id: string }>;

  return restricted.length === 0 || restricted.some((row) => groupIds.has(row.group_id));
}

/**
 * The single authorisation entry point (ADR 0005). Callers never inspect groups or masks.
 * Forum-level checks without a scope are denied. Prefix availability is checked here too, so
 * restricted prefixes cannot be filtered by ad-hoc group checks in a view.
 */
export function can(
  sql: SQL,
  principal: ViewerPrincipal,
  action: "view_prefix",
  scope: PrefixScope,
): Promise<boolean>;
export function can(
  sql: SQL,
  principal: ViewerPrincipal,
  action: PermissionAction,
  scope?: PermissionScope,
): Promise<boolean>;
export async function can(
  sql: SQL,
  principal: ViewerPrincipal,
  action: PermissionAction | "view_prefix",
  scope?: PermissionScope | PrefixScope,
): Promise<boolean> {
  if (action === "view_prefix") {
    if (scope === undefined || !("prefixId" in scope)) {
      return false;
    }

    return canViewPrefix(sql, principal, scope.prefixId);
  }

  const forumScope = scope as PermissionScope | undefined;

  if (isModeratorPower(action)) {
    if (forumScope === undefined) {
      return false;
    }

    const snapshot =
      forumScope.snapshot ??
      (await loadPermissionSnapshot(sql, principal, {
        tree: forumScope.tree,
        sessionId: forumScope.sessionId ?? null,
      }));

    return capabilityAnswer(snapshot, forumScope.forumId, action);
  }

  if (isForumAction(action)) {
    if (forumScope === undefined) {
      return false;
    }

    const snapshot =
      forumScope.snapshot ??
      (await loadPermissionSnapshot(sql, principal, {
        tree: forumScope.tree,
        sessionId: forumScope.sessionId ?? null,
      }));

    return capabilityAnswer(snapshot, forumScope.forumId, action);
  }

  if (!isPermissionKey(action)) {
    return false;
  }

  if (isGuestPrincipal(principal)) {
    const rows = (await sql`
      SELECT 1
      FROM core.groups g
      JOIN core.group_settings s ON s.group_id = g.id
      WHERE g.key = 'guests'
        AND s.key = ${action}
        AND s.value = 'true'::jsonb
      LIMIT 1
    `) as unknown[];

    return rows.length > 0;
  }

  const rows = (await sql`
    SELECT 1
    FROM core.member_groups mg
    JOIN core.group_settings s ON s.group_id = mg.group_id
    WHERE mg.member_id = ${principal}
      AND s.key = ${action}
      AND s.value = 'true'::jsonb
    LIMIT 1
  `) as unknown[];

  return rows.length > 0;
}
