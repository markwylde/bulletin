import {
  bumpPermVersion,
  GROUP_SETTINGS,
  type GroupSettingDefinition,
  parseGroupSettingValue,
  settingDefinition,
} from "@bulletin/domain/permissions";
import type { SQL } from "bun";
import { writeAdminLog } from "./admin-log.ts";

const GROUP_KEY = /^[a-z][a-z0-9_]*$/;
const COLOUR = /^#[0-9a-fA-F]{6}$/;
const ICON = /^[a-z][a-z0-9_-]*$/;

export interface GroupAdminView {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly isSystem: boolean;
  readonly displayOrder: number;
  readonly nameColour: string | null;
  readonly icon: string | null;
  readonly memberCount: number;
  readonly primaryMemberCount: number;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly masks: readonly string[];
}

export interface GroupMutationFailure {
  readonly ok: false;
  readonly code:
    | "invalid_request"
    | "invalid_key"
    | "invalid_group"
    | "duplicate_key"
    | "not_found"
    | "system_group"
    | "replacement_required"
    | "group_in_use";
  readonly fields?: readonly string[];
}

export type GroupMutation = { readonly ok: true } | GroupMutationFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (("code" in error && (error as { code?: string }).code === "23505") ||
      ("errno" in error && (error as { errno?: string }).errno === "23505"))
  );
}

function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (("code" in error && (error as { code?: string }).code === "23503") ||
      ("errno" in error && (error as { errno?: string }).errno === "23503"))
  );
}

function validTitle(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const title = value.trim();
  return title.length > 0 && title.length <= 100 ? title : null;
}

function validColour(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }

  return typeof value === "string" && COLOUR.test(value) ? value : undefined;
}

function validIcon(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }

  return typeof value === "string" && ICON.test(value) ? value : undefined;
}

function validOrder(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100_000
    ? value
    : null;
}

interface GroupRow {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly is_system: boolean;
  readonly display_order: number;
  readonly name_colour: string | null;
  readonly icon: string | null;
  readonly member_count: number;
  readonly primary_count: number;
}

export async function listGroups(sql: SQL): Promise<readonly GroupAdminView[]> {
  const rows = (await sql`
    SELECT
      g.id,
      g.key,
      g.title,
      g.is_system,
      g.display_order,
      g.name_colour,
      g.icon,
      count(DISTINCT mg.member_id)::int AS member_count,
      count(DISTINCT mg.member_id) FILTER (WHERE mg.is_primary)::int AS primary_count
    FROM core.groups g
    LEFT JOIN core.member_groups mg ON mg.group_id = g.id
    GROUP BY g.id
    ORDER BY g.display_order, g.id
  `) as GroupRow[];

  const settings = (await sql`
    SELECT group_id, key, value FROM core.group_settings
  `) as Array<{ group_id: string; key: string; value: unknown }>;
  const settingsByGroup = new Map<string, Record<string, unknown>>();

  for (const row of settings) {
    const values = settingsByGroup.get(row.group_id) ?? {};
    values[row.key] = row.value;
    settingsByGroup.set(row.group_id, values);
  }

  const masks = (await sql`
    SELECT gm.group_id, m.key
    FROM core.group_masks gm
    JOIN core.masks m ON m.id = gm.mask_id
    ORDER BY m.display_order, m.key
  `) as Array<{ group_id: string; key: string }>;
  const masksByGroup = new Map<string, string[]>();

  for (const row of masks) {
    const keys = masksByGroup.get(row.group_id) ?? [];
    keys.push(row.key);
    masksByGroup.set(row.group_id, keys);
  }

  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    title: row.title,
    isSystem: row.is_system,
    displayOrder: row.display_order,
    nameColour: row.name_colour,
    icon: row.icon,
    memberCount: row.member_count,
    primaryMemberCount: row.primary_count,
    settings: settingsByGroup.get(row.id) ?? {},
    masks: masksByGroup.get(row.id) ?? [],
  }));
}

