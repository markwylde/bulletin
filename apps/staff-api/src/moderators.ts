import {
  bumpPermVersion,
  isModeratorPower,
  MODERATOR_POWERS,
  type ModeratorPower,
} from "@bulletin/domain/permissions";
import type { SQL } from "bun";
import { writeAdminLog } from "./admin-log.ts";

export interface ModeratorView {
  readonly assignments: ReadonlyArray<{
    id: string;
    forumId: string;
    memberId: string | null;
    groupId: string | null;
    memberName: string | null;
    groupKey: string | null;
    powers: readonly ModeratorPower[];
    thisForumOnly: boolean;
  }>;
  readonly groups: ReadonlyArray<{ id: string; key: string; title: string }>;
  readonly members: ReadonlyArray<{ id: string; displayName: string }>;
  readonly forums: ReadonlyArray<{ id: string; parentId: string | null }>;
  readonly powers: readonly ModeratorPower[];
}

export type ModeratorMutation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | "invalid_request"
        | "invalid_forum"
        | "invalid_assignee"
        | "invalid_power"
        | "not_found";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface AssignmentRow {
  readonly id: string;
  readonly forum_id: string;
  readonly member_id: string | null;
  readonly group_id: string | null;
  readonly member_name: string | null;
  readonly group_key: string | null;
  readonly powers: readonly string[];
  readonly this_forum_only: boolean;
}

export async function listModerators(sql: SQL): Promise<ModeratorView> {
  const assignments = (await sql`
    SELECT m.id, m.forum_id, m.member_id, m.group_id,
           member.display_name AS member_name,
           g.key AS group_key,
           m.powers, m.this_forum_only
    FROM core.moderators m
    LEFT JOIN core.members member ON member.id = m.member_id
    LEFT JOIN core.groups g ON g.id = m.group_id
    ORDER BY m.forum_id, m.id
  `) as AssignmentRow[];
  const groups = (await sql`
    SELECT id, key, title FROM core.groups ORDER BY display_order, id
  `) as Array<{ id: string; key: string; title: string }>;
  const members = (await sql`
    SELECT id, display_name
    FROM core.members
    WHERE display_name IS NOT NULL
    ORDER BY display_name
    LIMIT 200
  `) as Array<{ id: string; display_name: string }>;
  const forums = (await sql`
    SELECT id, parent_id FROM core.forums ORDER BY id
  `) as Array<{ id: string; parent_id: string | null }>;

  return {
    assignments: assignments.map((row) => ({
      id: row.id,
      forumId: row.forum_id,
      memberId: row.member_id,
      groupId: row.group_id,
      memberName: row.member_name,
      groupKey: row.group_key,
      powers: row.powers.filter(isModeratorPower),
      thisForumOnly: row.this_forum_only,
    })),
    groups,
    members: members.map((member) => ({
      id: member.id,
      displayName: member.display_name,
    })),
    forums: forums.map((forum) => ({ id: forum.id, parentId: forum.parent_id })),
    powers: MODERATOR_POWERS,
  };
}

export async function saveModerator(
  sql: SQL,
  actorMemberId: string,
  input: unknown,
): Promise<ModeratorMutation> {
  if (
    !isRecord(input) ||
    typeof input.forumId !== "string" ||
    (input.assigneeKind !== "member" && input.assigneeKind !== "group") ||
    typeof input.assigneeId !== "string" ||
    !Array.isArray(input.powers)
  ) {
    return { ok: false, code: "invalid_request" };
  }

  const powers = input.powers.filter((power): power is ModeratorPower => {
    return typeof power === "string" && isModeratorPower(power);
  });

  if (powers.length !== input.powers.length) {
    return { ok: false, code: "invalid_power" };
  }

  const id = typeof input.id === "string" ? input.id : null;
  const thisForumOnly = input.thisForumOnly === true;

  return sql.begin(async (tx) => {
    const [forum] = (await tx`
      SELECT id FROM core.forums WHERE id = ${input.forumId}
    `) as Array<{ id: string }>;

    if (forum === undefined) {
      return { ok: false, code: "invalid_forum" } as const;
    }

    const assignee =
      input.assigneeKind === "member"
        ? ((await tx`
            SELECT id, display_name AS label FROM core.members WHERE id = ${input.assigneeId}
          `) as Array<{ id: string; label: string | null }>)
        : ((await tx`
            SELECT id, key AS label FROM core.groups WHERE id = ${input.assigneeId}
          `) as Array<{ id: string; label: string }>);

    if (assignee[0] === undefined) {
      return { ok: false, code: "invalid_assignee" } as const;
    }

    const before =
      id === null
        ? []
        : ((await tx`
          SELECT id, forum_id, member_id, group_id, powers, this_forum_only
          FROM core.moderators
          WHERE id = ${id}
          FOR UPDATE
        `) as Array<{
            id: string;
            forum_id: string;
            member_id: string | null;
            group_id: string | null;
            powers: string[];
            this_forum_only: boolean;
          }>);

    if (id !== null && before[0] === undefined) {
      return { ok: false, code: "not_found" } as const;
    }

    // One assignment per forum and assignee; replacing keeps the editor idempotent.
    if (input.assigneeKind === "member") {
      await tx`
        DELETE FROM core.moderators
        WHERE forum_id = ${input.forumId} AND member_id = ${input.assigneeId}
      `;
    } else {
      await tx`
        DELETE FROM core.moderators
        WHERE forum_id = ${input.forumId} AND group_id = ${input.assigneeId}
      `;
    }

    if (id !== null) {
      await tx`DELETE FROM core.moderators WHERE id = ${id}`;
    }

    const [inserted] = (await tx`
      INSERT INTO core.moderators (forum_id, member_id, group_id, powers, this_forum_only)
      VALUES (
        ${input.forumId},
        ${input.assigneeKind === "member" ? input.assigneeId : null},
        ${input.assigneeKind === "group" ? input.assigneeId : null},
        ${`{${powers.join(",")}}`}::text[],
        ${thisForumOnly}
      )
      RETURNING id
    `) as Array<{ id: string }>;

    if (inserted === undefined) {
      throw new Error("Moderator insert returned no row");
    }

    await bumpPermVersion(tx);
    await writeAdminLog(tx, {
      actorMemberId,
      action: "moderator.save",
      targetType: "moderator",
      targetId: inserted.id,
      summary: {
        forumId: input.forumId,
        assigneeKind: input.assigneeKind,
        assigneeId: input.assigneeId,
        powers,
        thisForumOnly,
        before: before[0] ?? null,
      },
    });

    return { ok: true } as const;
  });
}

export async function deleteModerator(
  sql: SQL,
  actorMemberId: string,
  input: unknown,
): Promise<ModeratorMutation> {
  if (!isRecord(input) || typeof input.id !== "string") {
    return { ok: false, code: "invalid_request" };
  }

  const id = input.id;

  return sql.begin(async (tx) => {
    const [before] = (await tx`
      SELECT id, forum_id, member_id, group_id, powers, this_forum_only
      FROM core.moderators
      WHERE id = ${id}
      FOR UPDATE
    `) as Array<{
      id: string;
      forum_id: string;
      member_id: string | null;
      group_id: string | null;
      powers: string[];
      this_forum_only: boolean;
    }>;

    if (before === undefined) {
      return { ok: false, code: "not_found" } as const;
    }

    await tx`DELETE FROM core.moderators WHERE id = ${id}`;
    await bumpPermVersion(tx);
    await writeAdminLog(tx, {
      actorMemberId,
      action: "moderator.delete",
      targetType: "moderator",
      targetId: id,
      summary: { before },
    });

    return { ok: true } as const;
  });
}
