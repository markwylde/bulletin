import type { SQL } from "bun";
import { isModeratorPower } from "./actions.ts";
import {
  globalModeratorPowers,
  type ModeratorAssignment,
  type ModeratorContext,
} from "./moderator.ts";
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

/** Loads a member's groups and their raw registry values in one query. */
export async function loadMemberGroups(
  sql: SQL,
  memberId: string,
): Promise<readonly MemberGroupRecord[]> {
  const rows = (await sql`
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
  `) as MemberGroupRow[];

  return rows.map((row) => ({
    groupId: row.group_id,
    key: row.key,
    isPrimary: row.is_primary,
    values: row.settings ?? {},
  }));
}

export async function loadMergedGroupSettings(
  sql: SQL,
  memberId: string,
): Promise<MergedGroupSettings> {
  return mergeGroupSettings(await loadMemberGroups(sql, memberId));
}

/** Member-specific and group assignments that can apply to the member. */
export async function loadModeratorAssignments(
  sql: SQL,
  memberId: string,
): Promise<readonly ModeratorAssignment[]> {
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
  const merged = mergeGroupSettings(groups);

  return {
    memberId,
    groupIds: groups.map((group) => group.groupId),
    banned:
      merged["restrictions.banned"] === true || groups.some((group) => group.key === "banned"),
    globalPowers: globalModeratorPowers(merged),
    assignments: await loadModeratorAssignments(sql, memberId),
    tree,
  };
}