export async function createGroup(
  sql: SQL,
  actorMemberId: string,
  input: unknown,
): Promise<GroupMutation> {
  if (!isRecord(input)) {
    return { ok: false, code: "invalid_request" };
  }

  const key = typeof input.key === "string" ? input.key.trim() : "";
  const title = validTitle(input.title);
  const colour = validColour(input.nameColour ?? null);
  const icon = validIcon(input.icon ?? null);
  const order = validOrder(input.displayOrder ?? 0);

  if (!GROUP_KEY.test(key)) {
    return { ok: false, code: "invalid_key" };
  }

  if (title === null || colour === undefined || icon === undefined || order === null) {
    return { ok: false, code: "invalid_group" };
  }

  try {
    await sql.begin(async (tx) => {
      const [group] = (await tx`
        INSERT INTO core.groups (key, title, display_order, name_colour, icon)
        VALUES (${key}, ${title}, ${order}, ${colour}, ${icon})
        RETURNING id, key, title
      `) as Array<{ id: string; key: string; title: string }>;

      if (group === undefined) {
        throw new Error("Group insert returned no row");
      }

      await bumpPermVersion(tx);
      await writeAdminLog(tx, {
        actorMemberId,
        action: "group.create",
        targetType: "group",
        targetId: group.id,
        summary: { key: group.key, title: group.title, displayOrder: order },
      });
    });
  } catch (error) {
    return { ok: false, code: isUniqueViolation(error) ? "duplicate_key" : "invalid_group" };
  }

  return { ok: true };
}

export async function updateGroup(
  sql: SQL,
  actorMemberId: string,
  input: unknown,
): Promise<GroupMutation> {
  if (!isRecord(input) || typeof input.id !== "string") {
    return { ok: false, code: "invalid_request" };
  }

  const groupId = input.id;
  const title = validTitle(input.title);
  const colour = validColour(input.nameColour ?? null);
  const icon = validIcon(input.icon ?? null);
  const order = validOrder(input.displayOrder ?? 0);

  if (title === null || colour === undefined || icon === undefined || order === null) {
    return { ok: false, code: "invalid_group" };
  }

  return sql.begin(async (tx) => {
    const [before] = (await tx`
      SELECT id, key, title, display_order, name_colour, icon
      FROM core.groups
      WHERE id = ${groupId}
      FOR UPDATE
    `) as Array<{
      id: string;
      key: string;
      title: string;
      display_order: number;
      name_colour: string | null;
      icon: string | null;
    }>;

    if (before === undefined) {
      return { ok: false, code: "not_found" } as const;
    }

    await tx`
      UPDATE core.groups
      SET title = ${title},
          display_order = ${order},
          name_colour = ${colour},
          icon = ${icon}
      WHERE id = ${groupId}
    `;
    await bumpPermVersion(tx);
    await writeAdminLog(tx, {
      actorMemberId,
      action: "group.update",
      targetType: "group",
      targetId: groupId,
      summary: {
        key: before.key,
        before: {
          title: before.title,
          displayOrder: before.display_order,
          nameColour: before.name_colour,
          icon: before.icon,
        },
        after: { title, displayOrder: order, nameColour: colour, icon },
      },
    });

    return { ok: true } as const;
  });
}

export async function reorderGroups(
  sql: SQL,
  actorMemberId: string,
  input: unknown,
): Promise<GroupMutation> {
  if (!isRecord(input) || !Array.isArray(input.ids)) {
    return { ok: false, code: "invalid_request" };
  }

  const ids = input.ids.filter((id): id is string => typeof id === "string");

  if (ids.length !== input.ids.length || new Set(ids).size !== ids.length) {
    return { ok: false, code: "invalid_request" };
  }

  return sql.begin(async (tx) => {
    const existing = (await tx`
      SELECT id FROM core.groups ORDER BY id
    `) as Array<{ id: string }>;

    if (existing.length !== ids.length || existing.some((row) => !ids.includes(row.id))) {
      return { ok: false, code: "invalid_request" } as const;
    }

    for (const [index, id] of ids.entries()) {
      await tx`UPDATE core.groups SET display_order = ${index * 10} WHERE id = ${id}`;
    }

    await bumpPermVersion(tx);
    await writeAdminLog(tx, {
      actorMemberId,
      action: "group.reorder",
      targetType: "group",
      targetId: null,
      summary: { order: ids },
    });

    return { ok: true } as const;
  });
}

