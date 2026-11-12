import type { SQL } from "bun";
import {
  type ForumAction,
  isForumAction,
  isModeratorPower,
  type ModeratorPower,
} from "./actions.ts";
import { isGuestPrincipal, type ViewerPrincipal } from "./principal.ts";
import { canEditProfileField, canViewProfileField } from "./profile-fields.ts";
import { isPermissionKey, type PermissionKey } from "./registry.ts";
import { capabilityAnswer, loadPermissionSnapshot, type PermissionSnapshot } from "./snapshot.ts";
import { loadMemberGroups, loadMergedGroupSettings } from "./store.ts";
import type { ForumTree } from "./tree.ts";

/**
 * A permission key, forum action or moderator power, plus the forum scope the forum-level
 * checks need. A view that already holds a compiled snapshot passes it to keep checks O(1).
 */
export const CAPABILITY_ACTIONS = [
  "react",
  "give_reputation",
  "give_negative_reputation",
  "receive_reputation",
  "unignorable",
  "custom_title",
  "use_pm",
  "send_pm",
  "post",
] as const;

export type CapabilityAction = (typeof CAPABILITY_ACTIONS)[number];

const CAPABILITY_SETTINGS: Readonly<
  Record<CapabilityAction, { readonly key: string; readonly allows: boolean }>
> = {
  react: { key: "posting.can_react", allows: true },
  give_reputation: { key: "posting.can_give_reputation", allows: true },
  give_negative_reputation: { key: "posting.can_give_negative_reputation", allows: true },
  // A `restrict-any` opt-out: one group setting it true denies the capability.
  receive_reputation: { key: "posting.cannot_receive_reputation", allows: false },
  unignorable: { key: "members.unignorable", allows: true },
  custom_title: { key: "members.can_custom_title", allows: true },
  // A `restrict-any` opt-out: one group setting it true denies private messages.
  use_pm: { key: "restrictions.cannot_pm", allows: false },
  // A posting suspension also stops private-message writes; moderation sets the group setting.
  send_pm: { key: "restrictions.suspended", allows: false },
  // A warning-imposed posting suspension; `cannot_post` is the group/restriction overlay.
  post: { key: "restrictions.cannot_post", allows: false },
};

export function isCapabilityAction(value: string): value is CapabilityAction {
  return (CAPABILITY_ACTIONS as readonly string[]).includes(value);
}

export type PermissionAction = PermissionKey | ModeratorPower | ForumAction | CapabilityAction;

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

/** One staff-defined custom profile field. */
export interface ProfileFieldScope {
  readonly fieldId: string;
}

/** Announcement visibility combines its target groups with at least one visible target forum. */
export interface AnnouncementPermissionScope {
  readonly announcementId: string;
  readonly tree: ForumTree;
  readonly snapshot?: PermissionSnapshot;
  /** The page forum, when evaluating a block on that page. */
  readonly forumId?: string | null;
}

async function canViewAnnouncement(
  sql: SQL,
  principal: ViewerPrincipal,
  scope: AnnouncementPermissionScope,
): Promise<boolean> {
  const [announcement] = (await sql`
    SELECT id, scope FROM core.announcements WHERE id = ${scope.announcementId}
  `) as Array<{ id: string; scope: "global" | "forums" }>;

  if (announcement === undefined) {
    return false;
  }

  const snapshot =
    scope.snapshot ??
    (await loadPermissionSnapshot(sql, principal, { tree: scope.tree, sessionId: null }));
  const audience = (await sql`
    SELECT group_id FROM core.announcement_groups WHERE announcement_id = ${announcement.id}
  `) as Array<{ group_id: string }>;

  if (audience.length > 0 && !audience.some((row) => snapshot.groupIds.includes(row.group_id))) {
    return false;
  }

  if (scope.forumId !== undefined && scope.forumId !== null) {
    return capabilityAnswer(snapshot, scope.forumId, "show");
  }

  if (announcement.scope === "global") {
    return true;
  }

  const targets = (await sql`
    SELECT forum_id FROM core.announcement_targets WHERE announcement_id = ${announcement.id}
  `) as Array<{ forum_id: string }>;

  return targets.some((target) => capabilityAnswer(snapshot, target.forum_id, "show"));
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
  action: "view_announcement",
  scope: AnnouncementPermissionScope,
): Promise<boolean>;
export function can(
  sql: SQL,
  principal: ViewerPrincipal,
  action: "view_profile_field" | "edit_profile_field",
  scope: ProfileFieldScope,
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
  action:
    | PermissionAction
    | "view_prefix"
    | "view_announcement"
    | "view_profile_field"
    | "edit_profile_field",
  scope?: PermissionScope | PrefixScope | AnnouncementPermissionScope | ProfileFieldScope,
): Promise<boolean> {
  if (action === "view_announcement") {
    if (scope === undefined || !("announcementId" in scope)) {
      return false;
    }

    return canViewAnnouncement(sql, principal, scope);
  }

  if (action === "view_profile_field" || action === "edit_profile_field") {
    if (scope === undefined || !("fieldId" in scope)) {
      return false;
    }

    return action === "view_profile_field"
      ? canViewProfileField(sql, principal, scope.fieldId)
      : canEditProfileField(sql, principal, scope.fieldId);
  }

  if (action === "view_prefix") {
    if (scope === undefined || !("prefixId" in scope)) {
      return false;
    }

    return canViewPrefix(sql, principal, scope.prefixId);
  }

  const forumScope = scope as PermissionScope | undefined;

  if (isCapabilityAction(action)) {
    const settings = await loadMergedGroupSettings(sql, principal);
    const capability = CAPABILITY_SETTINGS[action];
    const enabled = settings[capability.key] === true;

    // The Banned group is the board's hard restriction for every capability (posting,
    // reactions, PMs, custom titles); keep it inside can() so no caller re-implements it.
    const groups = await loadMemberGroups(sql, principal);

    if (groups.some((group) => group.key === "banned")) {
      return false;
    }

    return capability.allows ? enabled : !enabled;
  }

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
