import type { SQL } from "bun";
import { isModeratorPower } from "./actions.ts";
import {
  globalModeratorPowers,
  type ModeratorAssignment,
  type ModeratorContext,
  memberBanned,
} from "./moderator.ts";
import { principalMemberId, type ViewerPrincipal } from "./principal.ts";
import {
  type GroupSettingsSource,
  type MergedGroupSettings,
  mergeGroupSettings,
} from "./registry.ts";
import type { ForumTree } from "./tree.ts";

export interface MemberGroupRecord extends GroupSettingsSource {
  readonly key: string;
}

interface MemberGroupRow {
  readonly group_id: string;
  readonly key: string;
  readonly is_primary: boolean;
  readonly settings: Readonly<Record<string, unknown>> | null;
}

interface ModeratorRow {
  readonly forum_id: string;
  readonly member_id: string | null;
  readonly group_id: string | null;
  readonly powers: readonly string[];
  readonly this_forum_only: boolean;
}

/** Loads a member's groups and raw registry values; guests resolve to the Guests group. */
export async function loadMemberGroups(
  sql: SQL,
  principal: ViewerPrincipal,
): Promise<readonly MemberGroupRecord[]> {
  const memberId = principalMemberId(principal);
  const rows =
    memberId === null
      ? ((await sql`
        SELECT
          g.id AS group_id,
          g.key,
          true AS is_primary,
          COALESCE(
            jsonb_object_agg(s.key, s.value) FILTER (WHERE s.key IS NOT NULL),
            '{}'::jsonb
          ) AS settings
        FROM core.groups g
        LEFT JOIN core.group_settings s ON s.group_id = g.id
        WHERE g.key = 'guests'
        GROUP BY g.id, g.key
        ORDER BY g.id
      `) as MemberGroupRow[])
      : ((await sql`
        SELECT
          g.id AS group_id,
          g.key,
          mg.is_primary,
          COALESCE(
            jsonb_object_agg(s.key, s.value) FILTER (WHERE s.key IS NOT NULL),
            '{}'::jsonb
          ) AS settings
        FROM core.member_groups mg
        JOIN core.groups g ON g.id = mg.group_id
        LEFT JOIN core.group_settings s ON s.group_id = g.id
        WHERE mg.member_id = ${memberId}
        GROUP BY g.id, g.key, mg.is_primary
        ORDER BY g.id
      `) as MemberGroupRow[]);

  return rows.map((row) => ({
    groupId: row.group_id,
    key: row.key,
    isPrimary: row.is_primary,
    values: row.settings ?? {},
  }));
}

/**
 * Active warning restrictions overlay the group result as `restrict-any` booleans. They are
 * time-limited (or permanent) state, not group settings, so they are merged here once.
 */
async function loadActiveRestrictions(
  sql: SQL,
  memberId: string | null,
): Promise<MergedGroupSettings> {
  if (memberId === null) {
    return {};
  }

  const rows = (await sql`
    SELECT kind FROM core.member_restrictions
    WHERE member_id = ${memberId}
      AND (until IS NULL OR until > now())
  `) as Array<{ kind: string }>;
  const overlay: Record<string, boolean> = {};

  for (const row of rows) {
    if (row.kind === "posts_require_approval") {
      overlay["posting.posts_require_approval"] = true;
    } else if (row.kind === "cannot_post") {
      overlay["restrictions.cannot_post"] = true;
    } else if (row.kind === "banned") {
      overlay["restrictions.banned"] = true;
    }
  }

  return overlay;
}

export async function loadMergedGroupSettings(
  sql: SQL,
  principal: ViewerPrincipal,
): Promise<MergedGroupSettings> {
  const groups = await loadMemberGroups(sql, principal);
  const merged = mergeGroupSettings(groups);
  const restrictions = await loadActiveRestrictions(sql, principalMemberId(principal));

  return Object.keys(restrictions).length === 0 ? merged : { ...merged, ...restrictions };
}

/** Member-specific and group assignments that can apply to the member. */
export async function loadModeratorAssignments(
  sql: SQL,
  principal: ViewerPrincipal,
): Promise<readonly ModeratorAssignment[]> {
  const memberId = principalMemberId(principal);

  if (memberId === null) {
    return [];
  }

  const rows = (await sql`
    SELECT forum_id, member_id, group_id, powers, this_forum_only
    FROM core.moderators
    WHERE member_id = ${memberId}
       OR group_id IN (
         SELECT group_id FROM core.member_groups WHERE member_id = ${memberId}
       )
  `) as ModeratorRow[];

  return rows.map((row) => ({
    forumId: row.forum_id,
    memberId: row.member_id,
    groupId: row.group_id,
    powers: row.powers.filter(isModeratorPower),
    thisForumOnly: row.this_forum_only,
  }));
}

/** Everything the TypeScript moderator-power evaluator needs for one member. */
export async function loadModeratorContext(
  sql: SQL,
  memberId: string,
  tree: ForumTree,
): Promise<ModeratorContext> {
  const groups = await loadMemberGroups(sql, memberId);
  const merged = await loadMergedGroupSettings(sql, memberId);

  return {
    memberId,
    groupIds: groups.map((group) => group.groupId),
    banned: memberBanned(groups, merged),
    globalPowers: globalModeratorPowers(merged),
    assignments: await loadModeratorAssignments(sql, memberId),
    tree,
  };
}

/** The password-forum unlocks attached to a session (ADR 0018); empty without a session. */
export async function loadSessionUnlocks(
  sql: SQL,
  sessionId: string | null,
): Promise<ReadonlySet<string>> {
  if (sessionId === null) {
    return new Set();
  }

  const rows = (await sql`
    SELECT resource_id::text AS resource_id
    FROM core.session_grants
    WHERE session_id = ${sessionId}
      AND kind = 'forum_password'
      AND (expires_at IS NULL OR expires_at > now())
  `) as Array<{ resource_id: string }>;

  return new Set(rows.map((row) => row.resource_id));
}