export async function deleteGroup(
  sql: SQL,
  actorMemberId: string,
  input: unknown,
): Promise<GroupMutation> {
  if (!isRecord(input) || typeof input.id !== "string") {
    return { ok: false, code: "invalid_request" };
  }

  const replacement =
    typeof input.replacementGroupId === "string" ? input.replacementGroupId : null;

  try {
    return await sql.begin(async (tx) => {
      const [group] = (await tx`
        SELECT id, key, title, is_system
        FROM core.groups
        WHERE id = ${input.id}
        FOR UPDATE
      `) as Array<{ id: string; key: string; title: string; is_system: boolean }>;

      if (group === undefined) {
        return { ok: false, code: "not_found" } as const;
      }

      if (group.is_system) {
        return { ok: false, code: "system_group" } as const;
      }

      // An empty audience means "everyone". Deleting a referenced group would cascade its
      // allow-list away and widen the audience, so refuse until staff remove the reference.
      const [references] = (await tx`
        SELECT
          EXISTS (SELECT 1 FROM core.announcement_groups WHERE group_id = ${input.id})
            AS announcements,
          EXISTS (SELECT 1 FROM core.prefix_groups WHERE group_id = ${input.id})
            AS prefixes,
          EXISTS (SELECT 1 FROM core.profile_field_groups WHERE group_id = ${input.id})
            AS profile_fields
      `) as Array<{ announcements: boolean; prefixes: boolean; profile_fields: boolean }>;

      if (
        references?.announcements === true ||
        references?.prefixes === true ||
        references?.profile_fields === true
      ) {
        return { ok: false, code: "group_in_use" } as const;
      }

      const [count] = (await tx`
        SELECT count(*)::int AS primary_members
        FROM core.member_groups
        WHERE group_id = ${input.id} AND is_primary
      `) as Array<{ primary_members: number }>;
      const primaryMembers = count?.primary_members ?? 0;

      if (primaryMembers > 0) {
        if (replacement === null || replacement === input.id) {
          return { ok: false, code: "replacement_required" } as const;
        }

        const [target] = (await tx`
          SELECT id, key FROM core.groups WHERE id = ${replacement}
        `) as Array<{ id: string; key: string }>;

        if (target === undefined) {
          return { ok: false, code: "invalid_group" } as const;
        }

        // Remove the replacement group's secondary row so the primary move cannot conflict.
        await tx`
          DELETE FROM core.member_groups secondary
          USING core.member_groups current
          WHERE current.group_id = ${input.id}
            AND current.is_primary
            AND secondary.member_id = current.member_id
            AND secondary.group_id = ${replacement}
            AND NOT secondary.is_primary
        `;
        await tx`
          UPDATE core.member_groups
          SET group_id = ${replacement}
          WHERE group_id = ${input.id} AND is_primary
        `;
      }

      await tx`DELETE FROM core.groups WHERE id = ${input.id}`;
      await bumpPermVersion(tx);
      await writeAdminLog(tx, {
        actorMemberId,
        action: "group.delete",
        targetType: "group",
        targetId: group.id,
        summary: {
          key: group.key,
          title: group.title,
          primaryMembersMoved: primaryMembers,
          replacementGroupId: replacement,
        },
      });

      return { ok: true } as const;
    });
  } catch (error) {
    // The restricting foreign keys are the backstop when a reference is added concurrently.
    if (isForeignKeyViolation(error)) {
      return { ok: false, code: "group_in_use" };
    }

    throw error;
  }
}

export async function saveGroupSetting(
  sql: SQL,
  actorMemberId: string,
  input: unknown,
): Promise<GroupMutation> {
  if (!isRecord(input) || typeof input.groupId !== "string" || typeof input.key !== "string") {
    return { ok: false, code: "invalid_request" };
  }

  const definition = settingDefinition(input.key);

  if (definition === undefined) {
    return { ok: false, code: "invalid_group" };
  }

  const value = parseGroupSettingValue(definition, input.value);

  if (value === null) {
    return { ok: false, code: "invalid_group" };
  }

  return sql.begin(async (tx) => {
    const [group] = (await tx`
      SELECT id, key FROM core.groups WHERE id = ${input.groupId}
    `) as Array<{ id: string; key: string }>;

    if (group === undefined) {
      return { ok: false, code: "not_found" } as const;
    }

    await tx`
      INSERT INTO core.group_settings (group_id, key, value, updated_at)
      VALUES (${input.groupId}, ${input.key}, to_jsonb(${value}), now())
      ON CONFLICT (group_id, key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = now()
    `;
    await bumpPermVersion(tx);
    await writeAdminLog(tx, {
      actorMemberId,
      action: "group.settings.update",
      targetType: "group",
      targetId: group.id,
      summary: { group: group.key, key: input.key, value },
    });

    return { ok: true } as const;
  });
}

export async function listGroupSettings(sql: SQL): Promise<{
  readonly groups: ReadonlyArray<{
    id: string;
    key: string;
    title: string;
    settings: Readonly<Record<string, unknown>>;
  }>;
  readonly definitions: readonly GroupSettingDefinition[];
}> {
  const groups = (await sql`
    SELECT id, key, title FROM core.groups ORDER BY display_order, id
  `) as Array<{ id: string; key: string; title: string }>;
  const settings = (await sql`
    SELECT group_id, key, value FROM core.group_settings
  `) as Array<{ group_id: string; key: string; value: unknown }>;
  const byGroup = new Map<string, Record<string, unknown>>();

  for (const row of settings) {
    const values = byGroup.get(row.group_id) ?? {};
    values[row.key] = row.value;
    byGroup.set(row.group_id, values);
  }

  return {
    groups: groups.map((group) => ({
      ...group,
      settings: byGroup.get(group.id) ?? {},
    })),
    definitions: GROUP_SETTINGS,
  };
}

export interface MemberGroupView {
  readonly member: { readonly id: string; readonly displayName: string | null };
  readonly primaryGroupId: string | null;
  readonly groups: ReadonlyArray<{
    readonly id: string;
    readonly key: string;
    readonly title: string;
    readonly isPrimary: boolean;
  }>;
  readonly allGroups: ReadonlyArray<{ id: string; key: string; title: string }>;
}

export async function loadMemberGroupsForStaff(
  sql: SQL,
  memberId: string,
): Promise<MemberGroupView | null> {
  const [member] = (await sql`
    SELECT id, display_name FROM core.members WHERE id = ${memberId}
  `) as Array<{ id: string; display_name: string | null }>;

  if (member === undefined) {
    return null;
  }

  const groups = (await sql`
    SELECT g.id, g.key, g.title, mg.is_primary
    FROM core.member_groups mg
    JOIN core.groups g ON g.id = mg.group_id
    WHERE mg.member_id = ${memberId}
    ORDER BY mg.is_primary DESC, g.display_order, g.id
  `) as Array<{ id: string; key: string; title: string; is_primary: boolean }>;
  const allGroups = (await sql`
    SELECT id, key, title FROM core.groups ORDER BY display_order, id
  `) as Array<{ id: string; key: string; title: string }>;

  return {
    member: { id: member.id, displayName: member.display_name },
    primaryGroupId: groups.find((group) => group.is_primary)?.id ?? null,
    groups: groups.map((group) => ({
      id: group.id,
      key: group.key,
      title: group.title,
      isPrimary: group.is_primary,
    })),
    allGroups,
  };
}

export async function setMemberGroups(
  sql: SQL,
  actorMemberId: string,
  input: unknown,
): Promise<GroupMutation> {
  if (
    !isRecord(input) ||
    typeof input.memberId !== "string" ||
    typeof input.primaryGroupId !== "string" ||
    !Array.isArray(input.secondaryGroupIds)
  ) {
    return { ok: false, code: "invalid_request" };
  }

  const secondary = input.secondaryGroupIds.filter((id): id is string => typeof id === "string");
  const memberId = input.memberId;
  const primaryGroupId = input.primaryGroupId;

  if (
    secondary.length !== input.secondaryGroupIds.length ||
    new Set(secondary).size !== secondary.length ||
    secondary.includes(primaryGroupId)
  ) {
    return { ok: false, code: "invalid_request" };
  }

  return sql.begin(async (tx) => {
    const [member] = (await tx`
      SELECT id FROM core.members WHERE id = ${memberId} FOR UPDATE
    `) as Array<{ id: string }>;

    if (member === undefined) {
      return { ok: false, code: "not_found" } as const;
    }

    const groupIds = [primaryGroupId, ...secondary];
    const groups = (await tx`
      SELECT id, key
      FROM core.groups
      WHERE id = ANY(${`{${groupIds.join(",")}}`}::bigint[])
    `) as Array<{ id: string; key: string }>;

    if (groups.length !== groupIds.length) {
      return { ok: false, code: "invalid_group" } as const;
    }

    const before = (await tx`
      SELECT g.key, mg.is_primary
      FROM core.member_groups mg
      JOIN core.groups g ON g.id = mg.group_id
      WHERE mg.member_id = ${memberId}
      ORDER BY g.display_order, g.id
    `) as Array<{ key: string; is_primary: boolean }>;

    await tx`DELETE FROM core.member_groups WHERE member_id = ${memberId}`;
    await tx`
      INSERT INTO core.member_groups (member_id, group_id, is_primary)
      VALUES (${memberId}, ${primaryGroupId}, true)
    `;

    for (const group of secondary) {
      await tx`
        INSERT INTO core.member_groups (member_id, group_id, is_primary)
        VALUES (${memberId}, ${group}, false)
      `;
    }

    await bumpPermVersion(tx);
    await writeAdminLog(tx, {
      actorMemberId,
      action: "member.groups.update",
      targetType: "member",
      targetId: memberId,
      summary: {
        before: before.map((group) => group.key),
        after: groups.map((group) => group.key),
      },
    });

    return { ok: true } as const;
  });
}
